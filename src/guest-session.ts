import { GastronoviError } from "./error.js";
import { hostCookie, postForm } from "./http.js";
import { nodeHasher, solveAltcha, type AltchaChallenge, type AltchaSolution, type Pbkdf2Hasher } from "./pow.js";
import type { UnitId } from "./types.js";

/** Guest-token lifetime: measured valid at t+10 min, 401 at t+15 min — re-solve at 10. */
export const TOKEN_TTL_MS = 10 * 60 * 1000;
const CSRF_COOKIE = "__Host-csrf_token";
const CHALLENGE_LIVE_MARGIN_MS = 5_000;
const RETRY_BACKOFF_MS = 5_000;

interface RawToken {
  readonly value?: string;
}

interface RawChallengeEnvelope {
  readonly success?: boolean;
  readonly challenge?: AltchaChallenge;
}

interface RawSubmitEnvelope {
  readonly success?: boolean;
  readonly token?: string | RawToken;
}

export interface GuestSession {
  readonly token: string;
  readonly cookie: string;
  readonly expiresAtMs: number;
}

export interface GuestSessionPorts {
  readonly fetchImpl?: typeof fetch;
  readonly now: () => Date;
  readonly hasher?: Pbkdf2Hasher;
  readonly tokenTtlMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly scanBound?: number;
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Owns the ALTCHA PBKDF2 guest session: challenge → linear-scan solve →
 * jQuery-nested submit → token + __Host-csrf_token cookie, cached for one
 * token window per unit. Failures throw GastronoviError reason "pow"
 * (protocol drift / exhausted budget) or "network" (transport death).
 */
export class GuestSessionManager {
  private readonly sessions = new Map<UnitId, GuestSession>();

  constructor(private readonly ports: GuestSessionPorts) {}

  async acquire(id: UnitId): Promise<GuestSession> {
    const nowMs = (): number => this.ports.now().getTime();
    const cached = this.sessions.get(id);
    if (cached !== undefined && nowMs() < cached.expiresAtMs) return cached;

    let stage = "no live challenge";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const challenge = await this.liveChallenge(id);
      if (challenge === null) continue;
      const solution = await solveAltcha(challenge, this.ports.hasher ?? nodeHasher(), {
        now: nowMs,
        ...(this.ports.scanBound === undefined ? {} : { scanBound: this.ports.scanBound }),
      });
      if (solution === null) {
        stage = "proof-of-work unsolved within the scan bound";
        continue;
      }
      const submitted = await this.submitSolution(id, challenge, solution);
      if (submitted === null) {
        stage = "challenge submit refused";
        continue;
      }
      const session: GuestSession = {
        token: submitted.token,
        cookie: `${CSRF_COOKIE}=${submitted.cookieValue ?? submitted.token}`,
        expiresAtMs: nowMs() + (this.ports.tokenTtlMs ?? TOKEN_TTL_MS),
      };
      this.sessions.set(id, session);
      return session;
    }
    throw new GastronoviError("pow", `guest session for unit ${id}: ${stage}`);
  }

  invalidate(id: UnitId): void {
    this.sessions.delete(id);
  }

  /**
   * Fetches a challenge that is still solvable: the 600 s expiry is
   * checked on arrival, and a stale one triggers one refetch.
   */
  private async liveChallenge(id: UnitId): Promise<AltchaChallenge | null> {
    const first = await this.fetchChallenge(id);
    if (first === null) return null;
    if (first.parameters.expiresAt * 1000 > this.ports.now().getTime() + CHALLENGE_LIVE_MARGIN_MS) {
      return first;
    }
    const second = await this.fetchChallenge(id);
    return second !== null && second.parameters.expiresAt * 1000 > this.ports.now().getTime() + CHALLENGE_LIVE_MARGIN_MS
      ? second
      : null;
  }

  private async fetchChallenge(id: UnitId): Promise<AltchaChallenge | null> {
    const result = await this.postJsonRetry429<RawChallengeEnvelope>(id, "/guestsession/challenge", {});
    if (!result.ok) {
      if (result.kind === "network") throw new GastronoviError("network", `challenge fetch failed: ${result.body}`);
      return null;
    }
    const challenge = result.value.challenge;
    if (result.value.success !== true || challenge?.parameters === undefined) return null;
    return challenge;
  }

  private async submitSolution(
    id: UnitId,
    challenge: AltchaChallenge,
    solution: AltchaSolution,
  ): Promise<{ readonly token: string; readonly cookieValue: string | null } | null> {
    const body = new URLSearchParams();
    const p = challenge.parameters;
    const fields: readonly (keyof typeof p)[] = [
      "algorithm", "cost", "expiresAt", "keyLength", "keyPrefix", "keySignature", "nonce", "salt",
    ];
    for (const field of fields) {
      body.set(`challenge[parameters][${field}]`, String(p[field]));
    }
    body.set("challenge[signature]", challenge.signature);
    body.set("solution[counter]", String(solution.counter));
    body.set("solution[derivedKey]", solution.derivedKey);
    body.set("solution[time]", String(solution.timeMs));

    const result = await this.postJsonRetry429<RawSubmitEnvelope>(
      id,
      "/guestsession/submitchallenge",
      body,
      { solveduration: String(solution.timeMs) },
    );
    if (!result.ok) {
      if (result.kind === "network") throw new GastronoviError("network", `challenge submit failed: ${result.body}`);
      return null;
    }
    if (result.value.success !== true) return null;
    const raw = result.value.token;
    const token = typeof raw === "string" ? raw : raw?.value;
    if (token === undefined || token === "") return null;
    return { token, cookieValue: hostCookie(result.cookie, CSRF_COOKIE) };
  }

  /** The widget backs off 5–10 s on 429; one retry keeps reads polite. */
  private async postJsonRetry429<T>(
    id: UnitId,
    path: string,
    params: URLSearchParams | Readonly<Record<string, string>>,
    query: Readonly<Record<string, string>> = {},
  ): Promise<ReturnType<typeof postForm<T>>> {
    const request = { unit: id, path, params, query };
    const result = await postForm<T>(request, this.ports.fetchImpl);
    if (!result.ok && result.kind === "http" && result.status === 429) {
      await (this.ports.sleep ?? sleepDefault)(RETRY_BACKOFF_MS);
      return await postForm<T>(request, this.ports.fetchImpl);
    }
    return result;
  }
}
