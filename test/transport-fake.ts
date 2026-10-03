/**
 * Generic helpers for building a platform transport fake.
 * Copied from the jamezz package's test/transport-fake.ts (same author,
 * MIT) so both platform fakes assert identical request shapes.
 */
export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string | FormData | null;
}

export function headerRecord(init: RequestInit | undefined): Record<string, string> {
  const headers = init?.headers;
  if (headers === undefined) return {};
  if (headers instanceof Headers) {
    const record: Record<string, string> = {};
    for (const [key, value] of headers.entries()) record[key.toLowerCase()] = value;
    return record;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key.toLowerCase(), value]));
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
}

export function bodyOf(init: RequestInit | undefined): string | FormData | null {
  const body = init?.body;
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return body;
  if (body instanceof FormData) return body;
  return "[unrecorded body]";
}

export function jsonResponse(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function sent(requests: readonly RecordedRequest[], urlPart: string): RecordedRequest | undefined {
  return requests.find((request) => request.url.includes(urlPart));
}
