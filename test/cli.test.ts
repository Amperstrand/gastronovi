import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { BOUND_TABLE_CODE, DEAD_CODE, fakeGastronovi, LIVE_KIOSK_CODE } from "./gastronovi-fake.js";

function ports(lines: string[], errors: string[]) {
  return {
    out: (line: string) => lines.push(line),
    err: (line: string) => errors.push(line),
  };
}

describe("runCli", () => {
  it("reads a menu through the PoW gate and prints prices", async () => {
    const transport = fakeGastronovi();
    const lines: string[] = [];
    const code = await runCli(["menu", LIVE_KIOSK_CODE], { ...ports(lines, []), fetchImpl: transport.fetchImpl });
    expect(code).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("Synthetic Pils 0,4  6.90 EUR");
    expect(text).toContain("Synthetic Pils 1,0  29.50 EUR");
    expect(text).toContain("(locked)");
    expect(text).not.toContain("Auslauf");
  });

  it("defaults to pickup and accepts --mode inhouse, reporting the gate as data (exit 0)", async () => {
    const transport = fakeGastronovi();
    const defaultLines: string[] = [];
    expect(await runCli(["menu", LIVE_KIOSK_CODE], { ...ports(defaultLines, []), fetchImpl: transport.fetchImpl })).toBe(0);
    expect(defaultLines.join("\n")).toContain("pickup");

    const inhouseLines: string[] = [];
    expect(await runCli(["menu", LIVE_KIOSK_CODE, "--mode", "inhouse"], { ...ports(inhouseLines, []), fetchImpl: transport.fetchImpl })).toBe(0);
    expect(inhouseLines.join("\n")).toContain("no cards in this mode");
    expect(inhouseLines.join("\n")).toContain("--mode pickup");
  });

  it("health prints the cookieless verdict without solving a PoW", async () => {
    const transport = fakeGastronovi();
    const lines: string[] = [];
    const code = await runCli(["health", LIVE_KIOSK_CODE], { ...ports(lines, []), fetchImpl: transport.fetchImpl });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain(`unit 4242`);
    expect(lines.join("\n")).toContain("live:      yes");
    expect(transport.requests.some((request) => request.url.includes("/guestsession/"))).toBe(false);
  });

  it("health on a deactivated unit exits 1 with the liveness caveat", async () => {
    const transport = fakeGastronovi();
    const lines: string[] = [];
    const code = await runCli(["health", DEAD_CODE], { ...ports(lines, []), fetchImpl: transport.fetchImpl });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("challenge success is not liveness");
  });

  it("rejects invalid codes, bad modes, and transport death with exit 1", async () => {
    const errors: string[] = [];
    expect(await runCli(["menu", "bad!code"], ports([], errors))).toBe(1);
    expect(errors[0]).toContain("cannot parse unit or code");

    const modeErrors: string[] = [];
    expect(await runCli(["menu", LIVE_KIOSK_CODE, "--mode", "delivery"], ports([], modeErrors))).toBe(1);
    expect(modeErrors[0]).toContain("--mode must be pickup or inhouse");

    const dead: typeof fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const netErrors: string[] = [];
    expect(await runCli(["health", LIVE_KIOSK_CODE], { ...ports([], netErrors), fetchImpl: dead })).toBe(1);
    expect(netErrors[0]).toContain("fetch failed");
  });

  it("binds a table code via --table and prints the bound card set", async () => {
    const transport = fakeGastronovi();
    const lines: string[] = [];
    const code = await runCli(
      ["menu", LIVE_KIOSK_CODE, "--mode", "inhouse", "--table", BOUND_TABLE_CODE],
      { ...ports(lines, []), fetchImpl: transport.fetchImpl },
    );
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Tischkarte");
    expect(lines.join("\n")).toContain("table binding: valid");
  });

  it("prints usage on help and unknown commands", async () => {
    const lines: string[] = [];
    expect(await runCli([], ports(lines, []))).toBe(0);
    expect(lines.join("\n")).toContain("gastronovi — read-only");
    const errors: string[] = [];
    expect(await runCli(["order", "7960"], ports([], errors))).toBe(1);
    expect(errors[0]).toContain("unknown command: order");
  });
});
