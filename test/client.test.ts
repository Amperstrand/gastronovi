import { describe, expect, it } from "vitest";
import { GastronoviClient, GastronoviError, parseCodeOrUnit } from "../src/index.js";
import { unitId } from "../src/types.js";
import {
  BOUND_TABLE_CODE,
  DEAD_CODE,
  DEAD_UNIT,
  fakeGastronovi,
  LIVE_BAR_UNIT,
  LIVE_KIOSK_CODE,
  LIVE_KIOSK_UNIT,
} from "./gastronovi-fake.js";
import { sent } from "./transport-fake.js";

const CLOCK_START = 1_759_000_000_000;

function clock(start = CLOCK_START): { ms: number } {
  return { ms: start };
}

function client(
  fetchImpl: typeof fetch,
  time: { ms: number },
  extra: { tokenTtlMs?: number; sleep?: (ms: number) => Promise<void>; scanBound?: number } = {},
): GastronoviClient {
  return new GastronoviClient({
    fetchImpl,
    now: () => new Date(time.ms),
    ...(extra.tokenTtlMs === undefined ? {} : { tokenTtlMs: extra.tokenTtlMs }),
    ...(extra.sleep === undefined ? {} : { sleep: extra.sleep }),
    ...(extra.scanBound === undefined ? {} : { scanBound: extra.scanBound }),
  });
}

function fake(time: { ms: number }, overrides: Parameters<typeof fakeGastronovi>[0] = {}): ReturnType<typeof fakeGastronovi> {
  return fakeGastronovi({ now: () => time.ms, ...overrides });
}

describe("parseCodeOrUnit", () => {
  it("accepts ids, gastronovi URLs, paths and bare codes", () => {
    expect(parseCodeOrUnit("7960")).toEqual({ kind: "id", id: "7960" });
    expect(parseCodeOrUnit("https://services.gastronovi.com/restaurants/7960/reservierung/widget?c=T1")).toEqual({ kind: "id", id: "7960" });
    expect(parseCodeOrUnit("/restaurants/96153/x")).toEqual({ kind: "id", id: "96153" });
    expect(parseCodeOrUnit("https://services.gastronovi.com/code/abc123")).toEqual({ kind: "code", code: "abc123" });
    expect(parseCodeOrUnit("/code/xyz789")).toEqual({ kind: "code", code: "xyz789" });
    expect(parseCodeOrUnit("s7o0517x")).toEqual({ kind: "code", code: "s7o0517x" });
    expect(parseCodeOrUnit("https://example.test/whatever")).toBeNull();
    expect(parseCodeOrUnit("nope!")).toBeNull();
  });
});

describe("unit", () => {
  it("resolves a code via /code/<x>?format=json with the XHR header", async () => {
    const time = clock();
    const transport = fake(time);
    const unit = await client(transport.fetchImpl, time).unit(LIVE_KIOSK_CODE);
    expect(unit?.id).toBe(LIVE_KIOSK_UNIT);
    const codeRequest = transport.requests.find((request) => request.url.includes("/code/"));
    expect(codeRequest?.headers["x-requested-with"]).toBe("XMLHttpRequest");
    expect(codeRequest?.url).toContain("format=json");
  });

  it("resolves URLs and raw ids without touching /code", async () => {
    const time = clock();
    const transport = fake(time);
    const unit = await client(transport.fetchImpl, time).unit(
      `https://services.gastronovi.com/restaurants/${LIVE_BAR_UNIT}/reservation/widget`,
    );
    expect(unit?.id).toBe(LIVE_BAR_UNIT);
    expect(transport.requests.some((request) => request.url.includes("/code/"))).toBe(false);
  });

  it("returns null for an invalid code (login-form HTML re-render)", async () => {
    const time = clock();
    const transport = fake(time);
    expect(await client(transport.fetchImpl, time).unit("o0l1ambiguous")).toBeNull();
  });

  it("health is cookieless and PoW-free: reads reservations/information only", async () => {
    const time = clock();
    const transport = fake(time);
    const unit = await client(transport.fetchImpl, time).health(LIVE_KIOSK_CODE);
    expect(unit).toMatchObject({ id: LIVE_KIOSK_UNIT, live: true, pickup: true, inhouse: true, minOrderValue: 25 });
    const info = sent(transport.requests, "/reservations/information");
    expect(info?.headers["x-csrf-token"]).toBeUndefined();
    expect(info?.headers["cookie"]).toBeUndefined();
    // Challenge success is not liveness — the health recipe needs no PoW.
    expect(transport.requests.some((request) => request.url.includes("/guestsession/"))).toBe(false);
  });

  it("resolves a dead unit's code (deactivation lives downstream of the redirect)", async () => {
    const time = clock();
    const transport = fake(time);
    const unit = await client(transport.fetchImpl, time).unit(DEAD_CODE);
    expect(unit).toMatchObject({ id: DEAD_UNIT, live: false });
  });

  it("throws a typed network error when the transport dies", async () => {
    const dead: typeof fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(client(dead, clock()).unit(LIVE_KIOSK_CODE)).rejects.toMatchObject({
      name: "GastronoviError",
      reason: "network",
    });
    await expect(client(dead, clock()).health(LIVE_KIOSK_CODE)).rejects.toBeInstanceOf(GastronoviError);
  });
});

describe("menu", () => {
  it("runs the full PoW chain and reads the card set with token + cookie", async () => {
    const time = clock();
    const transport = fake(time);
    const menu = await client(transport.fetchImpl, time).menu(LIVE_KIOSK_CODE, "pickup");
    expect(menu?.categories.map((category) => category.name)).toEqual(["Fass", "Flaschen", "Snacks"]);
    const submit = sent(transport.requests, "/guestsession/submitchallenge");
    expect(submit).toBeDefined();
    if (typeof submit?.body !== "string") {
      expect.unreachable("submit body must be a urlencoded string");
      return;
    }
    const form = new URLSearchParams(submit.body);
    // jQuery-nested submit params, full parameter echo.
    expect(form.get("challenge[parameters][algorithm]")).toBe("PBKDF2/SHA-256");
    expect(form.get("challenge[parameters][cost]")).toBe("2");
    expect(form.get("challenge[parameters][keyPrefix]") ?? "").toMatch(/^[0-9a-f]{32}$/);
    expect(form.get("challenge[signature]") ?? "").toMatch(/^[0-9a-f]{64}$/);
    expect(form.get("solution[counter]")).toBe("7");
    expect(form.get("solution[derivedKey]") ?? "").toMatch(/^[0-9a-f]{64}$/);
    expect(Number(form.get("solution[time]"))).toBeGreaterThan(0);
    expect(submit.url).toMatch(/solveduration=\d+/);
    const menus = sent(transport.requests, "/ordering/menus");
    expect(menus?.headers["x-csrf-token"]).toBe("synthetic-guest-token-1");
    expect(menus?.headers["cookie"]).toContain("__Host-csrf_token=synthetic-guest-token-1");
    if (typeof menus?.body === "string") {
      const body = new URLSearchParams(menus.body);
      expect(body.get("type")).toBe("pickup");
      expect(body.get("stripHtml")).toBe("1");
      expect(body.get("completeDay")).toBe("1");
      expect(Number(body.get("time"))).toBeGreaterThan(0);
    }
  });

  it("parses mixed price precision and the three id spaces off the wire", async () => {
    const time = clock();
    const transport = fake(time);
    const menu = await client(transport.fetchImpl, time).menu(LIVE_KIOSK_CODE, "pickup");
    const fass = menu?.categories[0]?.items ?? [];
    const glass = fass.find((item) => item.amountDescription === "0,4");
    const bottle = fass.find((item) => item.amountDescription === "1,0");
    expect(glass).toMatchObject({ title: "Synthetic Pils", price: 6.9, priceRaw: "6.9000000000" });
    expect(bottle).toMatchObject({ title: "Synthetic Pils", price: 29.5, priceRaw: "29.50" });
    expect(glass?.id).not.toBe(bottle?.id);
    expect(glass?.uid).not.toBe(bottle?.uid);
    expect(glass?.contentId).not.toBe(bottle?.contentId);
  });

  it("marks recipes locked via RecipeStock and releases past locks", async () => {
    const time = clock();
    const transport = fake(time);
    const menu = await client(transport.fetchImpl, time).menu(LIVE_KIOSK_CODE, "pickup");
    const items = menu?.categories.flatMap((category) => category.items) ?? [];
    const locked = items.find((item) => item.title === "Synthetic Pils" && item.amountDescription === "1,0");
    const released = items.find((item) => item.title === "Synthetic Bottle");
    expect(locked?.available).toBe(false);
    expect(locked?.lockedUntil).toBeGreaterThan(time.ms / 1000);
    expect(released?.available).toBe(true);
  });

  it("solves the PoW once per token window across reads", async () => {
    const time = clock();
    const transport = fake(time);
    const c = client(transport.fetchImpl, time);
    await c.menu(LIVE_KIOSK_CODE, "pickup");
    time.ms += 60_000;
    await c.menu(LIVE_KIOSK_CODE, "pickup");
    expect(transport.requests.filter((request) => request.url.includes("/guestsession/challenge"))).toHaveLength(1);
  });

  it("re-solves when the token window has passed (10–15 min lifetime)", async () => {
    const time = clock();
    const transport = fake(time);
    const c = client(transport.fetchImpl, time);
    await c.menu(LIVE_KIOSK_CODE, "pickup");
    time.ms += 11 * 60 * 1000;
    await c.menu(LIVE_KIOSK_CODE, "pickup");
    expect(transport.requests.filter((request) => request.url.includes("/guestsession/challenge"))).toHaveLength(2);
  });

  it("rescues a mid-read 401 with exactly one fresh PoW", async () => {
    const time = clock();
    const transport = fake(time, { killTokensAfterFirstMenus: true });
    const c = client(transport.fetchImpl, time);
    const first = await c.menu(LIVE_KIOSK_CODE, "pickup");
    expect(first?.categories.length).toBeGreaterThan(0);
    const second = await c.menu(LIVE_KIOSK_CODE, "pickup");
    expect(second?.categories.length).toBeGreaterThan(0);
    expect(transport.requests.filter((request) => request.url.includes("/guestsession/challenge"))).toHaveLength(2);
    expect(transport.requests.filter((request) => request.url.includes("/ordering/menus"))).toHaveLength(3);
  });

  it("serves inhouse as a gated EMPTY menu — mode gating, not a dead unit", async () => {
    const time = clock();
    const transport = fake(time);
    const menu = await client(transport.fetchImpl, time).menu(LIVE_KIOSK_CODE, "inhouse");
    expect(menu).not.toBeNull();
    expect(menu?.gated).toBe(true);
    expect(menu?.categories).toEqual([]);
    expect(menu?.stockRows).toBeGreaterThan(0);
  });

  it("reads pickup ≡ inhouse where the unit does not split cards", async () => {
    const time = clock();
    const transport = fake(time);
    const c = client(transport.fetchImpl, time);
    const pickup = await c.menu(LIVE_BAR_UNIT, "pickup");
    time.ms += 1_000;
    const inhouse = await c.menu(LIVE_BAR_UNIT, "inhouse");
    expect(pickup?.categories.map((category) => category.name)).toEqual(["Synthetic Bar", "Mehr"]);
    expect(inhouse?.categories).toEqual(pickup?.categories);
    expect(inhouse?.gated).toBe(false);
  });

  it("returns null for a dead unit even though the PoW succeeded", async () => {
    const time = clock();
    const transport = fake(time);
    const menu = await client(transport.fetchImpl, time).menu(DEAD_CODE, "pickup");
    expect(menu).toBeNull();
    // The quirk, made explicit: challenge AND submit succeeded first.
    expect(transport.requests.some((request) => request.url.includes("/guestsession/submitchallenge"))).toBe(true);
  });

  it("accepts the token in both wire shapes: plain string and {value}", async () => {
    const time = clock();
    const transport = fake(time, { tokenShape: "object" });
    const menu = await client(transport.fetchImpl, time).menu(LIVE_KIOSK_CODE, "pickup");
    expect(menu?.categories.length).toBeGreaterThan(0);
    expect(sent(transport.requests, "/ordering/menus")?.headers["x-csrf-token"]).toBe("synthetic-guest-token-1");
  });

  it("retries a 429 challenge once after a backoff", async () => {
    const time = clock();
    const transport = fake(time, { challenge429: 1 });
    const sleeps: number[] = [];
    const menu = await client(transport.fetchImpl, time, { sleep: async (ms) => { sleeps.push(ms); } })
      .menu(LIVE_KIOSK_CODE, "pickup");
    expect(menu?.categories.length).toBeGreaterThan(0);
    expect(transport.requests.filter((request) => request.url.includes("/guestsession/challenge"))).toHaveLength(2);
    expect(sleeps).toEqual([5_000]);
  });

  it("refetches a challenge that arrives already expired", async () => {
    const time = clock();
    const transport = fake(time, { staleChallengeOnce: true });
    const menu = await client(transport.fetchImpl, time).menu(LIVE_KIOSK_CODE, "pickup");
    expect(menu?.categories.length).toBeGreaterThan(0);
    expect(transport.requests.filter((request) => request.url.includes("/guestsession/challenge"))).toHaveLength(2);
    // Only the live challenge was submitted.
    expect(transport.requests.filter((request) => request.url.includes("/guestsession/submitchallenge"))).toHaveLength(1);
  });

  it("takes a UnitId directly (no re-resolution)", async () => {
    const time = clock();
    const transport = fake(time);
    const menu = await client(transport.fetchImpl, time).menu(unitId(LIVE_BAR_UNIT), "pickup");
    expect(menu?.unit).toBe(LIVE_BAR_UNIT);
    expect(transport.requests.some((request) => request.url.includes("/code/"))).toBe(false);
  });

  it("binds a table code: costunit-selected cards replace the no-code set", async () => {
    const time = clock();
    const transport = fake(time);
    const menu = await client(transport.fetchImpl, time).menu(LIVE_KIOSK_CODE, "inhouse", { tableCode: BOUND_TABLE_CODE });
    const menus = sent(transport.requests, "/ordering/menus");
    if (typeof menus?.body === "string") {
      expect(new URLSearchParams(menus.body).get("tableCode")).toBe(BOUND_TABLE_CODE);
    } else {
      expect.unreachable("menus body must be a urlencoded string");
    }
    expect(menu?.tableIdValid).toBe(true);
    expect(menu?.categories.map((category) => category.name)).toEqual(["Tischkarte"]);
    const bound = menu?.categories.flatMap((category) => category.items) ?? [];
    expect(bound.map((item) => item.title)).toContain("Synthetic Kommunikation");
    // The no-code default (kiosk cards) is replaced entirely.
    expect(menu?.categories.some((category) => category.name === "Fass")).toBe(false);
  });

  it("reports an invalid table binding as data (tableIdValid false), not absence", async () => {
    const time = clock();
    const transport = fake(time);
    const menu = await client(transport.fetchImpl, time).menu(LIVE_KIOSK_CODE, "pickup", { tableCode: "TWRONGCODE0" });
    expect(menu).not.toBeNull();
    expect(menu?.tableIdValid).toBe(false);
    // The platform still serves the no-code fallback card set.
    expect(menu?.categories.map((category) => category.name)).toEqual(["Fass", "Flaschen", "Snacks"]);
  });

  it("leaves tableIdValid null when no table code is sent (tri-state wire field)", async () => {
    const time = clock();
    const transport = fake(time);
    const menu = await client(transport.fetchImpl, time).menu(LIVE_KIOSK_CODE, "pickup");
    expect(menu?.tableIdValid).toBeNull();
  });

  it("throws a typed network error when the transport dies mid-chain", async () => {
    const dead: typeof fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(client(dead, clock()).menu(LIVE_KIOSK_CODE, "pickup")).rejects.toMatchObject({
      name: "GastronoviError",
      reason: "network",
    });
  });

  it("throws a typed pow error when no counter within the scan bound solves", async () => {
    const time = clock();
    const transport = fake(time, { unsolvableChallenge: true });
    await expect(
      client(transport.fetchImpl, time, { scanBound: 50 }).menu(LIVE_KIOSK_CODE, "pickup"),
    ).rejects.toMatchObject({ name: "GastronoviError", reason: "pow" });
  });

  it("retries once with a fresh challenge when the submit is refused, then throws typed pow", async () => {
    const time = clock();
    const transport = fake(time, { rejectSubmitOnce: true });
    const menu = await client(transport.fetchImpl, time).menu(LIVE_KIOSK_CODE, "pickup");
    expect(menu?.categories.length).toBeGreaterThan(0);
    expect(transport.requests.filter((request) => request.url.includes("/guestsession/submitchallenge"))).toHaveLength(2);

    const always = fake(time, { rejectSubmitOnce: Number.MAX_SAFE_INTEGER });
    await expect(client(always.fetchImpl, time).menu(LIVE_KIOSK_CODE, "pickup")).rejects.toMatchObject({
      name: "GastronoviError",
      reason: "pow",
    });
  });
});
