import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  engineManifest,
  integrityOf,
  noticeFileNames,
  parsePin,
  readEngineBuild,
  runtimeFileNames,
  runtimeFolder,
} from "../../config/engine-files.ts";
import { checkEngine } from "../../scripts/check-engine.ts";
import { engineScripts, unhashedScripts } from "../../scripts/sri.ts";

const commit = "e7d6f1e1da00df143f88a6a00e041fc3bc188e3f";
const folders: string[] = [];

/** A stand-in for the engine package, with the files the app serves. */
function fakePackage(changes: Record<string, string | null> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "engine-package-"));
  folders.push(dir);
  const files: Record<string, string | null> = {
    "BUILT-FROM": `commit=${commit}\n`,
    "package.json": JSON.stringify({ name: "@bayandocs/engine-wasm", version: "0.0.0" }),
    "engine-protocol.d.ts": "export type ProtocolVersion = 0;\n",
    ...Object.fromEntries([...runtimeFileNames, ...noticeFileNames].map((name) => [name, `contents of ${name}`])),
    ...changes,
  };
  for (const [name, content] of Object.entries(files)) {
    if (content === null) continue;
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the pin", () => {
  it("is exactly one line commit=<40 lowercase hex digits>", () => {
    expect(parsePin(`# comment\ncommit=${commit}\n`, "pin")).toBe(commit);
    for (const text of [
      "",
      `commit=${commit.toUpperCase()}`,
      `commit=${commit.slice(1)}`,
      `commit=${commit}\ncommit=${commit}`,
    ]) {
      expect(() => parsePin(text, "pin")).toThrow(/exactly one line/);
    }
  });
});

describe("the engine build", () => {
  it("serves the runtime files from one content-addressed folder and the notices from engine-licenses/", () => {
    const build = readEngineBuild(fakePackage());
    const folder = build.runtime["bayan-worker.js"].path.replace(/\/[^/]+$/, "");
    expect(folder).toMatch(/^assets\/engine-[0-9a-f]{16}$/);
    for (const name of runtimeFileNames) expect(build.runtime[name].path).toBe(`${folder}/${name}`);
    expect(build.notices.map((file) => file.path)).toEqual(noticeFileNames.map((name) => `engine-licenses/${name}`));
    expect(build.runtime["bayan_wasm_bg.wasm"].integrity).toBe(
      integrityOf(new TextEncoder().encode("contents of bayan_wasm_bg.wasm")),
    );
  });

  it("moves to a new folder when any runtime file changes", () => {
    const one = readEngineBuild(fakePackage()).runtime["bayan-worker.js"].path;
    const other = readEngineBuild(fakePackage({ "bayan_wasm_bg.wasm": "another engine" })).runtime["bayan-worker.js"]
      .path;
    expect(one).not.toBe(other);
    expect(runtimeFolder([{ name: "a", integrity: "x" }])).toBe(runtimeFolder([{ name: "a", integrity: "x" }]));
  });

  it("gives the app absolute same-origin paths and integrity hashes", () => {
    const manifest = engineManifest(readEngineBuild(fakePackage()));
    expect(manifest.commit).toBe(commit);
    expect(manifest.worker.url).toMatch(/^\/assets\/engine-[0-9a-f]{16}\/bayan-worker\.js$/);
    expect(manifest.wasm.integrity).toMatch(/^sha384-/);
    expect(manifest.notices.url).toBe("/engine-licenses/THIRD-PARTY-LICENSES.txt");
  });

  it("refuses a package that is not bayan-core's engine package, or lacks a file, with instructions", () => {
    expect(() =>
      readEngineBuild(fakePackage({ "package.json": JSON.stringify({ name: "other", version: "1" }) })),
    ).toThrow(/@bayandocs\/engine-wasm/);
    expect(() => readEngineBuild(fakePackage({ "bayan_wasm.js": null }))).toThrow(/scripts\/engine-package\.sh/);
  });
});

describe("check-engine", () => {
  it("accepts a package built from the pinned commit", () => {
    expect(checkEngine(fakePackage(), `commit=${commit}\n`)).toEqual([]);
  });

  it("refuses a package built from another commit, or a missing one", () => {
    const other = "0".repeat(40);
    expect(checkEngine(fakePackage(), `commit=${other}\n`)[0]).toMatch(/run scripts\/engine-package\.sh/);
    expect(checkEngine(join(tmpdir(), "no-such-engine-package"), `commit=${commit}\n`)[0]).toMatch(/missing/);
  });
});

describe("SRI's exception for the engine (scripts/sri.ts)", () => {
  const build = () => readEngineBuild(fakePackage());

  it("accepts exactly the engine's two scripts, unchanged, and still reports every other unhashed script", () => {
    const engine = build();
    const files = new Map(Object.values(engine.runtime).map((file) => [file.path, file.bytes]));
    const exempt = engineScripts(engine, (path) => files.get(path));
    expect(exempt.sort()).toEqual(
      [engine.runtime["bayan-worker.js"].path, engine.runtime["bayan_wasm.js"].path].sort(),
    );
    const folder = exempt[0]?.replace(/\/[^/]+$/, "");
    const built = [...files.keys(), "assets/index.js", `${folder}/extra.js`, "assets/lazy.js"];
    expect(unhashedScripts(built, ["assets/index.js", ...exempt])).toEqual([`${folder}/extra.js`, "assets/lazy.js"]);
  });

  it("fails when an engine script differs from the package by a single byte, or is missing", () => {
    const engine = build();
    const worker = engine.runtime["bayan-worker.js"];
    const changed = (path: string) =>
      path === worker.path
        ? new TextEncoder().encode("contents of bayan-worker.jS")
        : engine.runtime["bayan_wasm.js"].bytes;
    expect(() => engineScripts(engine, changed)).toThrow(/differs from the engine package/);
    expect(() => engineScripts(engine, () => undefined)).toThrow(/missing from the build/);
  });
});
