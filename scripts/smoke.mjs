#!/usr/bin/env node
/**
 * Weekly smoke: read-only venue check for every worked example.
 * Cookieless health first; one PoW menu read on the cheapest unit only
 * (96153 pickup — no table code needed). Exit 1 on drift or transport
 * failure. Never places orders, never persists cookies.
 */
import { GastronoviClient } from "../dist/index.js";

const WORKED_EXAMPLES = [
  { id: "7960", name: "BRLO BRWHOUSE" },
  { id: "96153", name: "BRLO Charlottenburg" },
];

const client = new GastronoviClient();
let failed = false;

for (const unit of WORKED_EXAMPLES) {
  try {
    const health = await client.health(unit.id);
    if (health === null || !health.live) {
      console.error(`smoke fail ${unit.id} (${unit.name}): not live (${health === null ? "unresolved" : "deactivated"})`);
      failed = true;
    } else {
      console.log(`smoke pass ${unit.id} (${unit.name}): live pickup=${health.pickup} inhouse=${health.inhouse}`);
    }
  } catch (error) {
    console.error(`smoke fail ${unit.id} (${unit.name}): ${error instanceof Error ? error.message : String(error)}`);
    failed = true;
  }
}

try {
  const menu = await client.menu("96153", "pickup");
  if (menu === null || menu.categories.length === 0) {
    console.error(`smoke fail 96153 pickup menu: ${menu === null ? "null (login wall?)" : "zero cards"}`);
    failed = true;
  } else {
    const items = menu.categories.flatMap((category) => category.items);
    console.log(`smoke pass 96153 pickup menu: ${menu.categories.length} cards, ${items.length} items`);
  }
} catch (error) {
  console.error(`smoke fail 96153 pickup menu: ${error instanceof Error ? error.message : String(error)}`);
  failed = true;
}

process.exit(failed ? 1 : 0);
