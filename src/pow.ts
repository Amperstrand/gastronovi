/**
 * ALTCHA PBKDF2 proof-of-work solver — the live GastroNova variant of the
 * npm `altcha` v3.0.6 pbkdf2 worker (`altcha-pbkdf2@3.0.6.worker.min.js`).
 *
 * Pure module: no network, no clock side effects beyond an injectable
 * `now`, and the hash implementation is injected so tests can run the
 * real scan against a cheap synthetic challenge.
 *
 * Algorithm (spec: platform-recon research/gastronova/PLATFORM.md,
 * "Client PoW module spec"):
 *
 *   password  = nonce_bytes || uint32_be(counter)     // 16 + 4 bytes
 *   derived   = PBKDF2-HMAC-SHA256(password, salt_bytes, cost, keyLength)
 *   solved    when hex(derived) starts with keyPrefix
 *
 * The server pre-picks a small counter whose derived key carries the
 * prefix, so a LINEAR scan from 0 finds it in seconds — the 16-hex-char
 * keyPrefix is not a brute-force target. The public ALTCHA spec's
 * `maxNumber` does not exist here; a scan bound is still applied as a
 * safety valve. The worker compares bytes when keyPrefix has even length
 * and hex strings when odd; a hex-string compare is equivalent for even
 * lengths and matches the worker exactly for odd ones.
 */
import { pbkdf2 } from "node:crypto";
import { promisify } from "node:util";

/** The live challenge shape (all values observed as in this exact field set). */
export interface AltchaParameters {
  readonly algorithm: string;
  readonly cost: number;
  readonly expiresAt: number;
  readonly keyLength: number;
  readonly nonce: string;
  readonly salt: string;
  readonly keyPrefix: string;
  readonly keySignature: string;
}

export interface AltchaChallenge {
  readonly parameters: AltchaParameters;
  readonly signature: string;
}

export interface AltchaSolution {
  readonly counter: number;
  readonly derivedKey: string;
  /** Wall-clock solve duration in ms (rounded), echoed as solution[time] / solveduration. */
  readonly timeMs: number;
}

/** Injectable KDF. Must not retain the password buffer beyond the call. */
export interface Pbkdf2Hasher {
  deriveBits(
    password: Uint8Array,
    salt: Uint8Array,
    iterations: number,
    keyLengthBytes: number,
  ): Promise<Uint8Array>;
}

export const DEFAULT_SCAN_BOUND = 1 << 22;

const pbkdf2Async = promisify(pbkdf2);

/** Node implementation: OpenSSL PBKDF2-HMAC-SHA256 (async, event-loop friendly). */
export function nodeHasher(): Pbkdf2Hasher {
  return {
    async deriveBits(password, salt, iterations, keyLengthBytes): Promise<Uint8Array> {
      return new Uint8Array(await pbkdf2Async(password, salt, iterations, keyLengthBytes, "sha256"));
    },
  };
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`altcha: hex string must be non-empty, even-length hex: ${hex}`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export interface SolveOptions {
  /** First counter to try. The worker starts at 0 and steps by 1. */
  readonly counterStart?: number;
  /** Exclusive upper counter bound (default 2^22 — far above the observed draws). */
  readonly scanBound?: number;
  readonly now?: () => number;
}

/**
 * Linear counter scan. Returns null when the bound is exhausted without a
 * prefix match (platform change signal — the server guarantees a hit for
 * its pre-picked counter while the challenge is live).
 */
export async function solveAltcha(
  challenge: AltchaChallenge,
  hasher: Pbkdf2Hasher,
  options: SolveOptions = {},
): Promise<AltchaSolution | null> {
  const { parameters } = challenge;
  if (parameters.algorithm !== "PBKDF2/SHA-256") {
    throw new Error(`altcha: unsupported algorithm ${parameters.algorithm}`);
  }
  const nonce = hexToBytes(parameters.nonce);
  const salt = hexToBytes(parameters.salt);
  const prefix = parameters.keyPrefix.toLowerCase();
  const startedAt = (options.now ?? Date.now)();
  const bound = options.scanBound ?? DEFAULT_SCAN_BOUND;

  const password = new Uint8Array(nonce.length + 4);
  password.set(nonce, 0);
  const view = new DataView(password.buffer, password.byteOffset, password.byteLength);
  for (let counter = options.counterStart ?? 0; counter < bound; counter += 1) {
    view.setUint32(nonce.length, counter, false); // uint32 big-endian
    const derived = await hasher.deriveBits(password, salt, parameters.cost, parameters.keyLength);
    if (bytesToHex(derived).startsWith(prefix)) {
      return {
        counter,
        derivedKey: bytesToHex(derived),
        timeMs: Math.max(1, Math.round((options.now ?? Date.now)() - startedAt)),
      };
    }
  }
  return null;
}
