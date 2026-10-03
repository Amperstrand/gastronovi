import { describe, expect, it } from "vitest";
import { PLATFORM } from "../src/index.js";

describe("package", () => {
  it("names its platform", () => {
    expect(PLATFORM).toBe("gastronovi");
  });
});
