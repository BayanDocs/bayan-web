import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { conformanceFileNames } from "../../config/engine-files.ts";
import { checkTree } from "../../src/a11y/tree.ts";
import { checkReply } from "../../src/engine/checks.ts";
import {
  EngineClient,
  EngineRequestError,
  EngineSessionEndedError,
  EngineUnavailableError,
} from "../../src/engine/client.ts";
import { type EventType, PROTOCOL_VERSION, type Restart, type UiManifest } from "../../src/engine/protocol.ts";
import { decideKey, type KeyData, keyDataOf, sendsKey } from "../../src/input/keys.ts";
import { pagePixels, tileGrid, tileSpec } from "../../src/view/tiles.ts";

// The conformance vectors of engine protocol §15: shared test cases with their expected results, which bayan-core's tests check against
// the engine, its bindings and reference shells, and both shells against their own code. They are read from the engine package that the
// app pins (engine-package/conformance/, built by scripts/engine-package.sh from bayan-core.pin), never from a copy. Every case marked
// shell or web runs here, against the code the app runs:
// - restart.json: the messages a shell sends and receives around engine failures, through EngineClient (src/engine/client.ts), which sorts
//   every message from the engine into handle, ignore, restart and stop (§12.1, §14.2);
// - tile-grid.json: the page sizes and tile rectangles of src/view/tiles.ts (§14.6 item 3);
// - a11y-limits.json: which accessibility trees the shell accepts, and which parts of a node's children it asks for (src/a11y/tree.ts,
//   §14.7 item 1);
// - keys.json: which presses the shell sends to the engine (src/input/keys.ts), with the key data that the engine resolves for each
//   platform and runtime, which the file's engine cases hold (§14.3); the shell must be able to read the key data of every one of them.
// A case of these files that this test does not recognize, by its `for`, its fields, its inputs or its expectations, fails it, so that a
// new case cannot pass unnoticed (§15); cases for the engine, the bindings and the desktop shell are recognized and left to them. A vector
// file of the package that this test does not run fails it too, so that a new area cannot pass unnoticed either.

type Json = Record<string, unknown>;

/** A vector file of the pinned engine package, after the checks of its format that §15 gives. */
function vectorFile(area: string): Json {
  const file = JSON.parse(
    readFileSync(new URL(`../../engine-package/conformance/${area}.json`, import.meta.url), "utf8"),
  ) as Json;
  expect(Object.keys(file).sort()).toEqual([
    "area",
    "cases",
    "format",
    "format_version",
    "protocol_version",
    "removed",
  ]);
  expect(file).toMatchObject({
    format: "bayan-engine-conformance",
    format_version: 1,
    protocol_version: PROTOCOL_VERSION,
    area,
  });
  expect(Array.isArray(file["cases"]) && Array.isArray(file["removed"])).toBe(true);
  return file;
}

/** A kind of case a file may hold: its fields, and who it may be for. */
interface CaseKind {
  readonly fields: readonly string[];
  readonly for: readonly string[];
}

/** The cases of a file, each of which must be of one of the kinds given; throws on any other, naming it. */
function recognizedCases(file: Json, kinds: readonly CaseKind[]): Json[] {
  const ids = new Set<string>(file["removed"] as string[]);
  const cases = file["cases"] as Json[];
  for (const testCase of cases) {
    const id = String(testCase["id"]);
    const who = testCase["for"];
    const known = kinds.some(
      (kind) =>
        Object.keys(testCase).sort().join() === [...kind.fields].sort().join() &&
        Array.isArray(who) &&
        who.length > 0 &&
        new Set(who).size === who.length &&
        who.every((party) => kind.for.includes(party as string)),
    );
    if (!known || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) || ids.has(id) || typeof testCase["description"] !== "string") {
      throw new Error(`the case ${id} of ${String(file["area"])}.json is not one this test recognizes`);
    }
    ids.add(id);
  }
  return cases;
}

/** Whether a case is this shell's: marked shell or web. */
const isOurs = (testCase: Json) => (testCase["for"] as string[]).some((party) => party === "shell" || party === "web");

const keysOf = (value: unknown) => Object.keys(value as Json).sort();

/** A stand-in for the engine's worker host. */
class FakeWorker extends EventTarget {
  readonly posted: Json[] = [];
  terminated = false;
  postMessage(message: Json): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
}

const eventTypes: EventType[] = [
  "view.layout.progress",
  "view.pages",
  "render.invalidate",
  "overlay.update",
  "a11y.update",
  "engine.error",
];

/** Lets the client's promises settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("conformance vectors (engine protocol §15)", () => {
  it("restart.json: every shell and web case, through the client", async () => {
    const cases = recognizedCases(vectorFile("restart"), [
      { fields: ["id", "description", "for", "steps"], for: ["shell", "web", "desktop"] },
      { fields: ["id", "description", "for", "failures_ms", "expect"], for: ["binding"] },
      {
        fields: ["id", "description", "for", "runtime", "config", "messages", "replays", "expect"],
        for: ["binding"],
      },
    ]);
    let run = 0;
    for (const testCase of cases) {
      const who = testCase["for"] as string[];
      if (!isOurs(testCase)) continue;
      const id = String(testCase["id"]);
      const worker = new FakeWorker();
      const client = new EngineClient(worker as unknown as Worker, { isBitmap: () => false });
      const restarts: Restart[] = [];
      client.onRestart((restart) => restarts.push(restart));
      let events = 0;
      for (const type of eventTypes) client.on(type, () => (events += 1));
      /** How each request settled: with the engine's answer, as part of a session that ended, or because the client stopped. */
      const settled = new Map<number, "answered" | "ended" | "stopped">();
      for (const [index, step] of (testCase["steps"] as Json[]).entries()) {
        const where = `${id}, step ${index}`;
        if (keysOf(step).join() === "shell_sends") {
          const message = step["shell_sends"] as Json;
          expect(message["v"], where).toBe(PROTOCOL_VERSION);
          const type = message["type"] as "hello";
          const payload = message["payload"] as never;
          if (message["id"] === undefined) {
            client.send(type, payload);
            continue;
          }
          const request = client.request(type, payload);
          // The client numbers its requests as the vector does.
          expect(worker.posted.at(-1)?.["id"], where).toBe(message["id"]);
          const requestId = message["id"] as number;
          request.then(
            () => settled.set(requestId, "answered"),
            (error: unknown) =>
              settled.set(
                requestId,
                error instanceof EngineRequestError
                  ? "answered"
                  : error instanceof EngineSessionEndedError
                    ? "ended"
                    : error instanceof EngineUnavailableError
                      ? "stopped"
                      : "answered",
              ),
          );
          continue;
        }
        // On the web the worker host's control messages come too (§3.2); the desktop has none.
        const kind = keysOf(step).join();
        expect(
          kind === "engine_sends,expect" || (kind === "expect,worker_sends" && who.includes("web")),
          `${where}: a step of an unknown kind`,
        ).toBe(true);
        const message = (step["engine_sends"] ?? step["worker_sends"]) as Json;
        const expected = step["expect"];
        const before = { events, restarts: restarts.length, answered: settled.get(message["re"] as number) };
        worker.dispatchEvent(new MessageEvent("message", { data: structuredClone(message) }));
        await settle();
        const stopped = client.state.kind === "failed";
        const answered =
          message["re"] !== undefined &&
          before.answered !== "answered" &&
          settled.get(message["re"] as number) === "answered";
        const delivered = events > before.events;
        const restarted = restarts.length > before.restarts;
        if (expected === "handle") {
          expect(message["re"] === undefined ? delivered : answered, `${where}: handled`).toBe(true);
          expect(stopped || restarted, `${where}: handled, and nothing else`).toBe(false);
        } else if (expected === "ignore") {
          expect(answered || delivered || restarted || stopped, `${where}: ignored`).toBe(false);
        } else if (expected === "stop") {
          expect(stopped && worker.terminated, `${where}: stopped`).toBe(true);
          expect(restarted, `${where}: stopped without a restart`).toBe(false);
        } else {
          expect(keysOf(expected), `${where}: an unknown expectation`).toEqual(["restart"]);
          const restart = (expected as Json)["restart"] as Json;
          expect(keysOf(restart), `${where}: an unknown expectation`).toEqual(["limit", "number"]);
          expect(restarts.slice(before.restarts), where).toEqual([restart]);
          expect(stopped || delivered, `${where}: a restart, and nothing else`).toBe(false);
        }
      }
      run += 1;
    }
    expect(run).toBeGreaterThanOrEqual(7);
  });

  it("tile-grid.json: every case, against the compositor's tile grid", () => {
    const cases = recognizedCases(vectorFile("tile-grid"), [
      { fields: ["id", "description", "for", "page", "zoom", "device_scale", "tile_size", "expect"], for: ["shell"] },
    ]);
    const rect = ["height", "width", "x", "y"];
    for (const testCase of cases) {
      const id = String(testCase["id"]);
      // Exactly the fields this test checks, so that one a later version of the vectors adds cannot go unchecked.
      const expected = testCase["expect"] as Json;
      const tiles = expected["tiles"] as Json[];
      expect(keysOf(testCase["page"]), id).toEqual(["height", "width"]);
      expect(keysOf(expected), id).toEqual(["columns", "pixels", "rows", "tiles"]);
      expect(keysOf(expected["pixels"]), id).toEqual(["height", "width"]);
      for (const tile of tiles) {
        expect(keysOf(tile), id).toEqual(["blu", "column", "pixels", "row"]);
        expect(keysOf(tile["pixels"]), id).toEqual(rect);
        expect(keysOf(tile["blu"]), id).toEqual(rect);
      }
      const size = testCase["page"] as { width: number; height: number };
      const page = { index: 0, width: size.width, height: size.height, section: 0, x: 0, y: 0 };
      // s = zoom × device scale, in double precision (§14.6 item 3).
      const scale = (testCase["zoom"] as number) * (testCase["device_scale"] as number);
      const tileSize = testCase["tile_size"] as number;
      expect(pagePixels(page, scale), id).toEqual(expected["pixels"]);
      expect(tileGrid(page, scale, tileSize), id).toEqual({ columns: expected["columns"], rows: expected["rows"] });
      for (const tile of tiles) {
        const spec = tileSpec(page, scale, tile["column"] as number, tile["row"] as number, tileSize);
        const where = `${id}: tile ${String(tile["column"])},${String(tile["row"])}`;
        expect({ x: spec.offsetX, y: spec.offsetY, width: spec.width, height: spec.height }, where).toEqual(
          tile["pixels"],
        );
        expect(spec.rect, where).toEqual(tile["blu"]);
      }
    }
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  it("a11y-limits.json: every shell case, against the checks of accessibility trees", () => {
    const cases = recognizedCases(vectorFile("a11y-limits"), [
      { fields: ["id", "description", "for", "root_level", "tree", "expect"], for: ["shell"] },
      { fields: ["id", "description", "for", "tree", "expect"], for: ["engine"] },
      { fields: ["id", "description", "for", "tree", "caret", "expect"], for: ["engine"] },
      { fields: ["id", "description", "for", "tree", "query", "expect"], for: ["engine"] },
    ]);
    let run = 0;
    for (const testCase of cases) {
      if (!isOurs(testCase)) continue;
      const id = String(testCase["id"]);
      const expected = testCase["expect"] as Json;
      expect(keysOf(expected), `${id}: an unknown expectation`).toEqual(["accept", "queries"]);
      const checked = checkTree(generatedTree(testCase["tree"] as Json, id), testCase["root_level"] as number);
      expect(checked !== null, id).toBe(expected["accept"]);
      const queries = (checked?.gaps ?? []).map((gap) => ({
        node: gap.node,
        children: { start: gap.start, count: gap.count },
      }));
      expect(queries, id).toEqual(expected["queries"]);
      run += 1;
    }
    expect(run).toBeGreaterThanOrEqual(10);
  });

  it("keys.json: every shell case, against the key decision, with the key data of every platform and runtime", () => {
    const cases = recognizedCases(vectorFile("keys"), [
      { fields: ["id", "description", "for", "platform", "runtime", "expect"], for: ["engine"] },
      { fields: ["id", "description", "for", "manifest", "layout", "press", "expect"], for: ["engine", "shell"] },
    ]);
    // The key data the engine resolves for each platform and runtime: the client must accept each as the reply to ui.manifest.
    const manifests = new Map<string, KeyData>();
    for (const testCase of cases) {
      if (!("platform" in testCase)) continue;
      const expected = testCase["expect"] as Json;
      expect(keysOf(expected)).toEqual(["commands", "keys"]);
      const reply = { manifest_version: 0, locale: "en-US", ...expected, ribbon: { tabs: [] } };
      expect(
        checkReply("ui.manifest", reply, () => false),
        String(testCase["id"]),
      ).toBe(true);
      manifests.set(String(testCase["id"]), keyDataOf(reply as unknown as UiManifest));
    }
    expect(manifests.size).toBe(14);
    let run = 0;
    for (const testCase of cases) {
      if (!isOurs(testCase)) continue;
      const id = String(testCase["id"]);
      const press = testCase["press"] as Json;
      expect(keysOf(press), `${id}: a press with unknown fields`).toEqual([
        "alt",
        "code",
        "composing",
        "ctrl",
        "key",
        "meta",
        "shift",
      ]);
      const expected = testCase["expect"] as Json;
      expect(keysOf(expected), `${id}: an unknown expectation`).toEqual(["runs", "send"]);
      const keys = manifests.get(String(testCase["manifest"]));
      expect(keys, `${id}: no manifest case ${String(testCase["manifest"])}`).toBeDefined();
      const fields = {
        key: press["key"] as string,
        code: press["code"] as string,
        ctrlKey: press["ctrl"] as boolean,
        shiftKey: press["shift"] as boolean,
        altKey: press["alt"] as boolean,
        metaKey: press["meta"] as boolean,
      };
      const composing = press["composing"] as boolean;
      expect(sendsKey({ ...fields, composing }, keys as KeyData), id).toBe(expected["send"]);
      // And the keydown handler's view of the same press: it sends input.key, and stops the browser's default, exactly then.
      const decision = decideKey({ ...fields, keyCode: 0, isComposing: composing, repeat: false }, keys as KeyData);
      expect(decision !== null, `${id}: the keydown handler`).toBe(expected["send"]);
      run += 1;
    }
    expect(run).toBeGreaterThanOrEqual(30);
  });

  it("runs every vector file of the pinned package, the files that check:engine requires", () => {
    // The areas of the tests above, one each.
    const areas = ["restart", "tile-grid", "a11y-limits", "keys"];
    // conformance.schema.json describes the files' format; every other file holds the vectors of one area.
    const files = readdirSync(new URL("../../engine-package/conformance/", import.meta.url));
    expect(files.filter((name) => name !== "conformance.schema.json").sort()).toEqual(
      areas.map((area) => `${area}.json`).sort(),
    );
    expect([...conformanceFileNames].sort()).toEqual(areas.map((area) => `conformance/${area}.json`).sort());
  });

  it("fails on a case or a file it does not recognize", () => {
    const file = vectorFile("restart");
    const kinds = [{ fields: ["id", "description", "for", "steps"], for: ["shell"] }];
    // The binding cases are of a kind that this list leaves out.
    expect(() => recognizedCases(file, kinds)).toThrow(/is not one this test recognizes/);
    const shellCase = (file["cases"] as Json[]).find((testCase) => isOurs(testCase)) as Json;
    expect(() => recognizedCases({ ...file, cases: [{ ...shellCase, extra: true }] }, kinds)).toThrow(
      /not one this test/,
    );
    expect(() => recognizedCases({ ...file, cases: [{ ...shellCase, for: ["shell", "someone"] }] }, kinds)).toThrow(
      /not one this test/,
    );
    expect(() => recognizedCases({ ...file, cases: [shellCase, shellCase] }, kinds)).toThrow(/not one this test/);
    expect(() => generatedTree({ generator: "spiral", depth: 3 }, "x")).toThrow(/unknown generator/);
    expect(() => generatedTree({ generator: "chain", depth: 3, extra: 1 }, "x")).toThrow(/unknown generator/);
  });
});

/** A paragraph of the generated trees. */
const paragraph = (id: number, text: string): Json => ({ id, role: "paragraph", text });

/**
 * The tree that a case's generator describes (the generator's description in conformance.schema.json): `chain`, the document node (id 1,
 * no text) and below it one paragraph per level down to `depth`, the node at level L with id L and text L in decimal; `wide`, the
 * document node holding `children` paragraphs, child i with id i + 2 and text i in decimal or `text_units` letters x, and with
 * `child_count`, those children from index `children_start` (default 0) of `child_count` in all.
 */
function generatedTree(tree: Json, id: string): Json {
  const document: Json = { id: 1, role: "document" };
  const fields = keysOf(tree);
  if (tree["generator"] === "chain" && fields.join() === "depth,generator") {
    let below: Json | undefined;
    for (let level = tree["depth"] as number; level >= 2; level -= 1) {
      const node = paragraph(level, String(level));
      if (below !== undefined) node["children"] = [below];
      below = node;
    }
    if (below !== undefined) document["children"] = [below];
    return document;
  }
  const wide = ["child_count", "children", "children_start", "generator", "text_units"];
  if (tree["generator"] === "wide" && "children" in tree && fields.every((field) => wide.includes(field))) {
    const held = tree["children"] as number;
    const start = (tree["children_start"] as number | undefined) ?? 0;
    const units = (tree["text_units"] as number | undefined) ?? 0;
    const children: Json[] = [];
    for (let index = start; index < start + held; index += 1) {
      children.push(paragraph(index + 2, units > 0 ? "x".repeat(units) : String(index)));
    }
    if ("child_count" in tree) {
      document["child_count"] = tree["child_count"];
      if (held > 0) document["children_start"] = start;
    }
    if (held > 0 || !("child_count" in tree)) document["children"] = children;
    return document;
  }
  throw new Error(`${id}: a tree of an unknown generator`);
}
