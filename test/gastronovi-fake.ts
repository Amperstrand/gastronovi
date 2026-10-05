/**
 * SYNTHETIC GastroNova transport. Every unit id, code, nonce, token and
 * price below is invented — nothing is a captured payload. The fixture
 * mirrors the SHAPE documented in the platform notes (services.
 * gastronovi.com guest surface) so the tests exercise the documented
 * quirks as behavior:
 *
 *  - ALTCHA PBKDF2 challenge shape with a server-pre-picked SMALL counter
 *    (linear scan target). The synthetic cost is 2, not the live 5000, so
 *    the REAL solver runs in milliseconds.
 *  - Submit takes jQuery-nested form params; the fake re-derives the key
 *    from the POSTED parameters and verifies the solution like the server.
 *  - Tokens live in a registry: /ordering/menus demands X-CSRF-Token +
 *    __Host-csrf_token cookie, else 401 {"model":"GuestSession"}.
 *  - Mode gating: unit 4242 inhouse → valid-but-EMPTY card set while the
 *    stock map still carries rows (data exists; the card set is gated).
 *  - Unit 4243: pickup ≡ inhouse (byte-identical card modulo envelope time).
 *  - Unit 2424 is DEACTIVATED: challenge + submit still succeed (challenge
 *    success is not liveness), then ordering/reservations login-wall.
 *  - /code/<x>?format=json resolves known synthetic codes (upper-cased)
 *    to /restaurants/<id>/... redirects; unknown codes re-render the login
 *    form as HTML (Zend-style), which parses as a non-JSON failure.
 *  - Prices mix 10-decimal and 2-decimal strings in one response; Recipe
 *    is a map keyed by uid (≠ id; MenusectionContent.id is a third space);
 *    same title ≠ same product; explicit recipe_count 0 sections are
 *    client-filtered; RecipeStock rows are timestamps, not booleans, and
 *    cover recipes the card never shows.
 *
 * Codes are unauthenticated capability strings; treat ambiguous O/0, l/1
 * transcription as invalid (homoglyph fragility — an ops rule, encoded
 * here by NOT fuzzing codes server-side).
 */
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { bodyOf, headerRecord, jsonResponse, type RecordedRequest } from "./transport-fake.js";

export const ORIGIN = "https://services.gastronovi.com";
export const LIVE_KIOSK_UNIT = "4242";
export const LIVE_BAR_UNIT = "4243";
export const DEAD_UNIT = "2424";
export const LIVE_KIOSK_CODE = "synthk1";
export const LIVE_BAR_CODE = "synthb1";
export const DEAD_CODE = "deadsy1";
export const BOUND_TABLE_CODE = "TSYNTHTABLE1";

const CSRF_COOKIE = "__Host-csrf_token";

const CODE_TARGETS: Readonly<Record<string, string>> = {
  [LIVE_KIOSK_CODE.toUpperCase()]: LIVE_KIOSK_UNIT,
  [LIVE_BAR_CODE.toUpperCase()]: LIVE_BAR_UNIT,
  [DEAD_CODE.toUpperCase()]: DEAD_UNIT,
};

export interface FakeGastronoviOptions {
  /** Fake clock in ms epoch; drives challenge expiry and token registry. */
  readonly now?: () => number;
  /** PBKDF2 cost for synthetic challenges (live platform: 5000). */
  readonly cost?: number;
  /** The server-pre-picked counter the challenge is generated for. */
  readonly counter?: number;
  /** Server-side token lifetime (live platform: 10–15 min). */
  readonly tokenTtlMs?: number;
  readonly tokenShape?: "string" | "object";
  /** First N challenge requests answer 429 (retry budget quirk). */
  readonly challenge429?: number;
  /** First challenge arrives already expired (600 s window quirk). */
  readonly staleChallengeOnce?: boolean;
  /** Drop every token after the first authorized menus call (401 rescue). */
  readonly killTokensAfterFirstMenus?: boolean;
  /** Serve a challenge whose keyPrefix no small counter satisfies (pow-error lane). */
  readonly unsolvableChallenge?: boolean;
  /** First N submits are refused (submit-retry lane). */
  readonly rejectSubmitOnce?: number;
}

interface SyntheticChallenge {
  readonly parameters: Readonly<Record<string, string | number>>;
  readonly signature: string;
  readonly answerCounter: number;
  readonly answerKey: string;
}

function uint32be(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function passwordFor(nonceHex: string, counter: number): Buffer {
  return Buffer.concat([Buffer.from(nonceHex, "hex"), uint32be(counter)]);
}

function makeChallenge(cost: number, counter: number, nowSec: number, unsolvable = false): SyntheticChallenge {
  const nonce = hex(randomBytes(16));
  const salt = hex(randomBytes(16));
  const derived = pbkdf2Sync(passwordFor(nonce, counter), Buffer.from(salt, "hex"), cost, 32, "sha256");
  return {
    parameters: {
      algorithm: "PBKDF2/SHA-256",
      cost,
      expiresAt: nowSec + 600,
      keyLength: 32,
      nonce,
      salt,
      keyPrefix: unsolvable ? "0".repeat(32) : hex(derived).slice(0, 32),
      keySignature: hex(randomBytes(32)),
    },
    signature: hex(randomBytes(32)),
    answerCounter: counter,
    answerKey: hex(derived),
  };
}

function envelope(nowSec: number, body: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    application: { log: {}, defaultHost: null },
    result: [],
    total_single: {},
    messages: [],
    success: true,
    time: nowSec,
    timezone: "Europe/Berlin",
    ...body,
  };
}

const loginWall = (nowSec: number): Record<string, unknown> => ({
  application: { log: [], defaultHost: null },
  activeRoute: "default",
  login: [],
  redirect: { target: "?format=json", reload: true, message: "Die Sitzung ist abgelaufen, bitte erneut anmelden." },
  result: [],
  messages: [{ text: "Die Sitzung ist abgelaufen, bitte erneut anmelden.", status: "failed", model: "login" }],
  success: false,
  time: nowSec,
  timezone: "Europe/Berlin",
});

function recipe(
  uid: string,
  id: string,
  title: string,
  price: string,
  amountDescription: string | null,
): { readonly uid: string; readonly id: string; readonly title: string; readonly price: string; readonly description: string; readonly amount_description: string | null } {
  return {
    uid,
    id,
    title,
    price,
    description: "",
    amount_description: amountDescription,
  };
}

/** Kiosk card: mixed price precision, same-title trap, three id spaces, nested tree. */
function kioskRecipes(): Readonly<Record<string, ReturnType<typeof recipe>>> {
  return {
    "150090011": recipe("150090011", "7001101", "Synthetic Pils", "6.9000000000", "0,4"),
    "150090012": recipe("150090012", "7001102", "Synthetic Pils", "29.50", "1,0"),
    "150090021": recipe("150090021", "7001201", "Synthetic Ale", "2.50", null),
    "150090031": recipe("150090031", "7001301", "Synthetic Nibs", "4.20", null),
    "150090041": recipe("150090041", "7001401", "Synthetic Growler", "12.00", "2,0"),
    "150090042": recipe("150090042", "7001402", "Synthetic Bottle", "2.50", "0,5"),
  };
}

function content(id: string, sectionId: string, recipe: ReturnType<typeof recipe>): Record<string, unknown> {
  return { id, menusection_id: sectionId, menu_number: "", highlight: false, Recipe: recipe };
}

/** Fixture lookup: a missing uid is a broken fixture, not an optional value. */
function recipeAt(map: Readonly<Record<string, ReturnType<typeof recipe>>>, uid: string): ReturnType<typeof recipe> {
  const found = map[uid];
  if (found === undefined) throw new Error(`fixture recipe missing: ${uid}`);
  return found;
}

function kioskPickupPayload(nowSec: number): Record<string, unknown> {
  const recipes = kioskRecipes();
  return envelope(nowSec, {
    Menusection: [
      {
        id: "1900101",
        title: "Synthetic Kiosk",
        recipe_count: 6,
        MenusectionContent: [],
        Menusection: [
          {
            id: "1900102",
            title: "Bier",
            MenusectionContent: [],
            Menusection: [
              {
                id: "1900103",
                title: "Fass",
                MenusectionContent: [
                  content("160020301", "1900103", recipeAt(recipes, "150090011")),
                  content("160020302", "1900103", recipeAt(recipes, "150090012")),
                ],
              },
              {
                id: "1900104",
                title: "Flaschen",
                MenusectionContent: [content("160020303", "1900104", recipeAt(recipes, "150090042"))],
              },
            ],
          },
          {
            id: "1900105",
            title: "Snacks",
            MenusectionContent: [content("160020304", "1900105", recipeAt(recipes, "150090031"))],
          },
          {
            id: "1900106",
            title: "Auslauf",
            recipe_count: 0,
            MenusectionContent: [content("160020305", "1900106", recipeAt(recipes, "150090021"))],
          },
        ],
      },
    ],
    Recipe: recipes,
    RecipeStock: {
      "1280001": { id: "1280001", recipe_id: "7001101", locked_until: null },
      "1280002": { id: "1280002", recipe_id: "7001102", locked_until: String(nowSec + 3600) },
      "1280003": { id: "1280003", recipe_id: "7001402", locked_until: String(nowSec - 3600) },
      "1280004": { id: "1280004", recipe_id: "7001301", locked_until: null },
      "1280091": { id: "1280091", recipe_id: "6999991", locked_until: String(nowSec + 3600) },
      "1280092": { id: "1280092", recipe_id: "6999992", locked_until: null },
    },
    Currency: { id: "1", guid: null, title: "Synthetic Euro", short: "EUR", sign: "€", prec: "2", value: "1.0000000000" },
  });
}

/** Mode gating: success, zero cards — but the stock map still carries rows. */
function kioskInhousePayload(nowSec: number): Record<string, unknown> {
  const pickup = kioskPickupPayload(nowSec);
  return { ...pickup, Menusection: [], Recipe: {} };
}

function barPayload(nowSec: number): Record<string, unknown> {
  const recipes: Readonly<Record<string, ReturnType<typeof recipe>>> = {
    "150090051": recipe("150090051", "7002101", "Synthetic Helles", "5.80", "0,5"),
    "150090052": recipe("150090052", "7002102", "Synthetic IPA", "6.50", "0,5"),
    "150090053": recipe("150090053", "7002103", "Synthetic Wasser", "2.50", "0,75"),
  };
  return envelope(nowSec, {
    Menusection: [
      {
        id: "1900201",
        title: "Synthetic Bar",
        recipe_count: 3,
        MenusectionContent: [
          content("160020401", "1900201", recipeAt(recipes, "150090051")),
          content("160020402", "1900201", recipeAt(recipes, "150090052")),
        ],
        Menusection: [
          {
            id: "1900202",
            title: "Mehr",
            MenusectionContent: [content("160020403", "1900202", recipeAt(recipes, "150090053"))],
          },
        ],
      },
    ],
    Recipe: recipes,
    RecipeStock: {
      "1280101": { id: "1280101", recipe_id: "7002101", locked_until: null },
    },
    Currency: { id: "1", guid: null, title: "Synthetic Euro", short: "EUR", sign: "€", prec: "2", value: "1.0000000000" },
  });
}

/**
 * Table-bound catalog (delta 16/23 shape): with a valid tableCode the
 * costunit-selected cards REPLACE the no-code default — the kiosk card
 * disappears, the table's own cards appear, table_id_valid is "1".
 */
function tableCatalogPayload(nowSec: number): Record<string, unknown> {
  const recipes: Readonly<Record<string, ReturnType<typeof recipe>>> = {
    "150090061": recipe("150090061", "7003101", "Synthetic Table Pils", "3.90", "0,4"),
    "150090062": recipe("150090062", "7003102", "Synthetic Table Water", "1.90", "0,75"),
    "150090063": recipe("150090063", "7003103", "Synthetic Kommunikation", "0.00", null),
  };
  return envelope(nowSec, {
    table_id_valid: "1",
    Menusection: [
      {
        id: "1900301",
        title: "Tischkarte",
        recipe_count: 3,
        MenusectionContent: [
          content("160020501", "1900301", recipeAt(recipes, "150090061")),
          content("160020502", "1900301", recipeAt(recipes, "150090062")),
          content("160020503", "1900301", recipeAt(recipes, "150090063")),
        ],
      },
    ],
    Recipe: recipes,
    RecipeStock: {
      "1280201": { id: "1280201", recipe_id: "7003101", locked_until: null },
    },
    Currency: { id: "1", guid: null, title: "Synthetic Euro", short: "EUR", sign: "€", prec: "2", value: "1.0000000000" },
  });
}

function companySettings(): Record<string, unknown> {
  return envelope(Math.floor(Date.now() / 1000), {
    CompanySettings: {
      reservation_enabled: "",
      usepickup: "1",
      usedelivery: "",
      inhouseOrdering: "1",
      minOrderValue: "25",
      tablecodeHash: "",
      notificationOrdering: "1",
    },
  });
}

export function fakeGastronovi(options: FakeGastronoviOptions = {}): {
  readonly fetchImpl: typeof fetch;
  readonly requests: readonly RecordedRequest[];
  readonly issuedTokens: readonly string[];
} {
  const requests: RecordedRequest[] = [];
  const issuedTokens: string[] = [];
  const nowMs = options.now ?? (() => Date.now());
  const cost = options.cost ?? 2;
  const counter = options.counter ?? 7;
  const tokenTtl = options.tokenTtlMs ?? 600_000;
  const tokens = new Map<string, number>();
  let challengeCalls = 0;
  let submitCalls = 0;
  let menusAuthorizedCalls = 0;
  let tokenSerial = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = headerRecord(init);
    const body = bodyOf(init);
    requests.push({ method, url: `${url.origin}${url.pathname}?${url.searchParams.toString()}`, headers, body });
    const nowSec = Math.floor(nowMs() / 1000);

    const codeMatch = url.pathname.match(/^\/code\/([^/]+)$/);
    if (codeMatch?.[1] !== undefined && method === "GET") {
      const target = CODE_TARGETS[codeMatch[1].toUpperCase()];
      if (target === undefined) {
        return new Response(
          `<html><body><form action="/code"><p>Ungültiger Code!</p></form></body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=UTF-8" } },
        );
      }
      return jsonResponse(
        envelope(nowSec, {
          activeRoute: "defaultCodeSubmit",
          formular_code: {},
          redirect: {
            target: `/restaurants/${target}/reservation/widget?c=${codeMatch[1].toUpperCase()}`,
            message: "Bitte einen Augenblick warten.",
          },
        }),
      );
    }

    const unit = url.searchParams.get("api_id") ?? "";
    const path = url.pathname;

    if (method === "POST" && path === "/reservations/information") {
      if (unit === DEAD_UNIT) return jsonResponse(loginWall(nowSec));
      if (unit === LIVE_KIOSK_UNIT || unit === LIVE_BAR_UNIT) return jsonResponse(companySettings());
      return jsonResponse(loginWall(nowSec));
    }

    if (method === "POST" && path === "/guestsession/challenge") {
      challengeCalls += 1;
      if (options.challenge429 !== undefined && challengeCalls <= options.challenge429) {
        return new Response("", { status: 429 });
      }
      let challenge = makeChallenge(cost, counter, nowSec, options.unsolvableChallenge === true);
      if (options.staleChallengeOnce === true && challengeCalls === 1) {
        challenge = makeChallenge(cost, counter, nowSec - 1200, options.unsolvableChallenge === true);
      }
      return jsonResponse(envelope(nowSec, {
        activeRoute: "defaultGuestSession",
        challenge: { parameters: challenge.parameters, signature: challenge.signature },
      }));
    }

    if (method === "POST" && path === "/guestsession/submitchallenge") {
      submitCalls += 1;
      const form = new URLSearchParams(typeof body === "string" ? body : "");
      const solveduration = url.searchParams.get("solveduration");
      const param = (field: string): string => form.get(`challenge[parameters][${field}]`) ?? "";
      const postedCounter = Number(form.get("solution[counter]"));
      const postedKey = form.get("solution[derivedKey]") ?? "";
      const nonce = param("nonce");
      const salt = param("salt");
      const prefix = param("keyPrefix");
      const postedCost = Number(param("cost"));
      const keyLength = Number(param("keyLength"));
      const expiresAt = Number(param("expiresAt"));
      if (solveduration === null || nonce === "" || salt === "" || prefix === "") {
        return jsonResponse(envelope(nowSec, { success: false, messages: [{ text: "malformed", status: "failed" }] }));
      }
      if (expiresAt <= nowSec) {
        return jsonResponse(envelope(nowSec, { success: false, messages: [{ text: "expired challenge", status: "failed" }] }));
      }
      // Server-side verification: re-derive from the POSTED parameters.
      const derived = hex(pbkdf2Sync(passwordFor(nonce, postedCounter), Buffer.from(salt, "hex"), postedCost, keyLength, "sha256"));
      const valid = derived === postedKey && derived.startsWith(prefix);
      if (!valid) {
        return jsonResponse(envelope(nowSec, { success: false, messages: [{ text: "bad solution", status: "failed" }] }));
      }
      if (options.rejectSubmitOnce !== undefined && submitCalls <= options.rejectSubmitOnce) {
        return jsonResponse(envelope(nowSec, { success: false, messages: [{ text: "not now", status: "failed" }] }));
      }
      tokenSerial += 1;
      const token = `synthetic-guest-token-${tokenSerial}`;
      issuedTokens.push(token);
      tokens.set(token, nowMs() + tokenTtl);
      const tokenField = options.tokenShape === "object" ? { value: token } : token;
      return jsonResponse(
        envelope(nowSec, { token: tokenField }),
        { "set-cookie": `${CSRF_COOKIE}=${token}; Path=/; Secure; HttpOnly; Partitioned` },
      );
    }

    if (method === "POST" && path === "/ordering/menus") {
      const token = headers["x-csrf-token"] ?? "";
      const cookie = headers["cookie"] ?? "";
      const authorized = (tokens.get(token) ?? 0) > nowMs() && cookie.includes(`${CSRF_COOKIE}=${token}`);
      if (!authorized) {
        return jsonResponse(
          envelope(nowSec, {
            activeRoute: "defaultOrdering",
            GuestSession: [],
            messages: [{ text: "Unauthorized. Please refresh.", status: "failed", model: "GuestSession" }],
            success: false,
          }),
          {},
          401,
        );
      }
      if (options.killTokensAfterFirstMenus === true) {
        menusAuthorizedCalls += 1;
        if (menusAuthorizedCalls >= 1) tokens.clear();
      }
      if (unit === DEAD_UNIT) return jsonResponse(loginWall(nowSec));
      const type = formField(body, "type");
      const tableCode = formField(body, "tableCode");
      if (tableCode !== "") {
        // A table binding is costunit selection: valid code swaps the card
        // set entirely; an invalid one falls back to the no-code set with
        // table_id_valid "0" (the widget redirects to overview there).
        if (tableCode === BOUND_TABLE_CODE) {
          return jsonResponse(tableCatalogPayload(nowSec));
        }
        const fallback = unit === LIVE_KIOSK_UNIT && type === "inhouse"
          ? kioskInhousePayload(nowSec)
          : unit === LIVE_KIOSK_UNIT
            ? kioskPickupPayload(nowSec)
            : barPayload(nowSec);
        return jsonResponse({ ...fallback, table_id_valid: "0" });
      }
      if (unit === LIVE_KIOSK_UNIT) {
        return jsonResponse(type === "inhouse" ? kioskInhousePayload(nowSec) : kioskPickupPayload(nowSec));
      }
      if (unit === LIVE_BAR_UNIT) return jsonResponse(barPayload(nowSec));
      return jsonResponse(loginWall(nowSec));
    }

    return jsonResponse(envelope(nowSec, { success: false, messages: [{ text: `unrouted ${method} ${path}` }] }));
  };
  return { fetchImpl, requests, issuedTokens };
}

function formField(body: string | FormData | null, name: string): string {
  const form = new URLSearchParams(typeof body === "string" ? body : "");
  return form.get(name) ?? "";
}
