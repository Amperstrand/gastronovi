import { describe, expect, it } from "vitest";
import { menuFromPayload, parsePrice, type RawMenusResponse } from "../src/menu.js";
import { unitId } from "../src/types.js";

const NOW = new Date("2026-10-03T12:00:00.000Z");

function payload(overrides: Partial<RawMenusResponse> = {}): RawMenusResponse {
  return {
    success: true,
    Menusection: [],
    Recipe: {},
    RecipeStock: {},
    Currency: { short: "EUR", sign: "€", prec: "2" },
    ...overrides,
  };
}

describe("parsePrice", () => {
  it("parses 2-decimal and 10-decimal strings numerically (unit-dependent precision)", () => {
    expect(parsePrice("2.50", "test")).toBe(2.5);
    expect(parsePrice("6.9000000000", "test")).toBe(6.9);
  });

  it("rejects absent prices as platform drift", () => {
    expect(() => parsePrice(undefined, "recipe x")).toThrow(/price/);
    expect(() => parsePrice("6,90", "recipe x")).toThrow(/recipe x.*6,90/);
  });
});

describe("price integrity", () => {
  it("rejects unparseable prices loudly instead of letting NaN flow into items", () => {
    const poisoned = payload({
      Menusection: [{
        id: "1900101",
        title: "Card",
        recipe_count: 1,
        MenusectionContent: [
          { id: "160020301", Recipe: { uid: "150090011", id: "7001101", title: "Item", price: "6,90" } },
        ],
      }],
    });
    expect(() => menuFromPayload(unitId("4242"), "pickup", poisoned, NOW)).toThrow(/150090011.*6,90/);
    expect(() => menuFromPayload(unitId("4242"), "pickup", poisoned, NOW)).toThrow(/price/);
  });
});

describe("menuFromPayload", () => {
  it("surfaces all three id spaces: uid (Recipe map key), id, MenusectionContent.id", () => {
    const menu = menuFromPayload(unitId("4242"), "pickup", payload({
      Menusection: [{
        id: "1900101",
        title: "Card",
        recipe_count: 1,
        MenusectionContent: [
          { id: "160020301", menusection_id: "1900101", Recipe: { uid: "150090011", id: "7001101", title: "Item", price: "2.50" } },
        ],
      }],
      Recipe: { "150090011": { uid: "150090011", id: "7001101", title: "Item", price: "2.50" } },
    }), NOW);
    const item = menu.categories[0]?.items[0];
    expect(item).toMatchObject({ uid: "150090011", id: "7001101", contentId: "160020301" });
  });

  it("keeps same-title products distinct (dedupe-by-title is a data-loss trap)", () => {
    const glass = { uid: "150090011", id: "7001101", title: "Synthetic Pils", price: "6.9000000000", amount_description: "0,4" };
    const bottle = { uid: "150090012", id: "7001102", title: "Synthetic Pils", price: "29.50", amount_description: "1,0" };
    const menu = menuFromPayload(unitId("4242"), "pickup", payload({
      Menusection: [{
        id: "1900101",
        title: "Card",
        recipe_count: 2,
        MenusectionContent: [
          { id: "160020301", Recipe: glass },
          { id: "160020302", Recipe: bottle },
        ],
      }],
    }), NOW);
    const items = menu.categories[0]?.items ?? [];
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.id)).toEqual(["7001101", "7001102"]);
    expect(items.map((item) => item.price)).toEqual([6.9, 29.5]);
  });

  it("filters explicit recipe_count 0 sections but walks subsections with no count", () => {
    const menu = menuFromPayload(unitId("4242"), "pickup", payload({
      Menusection: [{
        id: "1900101",
        title: "Card",
        recipe_count: 2,
        MenusectionContent: [],
        Menusection: [
          {
            id: "1900102",
            title: "Live",
            MenusectionContent: [
              { id: "160020301", Recipe: { uid: "1", id: "a1", title: "One", price: "1.00" } },
            ],
          },
          {
            id: "1900103",
            title: "Auslauf",
            recipe_count: 0,
            MenusectionContent: [
              { id: "160020302", Recipe: { uid: "2", id: "a2", title: "Two", price: "2.00" } },
            ],
          },
        ],
      }],
    }), NOW);
    const names = (menu.categories[0]?.items ?? []).map((item) => item.title);
    expect(names).toEqual(["One"]);
  });

  it("flattens the recursive section tree (top content, children, grandchildren)", () => {
    const menu = menuFromPayload(unitId("4242"), "pickup", payload({
      Menusection: [{
        id: "1",
        title: "Top",
        recipe_count: 3,
        MenusectionContent: [{ id: "c1", Recipe: { uid: "1", id: "a1", title: "Top item", price: "1.00" } }],
        Menusection: [{
          id: "2",
          title: "Child",
          MenusectionContent: [],
          Menusection: [{
            id: "3",
            title: "Grandchild",
            MenusectionContent: [
              { id: "c2", Recipe: { uid: "2", id: "a2", title: "Deep item", price: "2.00" } },
              { id: "c3", Recipe: { uid: "3", id: "a3", title: "Deeper item", price: "3.00" } },
            ],
          }],
        }],
      }],
    }), NOW);
    expect(menu.categories.map((category) => category.name)).toEqual(["Top", "Grandchild"]);
  });

  it("reads RecipeStock as timestamps: null available, future locked, past released; unmatched rows ignored", () => {
    const nowSec = Math.floor(NOW.getTime() / 1000);
    const menu = menuFromPayload(unitId("4242"), "pickup", payload({
      Menusection: [{
        id: "1",
        title: "Card",
        recipe_count: 3,
        MenusectionContent: [
          { id: "c1", Recipe: { uid: "1", id: "7001101", title: "Free", price: "1.00" } },
          { id: "c2", Recipe: { uid: "2", id: "7001102", title: "Locked", price: "2.00" } },
          { id: "c3", Recipe: { uid: "3", id: "7001103", title: "Released", price: "3.00" } },
        ],
      }],
      RecipeStock: {
        "1280001": { id: "1280001", recipe_id: "7001101", locked_until: null },
        "1280002": { id: "1280002", recipe_id: "7001102", locked_until: String(nowSec + 3600) },
        "1280003": { id: "1280003", recipe_id: "7001103", locked_until: String(nowSec - 3600) },
        "1280091": { id: "1280091", recipe_id: "6999999", locked_until: String(nowSec + 3600) },
      },
    }), NOW);
    const byTitle = new Map((menu.categories[0]?.items ?? []).map((item) => [item.title, item]));
    expect(byTitle.get("Free")).toMatchObject({ available: true, lockedUntil: null });
    expect(byTitle.get("Locked")).toMatchObject({ available: false, lockedUntil: nowSec + 3600 });
    expect(byTitle.get("Released")).toMatchObject({ available: true, lockedUntil: nowSec - 3600 });
    // Stock rows are not a menu census: unmatched rows count, gate nothing.
    expect(menu.stockRows).toBe(4);
  });

  it("flags a zero-card success read as gated (mode gating), not absent", () => {
    const menu = menuFromPayload(unitId("4242"), "inhouse", payload({
      Menusection: [],
      Recipe: {},
      RecipeStock: {
        "1280091": { id: "1280091", recipe_id: "6999999", locked_until: null },
      },
    }), NOW);
    expect(menu.categories).toEqual([]);
    expect(menu.gated).toBe(true);
    expect(menu.stockRows).toBe(1);
  });

  it("defaults currency to EUR when the envelope omits it", () => {
    const menu = menuFromPayload(unitId("4242"), "pickup", payload({ Currency: null }), NOW);
    expect(menu.currency).toBe("EUR");
  });
});
