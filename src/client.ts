import { GastronoviError } from "./error.js";
import { GuestSessionManager, TOKEN_TTL_MS, type GuestSession } from "./guest-session.js";
import { baseHeaders, fetchJson, fetchText, GASTRONOVI_ORIGIN, postForm, USER_AGENT } from "./http.js";
import { menuFromPayload, type Menu, type RawMenusResponse } from "./menu.js";
import type { Pbkdf2Hasher } from "./pow.js";
import { orderMode, unitId, type OrderMode, type Unit, type UnitId } from "./types.js";

export { TOKEN_TTL_MS };

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
  /** Upper counter bound for the PoW linear scan (default 2^22). */
  readonly scanBound?: number;
}

export interface MenuOptions {
  /**
   * Table capability code (`T…`): binds the read to that table's costunit
   * — the card set is table-selected and typically far larger than the
   * no-code default. Codes are unauthenticated capability strings; an
   * invalid one yields tableIdValid:false with the fallback cards.
   */
  readonly tableCode?: string;
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

/**
 * Read-only GastroNova client. A thrown GastronoviError (reasons
 * "network" / "pow" / "parse") means the platform was unreachable or its
 * protocol drifted; a null return always means the platform answered and
 * the thing is absent (invalid code, deactivated unit behind the login
 * wall). An EMPTY menu is data, not absence: inhouse without a table
 * code is mode-gated, not dead.
 */
export class GastronoviClient {
  private readonly sessions: GuestSessionManager;
  private readonly now: () => Date;

  constructor(private readonly options: ClientOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.sessions = new GuestSessionManager({
      now: this.now,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.hasher === undefined ? {} : { hasher: options.hasher }),
      ...(options.tokenTtlMs === undefined ? {} : { tokenTtlMs: options.tokenTtlMs }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.scanBound === undefined ? {} : { scanBound: options.scanBound }),
    });
  }

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
  async menu(
    codeOrUnit: string | UnitId,
    mode: OrderMode = "pickup",
    options: MenuOptions = {},
  ): Promise<Menu | null> {
    const id = await this.resolveInput(codeOrUnit);
    if (id === null) return null;
    const payload = await this.orderingMenus(id, mode, options.tableCode);
    if (payload === null || payload.success !== true || this.messageModel(payload) === "login") {
      return null;
    }
    return menuFromPayload(id, mode, payload, this.now());
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
      if (result.kind === "network") {
        throw new GastronoviError("network", `code resolve failed: ${result.body}`);
      }
      return null;
    }
    const target = result.value.redirect?.target;
    if (result.value.success !== true || target === undefined) return null;
    const id = target.match(/\/restaurants\/(\d+)/)?.[1];
    return id === undefined ? null : unitId(id);
  }

  private async healthOf(id: UnitId): Promise<Unit> {
    const result = await postForm<RawInformationEnvelope>(
      { unit: id, path: "/reservations/information", params: {} },
      this.options.fetchImpl,
    );
    if (!result.ok) {
      if (result.kind === "network") {
        throw new GastronoviError("network", `health check failed: ${result.body}`);
      }
      return { id, name: await this.landingName(id), live: false, pickup: false, inhouse: false, minOrderValue: null };
    }
    const settings = result.value.CompanySettings;
    const flag = (value: string | number | null | undefined): boolean =>
      value !== undefined && value !== null && value !== "" && Number(value) === 1;
    const min = settings?.minOrderValue;
    return {
      id,
      name: await this.landingName(id),
      live: result.value.success === true,
      pickup: flag(settings?.usepickup),
      inhouse: flag(settings?.inhouseOrdering),
      minOrderValue: min === undefined || min === null || min === "" ? null : Number(min),
    };
  }

  /**
   * The landing page title carries the venue name even on the offline
   * shell (name lane). Supplementary data: any failure yields null — the
   * health verdict never depends on it. Only transport death propagates.
   */
  private async landingName(id: UnitId): Promise<string | null> {
    const result = await fetchText(`${GASTRONOVI_ORIGIN}/restaurants/${id}/`, {
      headers: { "user-agent": USER_AGENT, accept: "text/html" },
      signal: AbortSignal.timeout(20_000),
    }, this.options.fetchImpl);
    if (!result.ok) {
      if (result.kind === "network") {
        throw new GastronoviError("network", `landing fetch failed: ${result.body}`);
      }
      return null;
    }
    const title = result.text.match(/<title>([^<]*)<\/title>/i)?.[1];
    const name = title?.trim() ?? "";
    return name === "" ? null : name;
  }

  private async orderingMenus(id: UnitId, mode: OrderMode, tableCode: string | undefined): Promise<RawMenusResponse | null> {
    let result = await this.menusWithSession(id, mode, await this.sessions.acquire(id), tableCode);
    if (this.refused(result)) {
      this.sessions.invalidate(id);
      result = await this.menusWithSession(id, mode, await this.sessions.acquire(id), tableCode);
      if (this.refused(result)) return null;
    }
    return result.ok ? result.value : null;
  }

  /** Token refusal signature: HTTP 401 or the GuestSession envelope model. */
  private refused(result: Awaited<ReturnType<GastronoviClient["menusWithSession"]>>): boolean {
    return !result.ok
      ? result.kind === "http" && result.status === 401
      : this.messageModel(result.value) === "GuestSession";
  }

  private async menusWithSession(
    id: UnitId,
    mode: OrderMode,
    session: GuestSession,
    tableCode: string | undefined,
  ): Promise<Awaited<ReturnType<typeof postForm<RawMenusResponse>>>> {
    return await postForm<RawMenusResponse>({
      unit: id,
      path: "/ordering/menus",
      params: {
        time: String(Math.floor(this.now().getTime() / 1000)),
        type: mode,
        stripHtml: "1",
        completeDay: "1",
        ...(tableCode === undefined ? {} : { tableCode }),
      },
      headers: { "x-csrf-token": session.token, cookie: session.cookie },
    }, this.options.fetchImpl);
  }

  private messageModel(payload: RawMenusResponse): string | null {
    for (const message of payload.messages ?? []) {
      if (message.model !== undefined) return message.model;
    }
    return null;
  }
}
