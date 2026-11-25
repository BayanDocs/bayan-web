import { describe, expect, it } from "vitest";
import {
  checkEvent,
  checkReply,
  everyEntry,
  isEngineVersion,
  isId,
  isPlainObject,
  isRect,
  readEnvelope,
} from "../../src/engine/checks.ts";
import {
  MAX_COORDINATE,
  MAX_ID,
  MAX_INDEX,
  MAX_PAGES,
  MAX_TILE_SIDE,
  type RequestType,
} from "../../src/engine/protocol.ts";

// What the shell accepts from the engine (src/engine/checks.ts, engine protocol §14.1 item 5): each field of each message type the shell
// reads, and where each check draws its line. That a message failing these checks ends the engine's use is the client's part
// (tests/unit/engine-client.test.ts); the accessibility trees inside query.a11y and a11y.update are checked in tests/unit/a11y-tree.test.ts.

/** Stands in for an ImageBitmap, which Node.js does not have. */
class Bitmap {}
const isBitmap = (value: unknown) => value instanceof Bitmap;

/** A copy of `object` with `field` set to `value`, or without the field where `value` is `absent`. */
const absent = Symbol("absent");
function changed(object: Record<string, unknown>, field: string, value: unknown): Record<string, unknown> {
  const { [field]: _, ...rest } = object;
  return value === absent ? rest : { ...rest, [field]: value };
}

/** An array of `length` holes and no entries, as a sparse array's length makes it. */
function holes(length: number): unknown[] {
  const array: unknown[] = [];
  array.length = length;
  return array;
}
/** A sparse array: `entries`, then a hole at the end. */
function withHole(...entries: unknown[]): unknown[] {
  const array: unknown[] = [...entries];
  array.length = entries.length + 1;
  return array;
}

describe("the building blocks", () => {
  it("takes as an object only what structured clone makes of JSON: no array, no class, no other prototype", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    for (const value of [null, undefined, [], "x", 1, new Map(), new Date(0), Object.create({}), new Bitmap()]) {
      expect(isPlainObject(value), String(value)).toBe(false);
    }
  });

  it("takes as an identifier an integer from 1 to 2⁵³ − 1", () => {
    for (const value of [1, 2, MAX_ID]) expect(isId(value), String(value)).toBe(true);
    for (const value of [0, -1, 1.5, MAX_ID + 1, Number.NaN, Number.POSITIVE_INFINITY, "1", 1n, null]) {
      expect(isId(value), String(value)).toBe(false);
    }
  });

  it("takes as a rectangle integer edges within ±2⁴⁰ and a size that is not negative", () => {
    const rect = { x: -MAX_COORDINATE, y: MAX_COORDINATE, width: 0, height: MAX_COORDINATE };
    expect(isRect(rect)).toBe(true);
    expect(isRect(changed(rect, "x", -MAX_COORDINATE - 1))).toBe(false);
    expect(isRect(changed(rect, "y", MAX_COORDINATE + 1))).toBe(false);
    expect(isRect(changed(rect, "width", -1))).toBe(false);
    expect(isRect(changed(rect, "height", MAX_COORDINATE + 1))).toBe(false);
    expect(isRect(changed(rect, "height", 0.5))).toBe(false);
    expect(isRect(changed(rect, "y", absent))).toBe(false);
    expect(isRect([0, 0, 1, 1])).toBe(false);
  });

  it("takes as the engine's version 1 to 64 printable ASCII characters", () => {
    for (const value of ["0.1.0", "x", "x".repeat(64), "1.0 (abc)"]) expect(isEngineVersion(value), value).toBe(true);
    for (const value of ["", "x".repeat(65), "1.0\n", "1.0\u0000", "1.0é", "١٫٠", 1, null]) {
      expect(isEngineVersion(value), String(value)).toBe(false);
    }
  });

  it("counts an array's entries by index, so that a hole fails like the undefined it reads as", () => {
    const visited: number[] = [];
    expect(everyEntry(holes(3), (_, index) => visited.push(index) > 0)).toBe(true);
    expect(visited).toEqual([0, 1, 2]);
    expect(everyEntry(withHole("a"), (entry) => typeof entry === "string")).toBe(false);
    expect(everyEntry([], () => false)).toBe(true);
  });
});

/** For each reply type with fields: a payload that passes, and changes of one field that each make it fail. */
const replies: Partial<
  Record<RequestType, { readonly good: Record<string, unknown>; readonly bad: [string, unknown][] }>
> = {
  hello: {
    good: { protocol_version: 1, engine_version: "0.1.0", layout_epoch: 0, features: ["a", "b"] },
    bad: [
      ["protocol_version", -1],
      ["protocol_version", "1"],
      ["protocol_version", absent],
      ["engine_version", "x".repeat(65)],
      ["engine_version", ""],
      ["layout_epoch", absent],
      ["layout_epoch", 1.5],
      ["features", [1]],
      ["features", "a"],
      ["features", withHole("a")],
    ],
  },
  "ui.manifest": {
    good: {
      manifest_version: 1,
      locale: "en",
      ribbon: {},
      commands: [
        {
          id: "format.bold.toggle",
          label: "Bold",
          bindings: [{ key: "b", ctrl: true, shift: false, alt: false, meta: false, label: "Ctrl+B" }],
        },
        { id: "format.italic.toggle", label: "Italic", bindings: [], shell_action: null },
        { id: "clipboard.copy", label: "Copy", bindings: [], shell_action: "copy" },
      ],
      keys: {
        document: [{ key: "Enter" }],
        reserved: [
          { code: "KeyW", ctrl: true },
          { key: "Tab", alt: null },
        ],
      },
    },
    bad: [
      ["manifest_version", absent],
      ["locale", 1],
      ["ribbon", []],
      ["commands", {}],
      ["commands", withHole()],
      ["commands", [{ id: "x", label: "X", bindings: [], shell_action: 1 }]],
      ["commands", [{ id: "x", bindings: [] }]],
      // A binding names its key by key or by code, exactly one of them, with all four modifiers and its label.
      [
        "commands",
        [
          {
            id: "x",
            label: "X",
            bindings: [{ key: "b", code: "KeyB", ctrl: true, shift: false, alt: false, meta: false, label: "" }],
          },
        ],
      ],
      [
        "commands",
        [{ id: "x", label: "X", bindings: [{ ctrl: true, shift: false, alt: false, meta: false, label: "" }] }],
      ],
      [
        "commands",
        [
          {
            id: "x",
            label: "X",
            bindings: [{ key: "", ctrl: true, shift: false, alt: false, meta: false, label: "" }],
          },
        ],
      ],
      [
        "commands",
        [{ id: "x", label: "X", bindings: [{ key: "b", ctrl: true, shift: false, alt: false, label: "" }] }],
      ],
      [
        "commands",
        [
          {
            id: "x",
            label: "X",
            bindings: [{ key: "b", ctrl: "true", shift: false, alt: false, meta: false, label: "" }],
          },
        ],
      ],
      [
        "commands",
        [{ id: "x", label: "X", bindings: [{ key: "b", ctrl: true, shift: false, alt: false, meta: false }] }],
      ],
      // Document keys are named by key; a reserved key's modifiers are booleans where given.
      ["keys", { document: [{ code: "Enter" }], reserved: [] }],
      ["keys", { document: [{ key: "" }], reserved: [] }],
      ["keys", { document: [], reserved: [{ key: "Tab", alt: "yes" }] }],
      ["keys", { document: [], reserved: [{ key: "Tab", code: "Tab" }] }],
      ["keys", { document: [] }],
      ["keys", absent],
    ],
  },
  "doc.open": {
    good: {
      doc_id: 1,
      revision: 1,
      page_count_estimate: 0,
      warnings: [{ message_id: "warning-x", args: {} }],
      fonts: { missing: ["A font"], machine_dependent: false },
    },
    bad: [
      ["doc_id", 0],
      ["revision", absent],
      ["page_count_estimate", -1],
      ["warnings", [{ message_id: 1, args: {} }]],
      ["warnings", [{ message_id: "warning-x" }]],
      ["fonts", { missing: [] }],
      ["fonts", { missing: [1], machine_dependent: true }],
      ["fonts", absent],
    ],
  },
  "render.tile": {
    good: { bitmap: new Bitmap(), width: 1, height: MAX_TILE_SIDE, hash: "0f", revision: 3 },
    bad: [
      ["bitmap", {}],
      ["bitmap", absent],
      ["width", 0],
      ["width", MAX_TILE_SIDE + 1],
      ["height", 1.5],
      ["hash", absent],
      ["revision", 0],
      ["revision", absent],
    ],
  },
  "query.a11y": {
    good: { doc_id: 1, root: { id: 1, role: "document" }, caret: { node: 2, offset: 0 } },
    bad: [
      ["doc_id", absent],
      ["root", []],
      ["root", null],
      ["caret", { node: 0, offset: 0 }],
      ["caret", { node: 2, offset: -1 }],
      ["caret", absent],
    ],
  },
  "diag.record.stop": {
    good: { blob: new ArrayBuffer(8), entries: 3, truncated: false },
    bad: [
      ["blob", new Uint8Array(8)],
      ["entries", -1],
      ["truncated", 0],
    ],
  },
  "diag.replay": {
    good: { entries: 3, identical: false, first_difference: 2, tiles: [] },
    bad: [
      ["entries", absent],
      ["identical", "no"],
      ["first_difference", -1],
      ["tiles", {}],
    ],
  },
};

/** The reply types whose payload is empty: whatever a later version adds is left alone. */
const emptyReplies: RequestType[] = [
  "doc.close",
  "view.set",
  "input.pointer",
  "input.key",
  "input.text",
  "input.composition",
  "diag.record.start",
  "diag.panic",
];

describe("successful replies", () => {
  for (const [type, { good, bad }] of Object.entries(replies) as [
    RequestType,
    { good: Record<string, unknown>; bad: [string, unknown][] },
  ][]) {
    it(`${type}: passes with every field it needs, and fails when one is missing, of another type or out of range`, () => {
      expect(checkReply(type, good, isBitmap)).toBe(true);
      // Unknown fields are additions a later version may make (§9): they are left alone.
      expect(checkReply(type, { ...good, added_later: { anything: [1] } }, isBitmap)).toBe(true);
      for (const [field, value] of bad) {
        expect(checkReply(type, changed(good, field, value), isBitmap), `${field}: ${JSON.stringify(value)}`).toBe(
          false,
        );
      }
    });
  }

  it("query.a11y passes with a null caret, and diag.replay with a null first_difference", () => {
    expect(checkReply("query.a11y", { doc_id: 1, root: { id: 1, role: "document" }, caret: null }, isBitmap)).toBe(
      true,
    );
    expect(
      checkReply("diag.replay", { entries: 0, identical: true, first_difference: null, tiles: [] }, isBitmap),
    ).toBe(true);
  });

  it("an empty reply passes whatever it holds", () => {
    for (const type of emptyReplies) {
      expect(checkReply(type, {}, isBitmap), type).toBe(true);
      expect(checkReply(type, { added_later: 1 }, isBitmap), type).toBe(true);
    }
  });
});

const page = (index: number) => ({ index, width: 12_240, height: 15_840, section: 0, x: 0, y: index * 16_000 });

/** For each event type the shell reads: a payload that passes, and changes of one field that each make it fail. */
const events: Record<string, { readonly good: Record<string, unknown>; readonly bad: [string, unknown][] }> = {
  "view.layout.progress": {
    good: { doc_id: 1, pages_laid_out: 2, page_count_estimate: 3, complete: false },
    bad: [
      ["doc_id", 0],
      ["pages_laid_out", -1],
      ["page_count_estimate", absent],
      ["complete", "no"],
    ],
  },
  "view.pages": {
    good: { doc_id: 1, pages: [page(0), page(1)] },
    bad: [
      ["doc_id", absent],
      // Each page's index is its position.
      ["pages", [page(1)]],
      ["pages", [page(0), page(0)]],
      ["pages", [{ ...page(0), width: 0 }]],
      ["pages", [{ ...page(0), height: MAX_COORDINATE + 1 }]],
      ["pages", [{ ...page(0), section: -1 }]],
      ["pages", [{ ...page(0), x: MAX_COORDINATE + 1 }]],
      ["pages", withHole(page(0))],
      // More pages than the shell takes (MAX_PAGES in src/engine/protocol.ts), told by the length before any page is read.
      ["pages", holes(MAX_PAGES + 1)],
      ["pages", {}],
    ],
  },
  "render.invalidate": {
    good: { doc_id: 1, revision: 4, regions: [{ page: 0, rect: { x: 0, y: 0, width: 10, height: 10 } }] },
    bad: [
      ["revision", absent],
      ["revision", 0],
      ["regions", [{ page: -1, rect: { x: 0, y: 0, width: 10, height: 10 } }]],
      ["regions", [{ page: MAX_INDEX + 1, rect: { x: 0, y: 0, width: 10, height: 10 } }]],
      ["regions", [{ page: 0, rect: { x: 0, y: 0, width: -10, height: 10 } }]],
      ["regions", withHole()],
    ],
  },
  "overlay.update": {
    good: {
      doc_id: 1,
      revision: 4,
      caret: { page: 0, rect: { x: 1, y: 2, width: 0, height: 20 }, visible: true },
      selection: [{ page: 0, rects: [{ x: 1, y: 2, width: 30, height: 20 }] }],
      remote: [],
      highlights: [],
    },
    bad: [
      ["revision", absent],
      ["caret", { page: 0, rect: { x: 1, y: 2, width: 0, height: 20 } }],
      ["caret", absent],
      ["selection", [{ page: 0, rects: [{ x: 1, y: 2, width: 30 }] }]],
      ["selection", [{ page: 0, rects: withHole() }]],
      ["remote", absent],
      ["highlights", {}],
    ],
  },
  "a11y.update": {
    good: { doc_id: 1, changes: [{ kind: "replace", node: { id: 3, role: "paragraph" } }], caret: null },
    bad: [
      ["doc_id", absent],
      // "replace" is v1's only kind of change; another is not an addition v1 allows (§9).
      ["changes", [{ kind: "insert", node: { id: 3, role: "paragraph" } }]],
      ["changes", [{ kind: "replace" }]],
      ["changes", withHole()],
      ["caret", { node: 3 }],
    ],
  },
  "engine.error": {
    good: { code: "panic", message_id: "engine-error-panic", recoverable: false, args: {}, restart: null },
    bad: [
      ["code", absent],
      ["message_id", 1],
      ["recoverable", "false"],
      ["args", []],
    ],
  },
};

describe("events", () => {
  for (const [type, { good, bad }] of Object.entries(events)) {
    it(`${type}: passes with every field the shell reads, and fails when one is missing, of another type or out of range`, () => {
      expect(checkEvent(type, good)).toBe(true);
      expect(checkEvent(type, { ...good, added_later: true })).toBe(true);
      for (const [field, value] of bad) {
        const shown = Array.isArray(value) && value.length > 10 ? `${value.length} entries` : JSON.stringify(value);
        expect(checkEvent(type, changed(good, field, value)), `${field}: ${shown}`).toBe(false);
      }
    });
  }

  it("view.pages takes no pages at all", () => {
    expect(checkEvent("view.pages", { doc_id: 1, pages: [] })).toBe(true);
  });

  it("an event type the shell does not know passes, to be ignored (§9)", () => {
    expect(checkEvent("view.something_new", {})).toBe(true);
    expect(checkEvent("view.something_new", { anything: [null] })).toBe(true);
  });
});

describe("the envelope", () => {
  it("sorts the worker host's control messages, which carry no v", () => {
    expect(readEnvelope({ worker: "ready", engine_version: "0.1.0" })).toEqual({
      kind: "ready",
      engineVersion: "0.1.0",
    });
    expect(readEnvelope({ worker: "failed", reason: "wasm" })).toEqual({ kind: "failed", reason: "wasm" });
    expect(readEnvelope({ worker: "failed" })).toEqual({ kind: "failed", reason: "failed" });
    expect(readEnvelope({ worker: "something_new" })).toEqual({ kind: "control" });
    // The engine's version in ready is the one the status line shows: within §14.1 item 6's limit, or the message breaks the protocol.
    expect(readEnvelope({ worker: "ready", engine_version: "x".repeat(65) })).toEqual({ kind: "violation" });
    expect(readEnvelope({ worker: "ready" })).toEqual({ kind: "violation" });
  });

  it("sorts replies and events, leaving v to the caller and an absent payload empty", () => {
    expect(readEnvelope({ v: 1, re: 5, ok: true, type: "welcome", payload: { a: 1 } })).toEqual({
      kind: "reply",
      v: 1,
      re: 5,
      ok: true,
      payload: { a: 1 },
    });
    expect(readEnvelope({ v: 1, re: 5, ok: true })).toEqual({ kind: "reply", v: 1, re: 5, ok: true, payload: {} });
    const error = { code: "invalid_request", message_id: "engine-error-invalid-request", args: {} };
    expect(readEnvelope({ v: 1, re: 5, ok: false, error })).toEqual({ kind: "reply", v: 1, re: 5, ok: false, error });
    expect(readEnvelope({ v: 1, type: "render.invalidate", seq: 9, payload: { b: 2 } })).toEqual({
      kind: "event",
      v: 1,
      type: "render.invalidate",
      seq: 9,
      payload: { b: 2 },
    });
    // A version the shell does not speak is the caller's to refuse (the reply to hello is exempt, §14.1 item 1).
    expect(readEnvelope({ v: 0, re: 5, ok: true })).toMatchObject({ kind: "reply", v: 0 });
  });

  it("finds a violation in every envelope that breaks the protocol", () => {
    const broken: [string, unknown][] = [
      ["not an object", "render.invalidate"],
      ["an array", [1]],
      ["null", null],
      ["v missing", { re: 5, ok: true }],
      ["v not an integer", { v: 1.5, re: 5, ok: true }],
      ["v negative", { v: -1, re: 5, ok: true }],
      ["v a string", { v: "1", re: 5, ok: true }],
      ["a payload that is an array", { v: 1, re: 5, ok: true, payload: [] }],
      ["a payload that is null", { v: 1, re: 5, ok: true, payload: null }],
      ["re of 0", { v: 1, re: 0, ok: true }],
      ["re a string", { v: 1, re: "5", ok: true }],
      ["a reply's type not a string", { v: 1, re: 5, ok: true, type: 1 }],
      ["ok missing", { v: 1, re: 5 }],
      ["ok not a boolean", { v: 1, re: 5, ok: 1 }],
      ["a failed reply without its error", { v: 1, re: 5, ok: false }],
      ["a failed reply with an error of another shape", { v: 1, re: 5, ok: false, error: { code: "x" } }],
      ["an event without seq", { v: 1, type: "render.invalidate" }],
      ["an event without type", { v: 1, seq: 9 }],
      ["an event with seq 0", { v: 1, type: "render.invalidate", seq: 0 }],
      ["an event whose type is not a string", { v: 1, type: 1, seq: 9 }],
      // A message with v is a protocol message, whatever else it carries.
      ["a control field beside v", { v: 1, worker: "ready", engine_version: "0.1.0" }],
    ];
    for (const [what, data] of broken) expect(readEnvelope(data), what).toEqual({ kind: "violation" });
  });
});
