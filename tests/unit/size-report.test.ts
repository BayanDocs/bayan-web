import { describe, expect, it } from "vitest";
import {
  budgetBytes,
  compressedTotal,
  engineBudgetBytes,
  isEngineFile,
  measure,
  totalBudgetBytes,
} from "../../scripts/size-report.ts";

describe("size report", () => {
  it("measures raw and compressed sizes", () => {
    const size = measure("a.js", new TextEncoder().encode("x".repeat(10_000)));
    expect(size.raw).toBe(10_000);
    expect(size.gzip).toBeLessThan(200);
    expect(size.brotli).toBeLessThan(200);
  });

  it("totals gzip sizes against the 300 KB budget from WEB-001", () => {
    expect(budgetBytes).toBe(300_000);
    expect(
      compressedTotal([
        { path: "a", raw: 10, gzip: 4, brotli: 3 },
        { path: "b", raw: 10, gzip: 5, brotli: 4 },
      ]),
    ).toBe(9);
  });

  it("keeps the app's own budget at WEB-001's 300 KB, and gives the engine package and the whole build their own", () => {
    expect(engineBudgetBytes).toBe(300_000);
    expect(totalBudgetBytes).toBe(5_000_000);
  });

  it("counts the engine's runtime folder and licence notices as the engine package, and nothing else", () => {
    expect(isEngineFile("assets/engine-2bdd29223119f377/bayan_wasm_bg.wasm")).toBe(true);
    expect(isEngineFile("engine-licenses/THIRD-PARTY-LICENSES.txt")).toBe(true);
    expect(isEngineFile("assets/index-BKM0Ac_y.js")).toBe(false);
    expect(isEngineFile("assets/engine-not-a-digest/x.js")).toBe(false);
    expect(isEngineFile("third-party-licenses.txt")).toBe(false);
  });
});
