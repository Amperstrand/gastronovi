/**
 * Transport-level failure (network down, DNS, timeout). A thrown
 * GastronoviError always means "we could not talk to the platform"; a null
 * return from a client method always means "the platform answered: absent"
 * (invalid code, login-walled dead unit, no menu).
 */
export type GastronoviFailureReason = "network";

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
