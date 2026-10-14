import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { allowedScriptUrl, isPlainPath } from "../../src/security/script-url.ts";

const src = new URL("../../src", import.meta.url).pathname;
const policyModule = "src/security/script-url-policy.ts";
const worker = "/assets/engine-2bdd29223119f377/bayan-worker.js";
const allowed = new Set([worker]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

// WEB-002 AC-5: exactly one Trusted Types policy, created in one module only.
describe("the bayan-script-url Trusted Types policy", () => {
  it("is created in src/security/script-url-policy.ts and nowhere else in src/", () => {
    const creators = sourceFiles(src)
      .filter((file) => readFileSync(file, "utf8").includes("createPolicy"))
      .map((file) => relative(join(src, ".."), file).split(sep).join("/"));
    expect(creators).toEqual([policyModule]);
  });

  it("is created with the name bayan-script-url and implements createScriptURL only", () => {
    const source = readFileSync(join(src, "security", "script-url-policy.ts"), "utf8");
    expect(source).toContain('export const policyName = "bayan-script-url";');
    const calls = [...source.matchAll(/\.createPolicy\(policyName, \{([^}]*)\}\)/g)].map((match) => match[1] ?? "");
    expect(calls).toHaveLength(1);
    const members = [...(calls[0] ?? "").matchAll(/(\w+)\s*:/g)].map((match) => match[1]);
    expect(members).toEqual(["createScriptURL"]);
  });

  it("accepts exactly the app's own worker script", () => {
    expect(allowedScriptUrl(worker, allowed)).toBe(worker);
  });

  const refused = [
    ["another origin", "https://evil.example/assets/engine-2bdd29223119f377/bayan-worker.js"],
    ["the same origin written out", "http://127.0.0.1:4173/assets/engine-2bdd29223119f377/bayan-worker.js"],
    ["a protocol-relative address", "//evil.example/assets/engine-2bdd29223119f377/bayan-worker.js"],
    ["a blob: URL", "blob:http://127.0.0.1:4173/6a6c3f1e-8a3e-4c52-9a8e-2f4f1d1c0b7a"],
    ["a data: URL", "data:text/javascript,postMessage(1)"],
    ["a javascript: URL", "javascript:postMessage(1)"],
    ["a query string", `${worker}?v=1`],
    ["an empty query string", `${worker}?`],
    ["a fragment", `${worker}#x`],
    ["a relative path", "assets/engine-2bdd29223119f377/bayan-worker.js"],
    ["a path that walks up", "/assets/../assets/engine-2bdd29223119f377/bayan-worker.js"],
    ["a percent-escaped path", "/assets/engine-2bdd29223119f377/bayan%2Dworker.js"],
    ["a backslash", "/assets\\engine-2bdd29223119f377\\bayan-worker.js"],
    ["another built script", "/assets/index-BKM0Ac_y.js"],
    ["the glue the worker imports", "/assets/engine-2bdd29223119f377/bayan_wasm.js"],
    ["an empty string", ""],
  ] as const;
  for (const [what, input] of refused) {
    it(`refuses ${what}, without repeating it in the error`, () => {
      expect(() => allowedScriptUrl(input, allowed)).toThrow(TypeError);
      try {
        allowedScriptUrl(input, allowed);
      } catch (error) {
        if (input !== "") expect(String(error)).not.toContain(input);
      }
    });
  }

  it("refuses values that are not strings", () => {
    for (const value of [undefined, null, 1, { toString: () => worker }, new URL(`http://x${worker}`)]) {
      expect(() => allowedScriptUrl(value, allowed)).toThrow(TypeError);
    }
  });

  it("refuses even an allowed entry that is not a plain same-origin path", () => {
    for (const path of ["//evil.example/x.js", "blob:x", "/a/../b.js", "/a/./b.js", "/a//b.js", "/a.js?x"]) {
      expect(isPlainPath(path)).toBe(false);
      expect(() => allowedScriptUrl(path, new Set([path]))).toThrow(TypeError);
    }
  });
});
