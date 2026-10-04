import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cspDirectives, devHeaders, productionHeaders, serializeCsp } from "../../config/security-headers.ts";

function directive(csp: string, name: string): string[] | undefined {
  const found = csp
    .split(";")
    .map((part) => part.trim().split(/\s+/))
    .find(([key]) => key === name);
  return found?.slice(1);
}

describe("security headers", () => {
  const csp = productionHeaders["Content-Security-Policy"] ?? "";

  it("allows scripts only from our origin plus WebAssembly compilation", () => {
    expect(directive(csp, "script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toMatch(/'unsafe-eval'/);
  });

  it("allows no third-party origins in any directive", () => {
    for (const [, ...sources] of cspDirectives) {
      for (const source of sources) {
        expect(source).toMatch(/^('self'|'none'|'wasm-unsafe-eval'|'script'|blob:)$/);
      }
    }
  });

  it("enforces Trusted Types with no policies", () => {
    expect(directive(csp, "require-trusted-types-for")).toEqual(["'script'"]);
    expect(directive(csp, "trusted-types")).toEqual(["'none'"]);
  });

  it("locks down plugins, base URL, forms and framing", () => {
    expect(directive(csp, "object-src")).toEqual(["'none'"]);
    expect(directive(csp, "base-uri")).toEqual(["'none'"]);
    expect(directive(csp, "form-action")).toEqual(["'none'"]);
    expect(directive(csp, "frame-ancestors")).toEqual(["'none'"]);
  });

  it("enables cross-origin isolation", () => {
    expect(productionHeaders["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(productionHeaders["Cross-Origin-Embedder-Policy"]).toBe("require-corp");
  });

  it("requires integrity for scripts in production but not in development", () => {
    expect(productionHeaders["Integrity-Policy"]).toBe("blocked-destinations=(script)");
    expect(devHeaders["Integrity-Policy"]).toBeUndefined();
  });

  it("uses the same headers in development apart from Integrity-Policy", () => {
    const { "Integrity-Policy": _, ...rest } = productionHeaders;
    expect(devHeaders).toEqual(rest);
  });

  it("serializes directives in order", () => {
    expect(
      serializeCsp([
        ["a", "1"],
        ["b", "2", "3"],
      ]),
    ).toBe("a 1; b 2 3");
  });
});

/**
 * True when an nginx configuration declares a types block without including mime.types.
 * A types block replaces nginx's whole inherited MIME map, so every other file would be served as application/octet-stream.
 */
function replacesMimeMap(conf: string): boolean {
  const lines = conf.split("\n").filter((line) => !/^\s*#/.test(line));
  const declaresTypes = lines.some((line) => /^\s*types\s*\{/.test(line));
  const includesMimeTypes = lines.some((line) => /^\s*include\s+\S*mime\.types\s*;/.test(line));
  return declaresTypes && !includesMimeTypes;
}

describe("sample nginx configuration", () => {
  const conf = readFileSync(new URL("../../deploy/nginx/security-headers.conf", import.meta.url), "utf8");
  const site = readFileSync(new URL("../../deploy/nginx/bayan-web.conf", import.meta.url), "utf8");
  const nginxHeaders = Object.fromEntries(
    [...conf.matchAll(/^add_header\s+(\S+)\s+"([^"]*)"\s+always;$/gm)].map((m) => [m[1], m[2]]),
  );

  it("sends exactly the production headers", () => {
    expect(nginxHeaders).toEqual(productionHeaders);
  });

  it("includes the headers in every location block that adds its own", () => {
    for (const block of site.split(/\n\s*location\s/).slice(1)) {
      if (block.includes("add_header")) {
        expect(block).toContain("include /etc/nginx/bayan-web/security-headers.conf;");
      }
    }
  });

  // Regression test: a server-level `types { application/wasm wasm; }` block made a stock nginx serve every file,
  // including index.html, as application/octet-stream, so browsers downloaded the page instead of showing it.
  it("keeps nginx's MIME map (no types block without include mime.types)", () => {
    expect(replacesMimeMap(site)).toBe(false);
  });

  it("detects a types block that would replace the MIME map", () => {
    expect(replacesMimeMap("server {\n    types {\n        application/wasm wasm;\n    }\n}\n")).toBe(true);
    expect(
      replacesMimeMap("server {\n    types {\n        include mime.types;\n        application/wasm wasm;\n    }\n}\n"),
    ).toBe(false);
    expect(replacesMimeMap("server {\n    # types { application/wasm wasm; }\n}\n")).toBe(false);
  });
});

describe("Vite configuration", () => {
  it("sends the development headers from the dev server and the production headers from the preview server", async () => {
    const { default: config } = await import("../../vite.config.ts");
    expect(config.server?.headers).toBe(devHeaders);
    expect(config.preview?.headers).toBe(productionHeaders);
  });
});
