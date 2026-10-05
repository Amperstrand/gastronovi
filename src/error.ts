export type GastronoviFailureReason =
  /** We could not talk to the platform (down, DNS, timeout). */
  | "network"
  /** The ALTCHA guest-session protocol failed us: no live challenge, unsolvable within the scan bound, or submit refused. */
  | "pow"
  /** The platform answered with a payload we cannot parse faithfully (e.g. a non-decimal price string). */
  | "parse";

export class GastronoviError extends Error {
  constructor(readonly reason: GastronoviFailureReason, message: string) {
    super(message);
    this.name = "GastronoviError";
  }
}

export function asTransportError(error: unknown): GastronoviError {
  return new GastronoviError("network", error instanceof Error ? error.message : String(error));
}

export function isTransportFailure(error: unknown): boolean {
  return error instanceof Error || typeof DOMException === "function" && error instanceof DOMException;
}
