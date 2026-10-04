import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addIntegrity, sriHash, unhashedScripts } from "../../scripts/sri.ts";

const assets: Record<string, string> = {
  "assets/app.js": "console.log(1)",
  "assets/app.css": "body{}",
  "assets/chunk.js": "export {}",
};
const read = (path: string) => {
  const content = assets[path];
  if (content === undefined) throw new Error(`missing ${path}`);
  return new TextEncoder().encode(content);
};
const expected = (path: string) =>
  `sha384-${createHash("sha384")
    .update(assets[path] ?? "")
    .digest("base64")}`;

describe("addIntegrity", () => {
  it("hashes module scripts, stylesheets and module preloads", () => {
    const html = [
      '<script type="module" crossorigin src="/assets/app.js"></script>',
      '<link rel="stylesheet" crossorigin href="/assets/app.css">',
      '<link rel="modulepreload" href="/assets/chunk.js" />',
      '<link rel="icon" href="/favicon.svg" />',
    ].join("\n");
    const result = addIntegrity(html, read);
    expect(result.html).toContain(`src="/assets/app.js" integrity="${expected("assets/app.js")}"></script>`);
    expect(result.html).toContain(`href="/assets/app.css" integrity="${expected("assets/app.css")}">`);
    expect(result.html).toContain(`href="/assets/chunk.js" integrity="${expected("assets/chunk.js")}" crossorigin/>`);
    expect(result.html).toContain('<link rel="icon" href="/favicon.svg" />');
    expect(result.hashed).toEqual(["assets/app.js", "assets/app.css", "assets/chunk.js"]);
  });

  it("refuses inline scripts", () => {
    expect(() => addIntegrity("<script>alert(1)</script>", read)).toThrow(/inline/);
  });

  it("refuses third-party, protocol-relative and traversing URLs", () => {
    for (const src of ["https://cdn.example/x.js", "//cdn.example/x.js", "/../etc/passwd", "/assets/app.js?v=1"]) {
      expect(() => addIntegrity(`<script src="${src}"></script>`, read)).toThrow(/same-origin/);
    }
  });

  it("refuses to run twice", () => {
    const once = addIntegrity('<script src="/assets/app.js"></script>', read).html;
    expect(() => addIntegrity(once, read)).toThrow(/already/);
  });
});

describe("unhashedScripts", () => {
  it("lists JavaScript files the page would load without a hash", () => {
    expect(unhashedScripts(["assets/app.js", "assets/lazy.js", "assets/app.css"], ["assets/app.js"])).toEqual([
      "assets/lazy.js",
    ]);
  });
});

describe("sriHash", () => {
  it("matches the SRI format for a known input", () => {
    expect(sriHash(new TextEncoder().encode("a"))).toBe(
      "sha384-VKWbnyKwuAiA2EJ+VIt8I6vYc0huHwNdzpzWl+hRdQM8qojm1XvDXvrgta/TFF8x",
    );
  });
});
