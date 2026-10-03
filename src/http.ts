import { isTransportFailure } from "./error.js";

export const GASTRONOVI_ORIGIN = "https://services.gastronovi.com";
export const USER_AGENT = "gastronovi/0.1";

/** Every JSON endpoint takes the same jQuery-era API query. */
export function apiQuery(unitId: string, extra: Readonly<Record<string, string>> = {}): string {
  const params = new URLSearchParams({
    api_id: unitId,
    api_class: "Company",
    L: "de",
    format: "json",
    ...extra,
  });
  return params.toString();
}

export interface JsonResult<T> {
  readonly ok: true;
  readonly value: T;
  readonly cookie: string | null;
}

export interface JsonFailure {
  readonly ok: false;
  /**
   * "network" = transport failure (thrown, timeout, DNS) — surfaced to the
   * caller as a thrown GastronoviError by the client.
   * "http" = server answered with an error status.
   * "parse" = 2xx body that is not JSON (e.g. the Zend-form HTML re-render
   * the /code resolver serves for invalid codes).
   */
  readonly kind: "http" | "network" | "parse";
  readonly status: number;
  readonly body: string;
}

export type FetchJsonResult<T> = JsonResult<T> | JsonFailure;

export function cookieHeader(response: Response): string | null {
  const cookies = response.headers.getSetCookie().map((entry) => entry.split(";")[0]).filter(Boolean);
  return cookies.length > 0 ? cookies.join("; ") : null;
}

export function hostCookie(cookie: string | null, name: string): string | null {
  if (cookie === null) return null;
  const match = cookie.split(/;\s*/).find((entry) => entry.startsWith(`${name}=`));
  return match === undefined ? null : match.slice(name.length + 1);
}

export function baseHeaders(cookie: string | null): Record<string, string> {
  return {
    "user-agent": USER_AGENT,
    accept: "application/json",
    "x-requested-with": "XMLHttpRequest",
    ...(cookie === null ? {} : { cookie }),
  };
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchJsonResult<T>> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    if (!isTransportFailure(error)) throw error;
    return {
      ok: false,
      kind: "network",
      status: 0,
      body: error instanceof Error ? error.message : String(error),
    };
  }
  const cookie = cookieHeader(response);
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, kind: "http", status: response.status, body: text.slice(0, 500) };
  }
  try {
    return { ok: true, value: JSON.parse(text) as T, cookie };
  } catch {
    return { ok: false, kind: "parse", status: response.status, body: text.slice(0, 500) };
  }
}
