import type { OrderMode, UnitId } from "./types.js";

/**
 * Wire shapes of the `/ordering/menus` envelope. Everything is optional at
 * the boundary; the parser is total and never trusts a field's presence.
 * Quirks encoded below (each maps to a test + Lessons line):
 *  - `Recipe` is a MAP keyed by string `uid`, not an array.
 *  - Every recipe carries both `uid` (menu↔recipe join id) and `id`
 *    (global recipe id); `MenusectionContent.id` is a THIRD id space.
 *  - `MenusectionContent` embeds full `Recipe` objects (no recipe_id
 *    pointer on the live cards; Mainsection carries `recipe_id` instead).
 *  - Sections nest recursively via a child `Menusection` array — some
 *    units put content on the top card, some only on (grand)children.
 *  - `RecipeStock` rows are keyed by their own recipe_id (mostly NOT the
 *    live card's recipes — stock rows are not a menu census) and express
 *    availability as a `locked_until` unix timestamp (null = available).
 *  - Prices are decimal STRINGS with unit-dependent precision (2-decimal
 *    "2.50" mixed with 10-decimal "6.9000000000" in one response).
 *  - All ids arrive as JSON strings; guid fields are null.
 */
export interface RawRecipe {
  readonly uid?: string;
  readonly id?: string;
  readonly title?: string;
  readonly description?: string | null;
  readonly price?: string;
  readonly amount_description?: string | null;
}

export interface RawMenusectionContent {
  readonly id?: string;
  readonly menusection_id?: string;
  readonly Recipe?: RawRecipe;
}

export interface RawMenusection {
  readonly id?: string;
  readonly title?: string | null;
  readonly recipe_count?: number | string | null;
  readonly MenusectionContent?: readonly RawMenusectionContent[];
  readonly Menusection?: readonly RawMenusection[];
}

export interface RawRecipeStockRow {
  readonly id?: string;
  readonly recipe_id?: string;
  readonly locked_until?: string | number | null;
}

export interface RawCurrency {
  readonly short?: string;
  readonly sign?: string;
  readonly prec?: string;
}

export interface RawEnvelopeMessage {
  readonly text?: string;
  readonly status?: string;
  readonly model?: string;
}

export interface RawMenusResponse {
  readonly success?: boolean;
  readonly messages?: readonly RawEnvelopeMessage[];
  readonly time?: number;
  readonly timezone?: string;
  readonly Menusection?: readonly RawMenusection[] | null;
  readonly Recipe?: Readonly<Record<string, RawRecipe>> | null;
  readonly RecipeStock?: Readonly<Record<string, RawRecipeStockRow>> | null;
  readonly Currency?: RawCurrency | null;
}

export interface MenuItem {
  /** menu↔recipe join id — the key of the Recipe map (string). */
  readonly uid: string;
  /** global recipe id (string) — different space from uid. */
  readonly id: string;
  /** MenusectionContent row id (string) — the third id space. */
  readonly contentId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly price: number;
  /** The raw decimal string as served (mixed precision by unit). */
  readonly priceRaw: string;
  readonly amountDescription: string | null;
  readonly currency: string;
  readonly available: boolean;
  readonly lockedUntil: number | null;
}

export interface MenuCategory {
  readonly name: string;
  readonly items: readonly MenuItem[];
}

export interface Menu {
  readonly unit: UnitId;
  readonly mode: OrderMode;
  readonly currency: string;
  readonly categories: readonly MenuCategory[];
  /**
   * true when the platform answered success but served zero cards — the
   * documented inhouse mode gate (empty inhouse is NOT a dead unit; the
   * same unit serves a full pickup card).
   */
  readonly gated: boolean;
  /** Rows in the RecipeStock map — larger than the live card (not a census). */
  readonly stockRows: number;
  readonly updatedAt: string;
}

function stockByRecipeId(
  stock: Readonly<Record<string, RawRecipeStockRow>> | null | undefined,
): Map<string, number | null> {
  const map = new Map<string, number | null>();
  for (const row of Object.values(stock ?? {})) {
    if (row.recipe_id === undefined) continue;
    const locked = row.locked_until;
    map.set(row.recipe_id, locked === null || locked === undefined ? null : Number(locked));
  }
  return map;
}

/**
 * Prices are decimal strings with unit-dependent precision ("2.50" and
 * "6.9000000000" can appear in one response). Parse numerically — never
 * slice or pad strings.
 */
export function parsePrice(raw: string | undefined): number {
  return Number.parseFloat(raw ?? "0");
}

function itemFromContent(
  content: RawMenusectionContent,
  recipe: RawRecipe,
  currency: string,
  stock: Map<string, number | null>,
  nowSec: number,
): MenuItem {
  const id = recipe.id ?? "";
  const lockedUntil = stock.get(id) ?? null;
  const available = lockedUntil === null || lockedUntil <= nowSec;
  return {
    uid: recipe.uid ?? "",
    id,
    contentId: content.id ?? null,
    title: recipe.title ?? recipe.uid ?? "",
    description: recipe.description ?? null,
    price: parsePrice(recipe.price),
    priceRaw: recipe.price ?? "0",
    amountDescription: recipe.amount_description ?? null,
    currency,
    available,
    lockedUntil,
  };
}

/** Walks the recursive section tree, one category per section that carries content. */
export function menuFromPayload(
  unit: UnitId,
  mode: OrderMode,
  payload: RawMenusResponse,
  now: Date,
): Menu {
  const currency = payload.Currency?.short ?? "EUR";
  const stock = stockByRecipeId(payload.RecipeStock);
  const categories: MenuCategory[] = [];

  const walk = (section: RawMenusection): void => {
    // Platform quirk: an explicit recipe_count == 0 means client-filtered;
    // a missing count (subsections carry none) must still walk.
    const rawCount = section.recipe_count;
    if (rawCount !== undefined && rawCount !== null && Number(rawCount) === 0) return;
    const items: MenuItem[] = [];
    for (const content of section.MenusectionContent ?? []) {
      if (content.Recipe === undefined) continue;
      items.push(itemFromContent(content, content.Recipe, currency, stock, Math.floor(now.getTime() / 1000)));
    }
    if (items.length > 0) {
      categories.push({ name: section.title ?? section.id ?? "", items });
    }
    for (const child of section.Menusection ?? []) walk(child);
  };
  for (const section of payload.Menusection ?? []) walk(section);

  return {
    unit,
    mode,
    currency,
    categories,
    gated: categories.length === 0,
    stockRows: stock.size,
    updatedAt: now.toISOString(),
  };
}
