export type UnitId = string & { readonly __brand: "UnitId" };

/** Parse a unit id: the numeric `/restaurants/<id>` company id. */
export function unitId(value: string): UnitId {
  const trimmed = value.trim();
  if (!/^\d{1,9}$/.test(trimmed)) {
    throw new Error(`invalid unit id: ${value}`);
  }
  return trimmed as UnitId;
}

export type OrderMode = "pickup" | "inhouse" | "delivery";

export function orderMode(value: string): OrderMode {
  if (value === "pickup" || value === "inhouse" || value === "delivery") return value;
  throw new Error(`invalid order mode: ${value} (pickup|inhouse|delivery)`);
}

/** A resolved GastroNova unit. `live` is the cookieless health verdict. */
export interface Unit {
  readonly id: UnitId;
  /** Venue name from the landing page title; null when it carries none. */
  readonly name: string | null;
  readonly live: boolean;
  readonly pickup: boolean;
  readonly inhouse: boolean;
  readonly minOrderValue: number | null;
}
