import { pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes, nodeHasher, solveAltcha, type AltchaChallenge } from "../src/pow.js";

function challengeFor(counter: number, cost = 1, prefixLength = 64): AltchaChallenge {
  const nonce = hexToBytes("00112233445566778899aabbccddeeff");
  const salt = hexToBytes("0102030405060708090a0b0c0d0e0f10");
  const password = new Uint8Array([...nonce, ...uint32be(counter)]);
  const derived = pbkdf2Sync(password, salt, cost, 32, "sha256");
  const derivedHex = bytesToHex(new Uint8Array(derived));
  return {
    parameters: {
      algorithm: "PBKDF2/SHA-256",
      cost,
      expiresAt: 4_102_444_800,
      keyLength: 32,
      nonce: bytesToHex(nonce),
      salt: bytesToHex(salt),
      keyPrefix: derivedHex.slice(0, prefixLength),
      keySignature: "00".repeat(32),
    },
    signature: "ff".repeat(32),
  };
}

function uint32be(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

describe("solveAltcha", () => {
  it("derives PBKDF2-HMAC-SHA256 over nonce||uint32BE(counter) and matches the prefix", async () => {
    const challenge = challengeFor(3);
    const passwords: Uint8Array[] = [];
    const hasher = {
      async deriveBits(password: Uint8Array, salt: Uint8Array, iterations: number, keyLengthBytes: number) {
        passwords.push(new Uint8Array(password));
        return new Uint8Array(pbkdf2Sync(password, salt, iterations, keyLengthBytes, "sha256"));
      },
    };
    const solution = await solveAltcha(challenge, hasher, { now: () => 0 });
    expect(solution?.counter).toBe(3);
    const nonce = hexToBytes(challenge.parameters.nonce);
    // 16-byte nonce + 4-byte big-endian counter = the exact password shape.
    expect(passwords[3]).toEqual(new Uint8Array([...nonce, 0x00, 0x00, 0x00, 0x03]));
    const expected = bytesToHex(new Uint8Array(
      pbkdf2Sync(new Uint8Array([...nonce, ...uint32be(3)]), hexToBytes(challenge.parameters.salt), 1, 32, "sha256"),
    ));
    expect(solution?.derivedKey).toBe(expected);
  });

  it("scans linearly from 0 and finds the server-pre-picked small counter", async () => {
    const challenge = challengeFor(7);
    const solution = await solveAltcha(challenge, nodeHasher());
    expect(solution?.counter).toBe(7);
  });

  it("matches an odd-length keyPrefix by hex compare (worker parity)", async () => {
    const challenge = challengeFor(5, 1, 5);
    expect(challenge.parameters.keyPrefix.length % 2).toBe(1);
    const solution = await solveAltcha(challenge, nodeHasher());
    expect(solution?.counter).toBe(5);
    expect(solution?.derivedKey.startsWith(challenge.parameters.keyPrefix)).toBe(true);
  });

  it("returns null when the scan bound is exhausted without a match", async () => {
    const challenge = challengeFor(50);
    const solution = await solveAltcha(challenge, nodeHasher(), { counterStart: 10, scanBound: 11 });
    expect(solution).toBeNull();
  });

  it("rejects foreign algorithms instead of guessing", async () => {
    const challenge = challengeFor(1);
    const foreign = {
      ...challenge,
      parameters: { ...challenge.parameters, algorithm: "PBKDF2/SHA-512" },
    };
    await expect(solveAltcha(foreign, nodeHasher())).rejects.toThrow(/algorithm/);
  });

  it("reports a positive solve duration via the injected clock", async () => {
    const challenge = challengeFor(2);
    let tick = 0;
    const solution = await solveAltcha(challenge, nodeHasher(), { now: () => (tick += 3) });
    expect(solution?.timeMs).toBeGreaterThan(0);
  });
});

describe("hex helpers", () => {
  it("round-trips bytes through hex", () => {
    expect(bytesToHex(hexToBytes("00ff10"))).toBe("00ff10");
    expect(hexToBytes("0a0b").length).toBe(2);
  });

  it("rejects odd-length and non-hex strings (worker throws on those too)", () => {
    expect(() => hexToBytes("abc")).toThrow(/hex/);
    expect(() => hexToBytes("zz")).toThrow(/hex/);
    expect(() => hexToBytes("")).toThrow(/hex/);
  });
});
