import { GastronoviError } from "./error.js";
import { apiQuery, baseHeaders, fetchJson, GASTRONOVI_ORIGIN, hostCookie, type FetchJsonResult } from "./http.js";
import { menuFromPayload, type Menu, type RawMenusResponse } from "./menu.js";
import { nodeHasher, solveAltcha, type AltchaChallenge, type AltchaSolution, type Pbkdf2Hasher } from "./pow.js";
import { orderMode, unitId, type OrderMode, type Unit, type UnitId } from "./types.js";

/** Guest-token lifetime: measured valid at t+10 min, 401 at t+15 min — re-solve at 10. */
export const TOKEN_TTL_MS = 10 * 60 * 1000;
const CSRF_COOKIE = "__Host-csrf_token";
const CHALLENGE_LIVE_MARGIN_MS = 5_000;

interface GuestSession {
  readonly token: string;
  readonly cookie: string | null;
  readonly expiresAtMs: number;
}

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

interface RawInformationEnvelope {
  readonly success?: boolean;
  readonly CompanySettings?: {
    readonly usepickup?: string | number | null;
    readonly inhouseOrdering?: string | number | null;
    readonly minOrderValue?: string | number | null;
  };
}

interface RawCodeEnvelope {
  readonly success?: boolean;
  readonly redirect?: {
    readonly target?: string;
  };
}

export interface ClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  readonly hasher?: Pbkdf2Hasher;
  /** Guest-token window; default 10 min (live-measured 10–15 min). */
  readonly tokenTtlMs?: number;
  /** Backoff before the single 429 retry (the widget backs off 5–10 s). */
  readonly sleep?: (ms: number) => Promise<void>;
}

type CodeOrUnit = { readonly kind: "id"; readonly id: string } | { readonly kind: "code"; readonly code: string };

/**
 * Accepts a bare unit id ("7960"), a services.gastronovi.com URL
 * (`/restaurants/<id>/…` or `/code/<x>`), a path form of either, or a bare
 * capability code (`S…`/`T…`). Codes are unauthenticated capability
 * strings — treat ambiguous O/0, l/1 transcription as invalid input.
 */
export function parseCodeOrUnit(input: string): CodeOrUnit | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return { kind: "id", id: trimmed };
  let path = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    if (!url.hostname.endsWith("gastronovi.com")) return null;
    path = url.pathname;
  }
  const restaurant = path.match(/^\/restaurants\/(\d+)/);
  if (restaurant?.[1] !== undefined) return { kind: "id", id: restaurant[1] };
  const code = path.match(/^\/code\/([^/?#]+)/);
  if (code?.[1] !== undefined) return { kind: "code", code: decodeURIComponent(code[1]) };
  if (path === trimmed && /^[A-Za-z0-9]{4,64}$/.test(trimmed)) return { kind: "code", code: trimmed };
  return null;
}

function network(context: string, body: string): GastronoviError {
  return new GastronoviError("network", `${context}: ${body}`);
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read-only GastroNova client. A thrown GastronoviError (reason
 * "network") means the platform was unreachable; a null return always
 * means the platform answered and the thing is absent (invalid code,
 * deactivated unit behind the login wall). An EMPTY menu is data, not
 * absence: inhouse without a table code is mode-gated, not dead.
 */
export class GastronoviClient {
  private readonly sessions = new Map<UnitId, GuestSession>();

  constructor(private readonly options: ClientOptions = {}) {}

  /** Resolves a code/URL/id to a unit, then runs the cookieless health check. */
  async unit(codeOrUrl: string): Promise<Unit | null> {
    const id = await this.resolveInput(codeOrUrl);
    return id === null ? null : await this.healthOf(id);
  }

  /** Cookieless liveness + ordering-mode read — no PoW, no session. */
  async health(codeOrUnit: string): Promise<Unit | null> {
    return await this.unit(codeOrUnit);
  }

  /**
   * Reads the menu card set. Solves the ALTCHA PoW once per token window
   * (~10 min); re-solves exactly once when the token is refused mid-read
   * (401 / GuestSession envelope). Returns null when the platform answers
   * absent (dead unit login wall included); returns a gated EMPTY menu
   * when the unit is live but the mode serves no cards (inhouse without a
   * table code — mode gating, not death).
   */
  async menu(codeOrUnit: string | UnitId, mode: OrderMode = "pickup"): Promise<Menu | null> {
    const id = await this.resolveInput(codeOrUnit);
    if (id === null) return null;
    const payload = await this.orderingMenus(id, mode);
    if (payload === null || payload.success !== true || this.messageModel(payload) === "login") {
      return null;
    }
    return menuFromPayload(id, mode, payload, this.nowDate());
  }

  private nowDate(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private async resolveInput(codeOrUnit: string | UnitId): Promise<UnitId | null> {
    if (typeof codeOrUnit !== "string") return codeOrUnit;
    const parsed = parseCodeOrUnit(codeOrUnit);
    if (parsed === null) throw new Error(`cannot parse unit or code: ${codeOrUnit}`);
    return parsed.kind === "id" ? unitId(parsed.id) : await this.resolveCode(parsed.code);
  }

  /**
   * /code/<x>?format=json resolver. Unknown codes re-render the login
   * form (HTML, Zend-style) or answer success:false — both mean null.
   * Dead units still resolve (deactivation happens downstream of the
   * redirect), so resolution success says nothing about liveness.
   */
  private async resolveCode(code: string): Promise<UnitId | null> {
    const url = `${GASTRONOVI_ORIGIN}/code/${encodeURIComponent(code)}?format=json`;
    const result = await fetchJson<RawCodeEnvelope>(url, {
      headers: baseHeaders(null),
      signal: AbortSignal.timeout(20_000),
    }, this.options.fetchImpl);
    if (!result.ok) {
      if (result.kind === "network") throw network("code resolve failed", result.body);
      return null;
    }
    const target = result.value.redirect?.target;
    if (result.value.success !== true || target === undefined) return null;
    const id = target.match(/\/restaurants\/(\d+)/)?.[1];
    return id === undefined ? null : unitId(id);
  }

  private async healthOf(id: UnitId): Promise<Unit> {
    const result = await this.postJson<RawInformationEnvelope>(id, "/reservations/information", {});
    if (!result.ok) {
      if (result.kind === "network") throw network("health check failed", result.body);
      return { id, live: false, pickup: false, inhouse: false, minOrderValue: null };
    }
    const settings = result.value.CompanySettings;
    const flag = (value: string | number | null | undefined): boolean =>
      value !== undefined && value !== null && value !== "" && Number(value) === 1;
    const min = settings?.minOrderValue;
    return {
      id,
      live: result.value.success === true,
      pickup: flag(settings?.usepickup),
      inhouse: flag(settings?.inhouseOrdering),
      minOrderValue: min === undefined || min === null || min === "" ? null : Number(min),
    };
  }

  private async orderingMenus(id: UnitId, mode: OrderMode): Promise<RawMenusResponse | null> {
    let result = await this.menusWithSession(id, mode, await this.guestSession(id));
    if (this.refused(result)) {
      this.sessions.delete(id);
      result = await this.menusWithSession(id, mode, await this.guestSession(id));
      if (this.refused(result)) return null;
    }
    return result.ok ? result.value : null;
  }

  /** Token refusal signature: HTTP 401 or the GuestSession envelope model. */
  private refused(result: FetchJsonResult<RawMenusResponse>): boolean {
    return !result.ok
      ? result.kind === "http" && result.status === 401
      : this.messageModel(result.value) === "GuestSession";
  }

  private async menusWithSession(
    id: UnitId,
    mode: OrderMode,
    session: GuestSession,
  ): Promise<FetchJsonResult<RawMenusResponse>> {
    return await this.postJson<RawMenusResponse>(id, "/ordering/menus", {
      time: String(Math.floor(this.nowDate().getTime() / 1000)),
      type: mode,
      stripHtml: "1",
      completeDay: "1",
    }, {
      "x-csrf-token": session.token,
      ...(session.cookie === null ? {} : { cookie: session.cookie }),
    });
  }

  /** One-time PoW per token window: challenge → linear-scan solve → submit. */
  private async guestSession(id: UnitId): Promise<GuestSession> {
    const nowMs = (): number => this.nowDate().getTime();
    const cached = this.sessions.get(id);
    if (cached !== undefined && nowMs() < cached.expiresAtMs) return cached;

    let challenge = await this.liveChallenge(id);
    let solution: AltchaSolution | null = null;
    if (challenge !== null) {
      solution = await solveAltcha(challenge, this.options.hasher ?? nodeHasher(), { now: nowMs });
    }
    if (solution === null) {
      // Widget-grade retry: one fresh challenge before giving up.
      challenge = await this.liveChallenge(id);
      if (challenge !== null) {
        solution = await solveAltcha(challenge, this.options.hasher ?? nodeHasher(), { now: nowMs });
      }
    }
    if (challenge === null) throw new Error(`guest session: no live challenge for unit ${id}`);
    if (solution === null) throw new Error(`guest session: proof-of-work unsolved for unit ${id}`);

    const token = await this.submitSolution(id, challenge, solution);
    const session: GuestSession = {
      token: token.token,
      cookie: `${CSRF_COOKIE}=${token.cookieValue ?? token.token}`,
      expiresAtMs: nowMs() + (this.options.tokenTtlMs ?? TOKEN_TTL_MS),
    };
    this.sessions.set(id, session);
    return session;
  }

  /**
   * Fetches a challenge that is still solvable: the 600 s expiry is
   * checked on arrival, and a stale one triggers one refetch.
   */
  private async liveChallenge(id: UnitId): Promise<AltchaChallenge | null> {
    const first = await this.fetchChallenge(id);
    if (first === null) return null;
    if (first.parameters.expiresAt * 1000 > this.nowDate().getTime() + CHALLENGE_LIVE_MARGIN_MS) {
      return first;
    }
    const second = await this.fetchChallenge(id);
    return second !== null && second.parameters.expiresAt * 1000 > this.nowDate().getTime() + CHALLENGE_LIVE_MARGIN_MS
      ? second
      : null;
  }

  private async fetchChallenge(id: UnitId): Promise<AltchaChallenge | null> {
    const result = await this.postJsonRetry429<RawChallengeEnvelope>(id, "/guestsession/challenge", {});
    if (!result.ok) {
      if (result.kind === "network") throw network("challenge fetch failed", result.body);
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
  ): Promise<{ readonly token: string; readonly cookieValue: string | null }> {
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
      if (result.kind === "network") throw network("challenge submit failed", result.body);
      throw new Error(`guest session: submit refused for unit ${id} (${result.status})`);
    }
    if (result.value.success !== true) throw new Error(`guest session: submit rejected for unit ${id}`);
    const raw = result.value.token;
    const token = typeof raw === "string" ? raw : raw?.value;
    if (token === undefined || token === "") throw new Error(`guest session: no token for unit ${id}`);
    return { token, cookieValue: hostCookie(result.cookie, CSRF_COOKIE) };
  }

  private messageModel(payload: RawMenusResponse): string | null {
    for (const message of payload.messages ?? []) {
      if (message.model !== undefined) return message.model;
    }
    return null;
  }

  private async postJson<T>(
    id: UnitId,
    path: string,
    params: URLSearchParams | Readonly<Record<string, string>>,
    headers: Record<string, string> = {},
    query: Readonly<Record<string, string>> = {},
  ): Promise<ReturnType<typeof fetchJson<T>>> {
    const url = `${GASTRONOVI_ORIGIN}${path}?${apiQuery(id, query)}`;
    const body = params instanceof URLSearchParams ? params.toString() : new URLSearchParams(params).toString();
    return await fetchJson<T>(url, {
      method: "POST",
      headers: {
        ...baseHeaders(null),
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        ...headers,
      },
      body,
      signal: AbortSignal.timeout(90_000),
    }, this.options.fetchImpl);
  }

  /** The widget backs off 5–10 s on 429; one retry keeps reads polite. */
  private async postJsonRetry429<T>(
    id: UnitId,
    path: string,
    params: URLSearchParams | Readonly<Record<string, string>>,
    query: Readonly<Record<string, string>> = {},
  ): Promise<ReturnType<typeof fetchJson<T>>> {
    const result = await this.postJson<T>(id, path, params, {}, query);
    if (!result.ok && result.kind === "http" && result.status === 429) {
      await (this.options.sleep ?? sleepDefault)(5_000);
      return await this.postJson<T>(id, path, params, {}, query);
    }
    return result;
  }
}
