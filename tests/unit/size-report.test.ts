import { describe, expect, it } from "vitest";
import { budgetBytes, compressedTotal, measure } from "../../scripts/size-report.ts";

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
});
