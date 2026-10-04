import { describe, expect, it } from "vitest";
import { parseTheme, readStoredTheme, resolveTheme, storeTheme } from "../../src/theme.ts";

describe("theme", () => {
  it("follows the system until the user chooses", () => {
    expect(resolveTheme(null, false)).toBe("light");
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("treats stored values as untrusted", () => {
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("<img onerror>")).toBeNull();
    expect(parseTheme(null)).toBeNull();
  });

  it("survives unavailable storage", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readStoredTheme(broken)).toBeNull();
    expect(() => storeTheme(broken, "dark")).not.toThrow();
    expect(readStoredTheme(undefined)).toBeNull();
  });
});
