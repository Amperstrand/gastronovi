#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { GastronoviClient } from "./client.js";
import type { Menu } from "./menu.js";
import type { Unit } from "./types.js";

/**
 * Read-only CLI: `gastronovi health <code>`, `gastronovi menu <code>`.
 * Deliberately NO order command — this platform's payment boundary is a
 * hosted checkout a human opens; the client reads, a person pays.
 */
export interface CliPorts {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly fetchImpl?: typeof fetch;
}

const USAGE = `gastronovi — read-only GastroNova self-ordering client

commands:
  health <code>              resolve + cookieless liveness check (no PoW)
  menu <code> [--mode m]     read the menu card set (solves the PoW once)
                             --mode pickup (default) | inhouse
  --table <Tcode>            bind the read to a table's costunit catalog

<code> is a unit id (7960), a services.gastronovi.com URL, or a table /
sale capability code. Worked examples: 7960 (BRLO BRWHOUSE), 96153 (BRLO
Charlottenburg). An empty inhouse read is mode gating, not a dead unit —
retry with --mode pickup. No order command exists by design.`;

function processPorts(): CliPorts {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}

function printUnit(unit: Unit, out: (line: string) => void): void {
  out(`unit ${unit.id}`);
  out(`  live:      ${unit.live ? "yes" : "no (deactivated — challenge success is not liveness)"}`);
  out(`  pickup:    ${unit.pickup ? "enabled" : "off"}`);
  out(`  inhouse:   ${unit.inhouse ? "enabled" : "off"}`);
  out(`  min order: ${unit.minOrderValue === null ? "none published" : `${unit.minOrderValue}`}`);
}

function printMenu(menu: Menu, out: (line: string) => void): void {
  out(`unit ${menu.unit} — ${menu.mode} — ${menu.categories.length} card(s), ${menu.stockRows} stock rows (${menu.updatedAt})`);
  if (menu.tableIdValid !== null) {
    out(`  table binding: ${menu.tableIdValid ? "valid" : "INVALID — showing the no-code fallback cards"}`);
  }
  if (menu.gated) {
    out(`  (no cards in this mode — inhouse is gated without a table code; try --mode pickup)`);
    return;
  }
  for (const category of menu.categories) {
    out(category.name);
    for (const item of category.items) {
      const price = item.price.toFixed(2);
      const locked = item.available ? "" : "  (locked)";
      out(`  ${item.title}${item.amountDescription === null ? "" : ` ${item.amountDescription}`}  ${price} ${item.currency}  [uid ${item.uid}]${locked}`);
    }
  }
}

interface ParsedArgs {
  readonly command: string | undefined;
  readonly target: string | undefined;
  readonly mode: "pickup" | "inhouse";
  readonly tableCode: string | undefined;
}

function parseArgs(argv: readonly string[]): ParsedArgs | null {
  let command: string | undefined;
  let target: string | undefined;
  let mode: "pickup" | "inhouse" = "pickup";
  let tableCode: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === "--mode") {
      const value = argv[i + 1];
      if (value !== "pickup" && value !== "inhouse") return null;
      mode = value;
      i += 1;
      continue;
    }
    if (arg === "--table") {
      const value = argv[i + 1];
      if (value === undefined || value === "") return null;
      tableCode = value;
      i += 1;
      continue;
    }
    if (command === undefined) command = arg;
    else if (target === undefined) target = arg;
    else return null;
  }
  return { command, target, mode, tableCode };
}

export async function runCli(
  argv: readonly string[],
  ports: CliPorts = processPorts(),
): Promise<0 | 1> {
  const args = parseArgs(argv);
  if (args === null) {
    ports.err("--mode must be pickup or inhouse");
    ports.err(USAGE);
    return 1;
  }
  const { command, target, mode, tableCode } = args;
  if (command === undefined || command === "help" || command === "-h" || command === "--help") {
    ports.out(USAGE);
    return 0;
  }
  if (command !== "health" && command !== "menu") {
    ports.err(`unknown command: ${command}`);
    ports.err(USAGE);
    return 1;
  }
  if (target === undefined) {
    ports.err(`${command} needs a unit id or code, e.g. 7960`);
    return 1;
  }

  const client = new GastronoviClient(ports.fetchImpl === undefined ? {} : { fetchImpl: ports.fetchImpl });
  try {
    const unit = await client.unit(target);
    if (unit === null) {
      ports.err(`no unit for ${target} (invalid or unresolvable code)`);
      return 1;
    }
    if (command === "health") {
      printUnit(unit, ports.out);
      return unit.live ? 0 : 1;
    }
    if (!unit.live) {
      ports.err(`unit ${unit.id} is deactivated — menus sit behind a login wall`);
      return 1;
    }
    const menu = await client.menu(unit.id, mode, tableCode === undefined ? {} : { tableCode });
    if (menu === null) {
      ports.err(`no menu for unit ${unit.id}`);
      return 1;
    }
    printMenu(menu, ports.out);
    return 0;
  } catch (error) {
    ports.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

// npm installs the bin as a .bin symlink while Node realpaths the ESM
// entry — compare resolved paths or the CLI silently no-ops for consumers.
function invokedAsScript(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  process.exit(await runCli(process.argv.slice(2)));
}
