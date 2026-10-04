import { describe, expect, it } from "vitest";
import { safeLocalStorage } from "../../src/storage.ts";

describe("safeLocalStorage", () => {
  it("returns the storage when the page may use it", () => {
    const storage = { getItem: () => null } as unknown as Storage;
    expect(safeLocalStorage({ localStorage: storage })).toBe(storage);
  });

  // Regression test: reading window.localStorage throws when the user blocks sites from saving data, and the app rendered nothing.
  it("returns undefined instead of throwing when reading localStorage throws a SecurityError", () => {
    const blocked = {
      get localStorage(): Storage {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    };
    expect(safeLocalStorage(blocked)).toBeUndefined();
  });
});
