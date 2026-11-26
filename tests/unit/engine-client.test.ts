import { describe, expect, it } from "vitest";
import {
  EngineClient,
  EngineRequestError,
  EngineSessionEndedError,
  EngineUnavailableError,
} from "../../src/engine/client.ts";

// The main thread's side of engine protocol v1 (src/engine/client.ts): its envelopes, the checks of everything the worker sends (§14.1
// item 5), refused hellos (§14.1 item 3) and restarts (§14.2). The conformance vectors of restart.json run through the same client in
// conformance.test.ts.

/** A stand-in for the engine's worker: records what the client posts and lets the test answer. */
class FakeWorker extends EventTarget {
  readonly posted: unknown[] = [];
  terminated = false;
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  answer(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

/** Stands in for an ImageBitmap, which Node.js lacks: its size, and nothing else. */
class FakeBitmap {
  readonly width: number;
  readonly height: number;
  constructor(width = 1, height = 1) {
    this.width = width;
    this.height = height;
  }
}

function setup() {
  const worker = new FakeWorker();
  let now = 0;
  const client = new EngineClient(worker as unknown as Worker, {
    now: () => now,
    isBitmap: (value) => value instanceof FakeBitmap,
  });
  return { worker, client, advance: (ms: number) => (now += ms) };
}

const welcome = { protocol_version: 1, engine_version: "0.0.0", layout_epoch: 0, features: ["mock_document"] };

const opened = {
  doc_id: 1,
  revision: 1,
  page_count_estimate: 3,
  warnings: [],
  fonts: { missing: [], machine_dependent: false },
};

/** A client whose session has started and opened document 1: hello (id 1) and doc.open (id 2) answered; the next id is 3. */
async function connected() {
  const context = setup();
  const hello = context.client.request("hello", { protocol_versions: [1] });
  context.worker.answer({ v: 1, re: 1, ok: true, type: "welcome", payload: welcome });
  await hello;
  const open = context.client.request("doc.open", { blob: new ArrayBuffer(0) });
  context.worker.answer({ v: 1, re: 2, ok: true, type: "doc.opened", payload: opened });
  await open;
  return context;
}

const invalidate = { doc_id: 1, revision: 2, regions: [{ page: 0, rect: { x: 0, y: 0, width: 10, height: 10 } }] };

describe("EngineClient", () => {
  it("sends requests in the envelope of spec §4 with v 1 and increasing ids, and resolves each with its own reply", async () => {
    const { worker, client, advance } = setup();
    const trips: [string, number][] = [];
    client.onRoundTrip = (type, ms) => trips.push([type, ms]);
    const hello = client.request("hello", { protocol_versions: [1] });
    const open = client.request("doc.close", { doc_id: 3 });
    expect(worker.posted).toEqual([
      { v: 1, id: 1, type: "hello", payload: { protocol_versions: [1] } },
      { v: 1, id: 2, type: "doc.close", payload: { doc_id: 3 } },
    ]);
    advance(3);
    worker.answer({ v: 1, re: 1, ok: true, type: "welcome", payload: welcome });
    worker.answer({ v: 1, re: 2, ok: true, payload: {} });
    await expect(hello).resolves.toEqual(welcome);
    await expect(open).resolves.toEqual({});
    expect(trips).toEqual([
      ["hello", 3],
      ["doc.close", 3],
    ]);
  });

  it("leaves out an empty payload, and sends messages without an id when asked", () => {
    const { worker, client } = setup();
    void client.request("diag.record.start");
    client.send("input.text", { doc_id: 1, text: "a" });
    expect(worker.posted).toEqual([
      { v: 1, id: 1, type: "diag.record.start" },
      { v: 1, type: "input.text", payload: { doc_id: 1, text: "a" } },
    ]);
  });

  it("rejects with the engine's error code, which never carries document content, and goes on", async () => {
    const { worker, client } = await connected();
    const close = client.request("doc.close", { doc_id: 9 });
    worker.answer({
      v: 1,
      re: 3,
      ok: false,
      error: { code: "not_found", message_id: "engine-error-not-found", args: {} },
    });
    const error = await close.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineRequestError);
    expect((error as EngineRequestError).info.code).toBe("not_found");
    // An error in the reply to any request but hello ends nothing (§14.1 item 4).
    expect(client.state.kind).toBe("starting");
    expect(worker.terminated).toBe(false);
  });

  it("hands the current session's events to their listeners, and leaves unknown types and fields alone", async () => {
    const { worker, client } = await connected();
    const seen: unknown[] = [];
    const stop = client.on("render.invalidate", (payload) => seen.push(payload));
    worker.answer({ v: 1, type: "render.invalidate", seq: 1, payload: { ...invalidate, later: "field" } });
    worker.answer({ v: 1, type: "some.later.event", seq: 2, payload: { anything: [1, 2] } });
    // A reply to a request that the shell no longer waits for is no violation either.
    worker.answer({ v: 1, re: 99, ok: true, payload: {} });
    stop();
    worker.answer({ v: 1, type: "render.invalidate", seq: 3, payload: invalidate });
    expect(seen).toEqual([{ ...invalidate, later: "field" }]);
    expect(client.state.kind).toBe("starting");
  });

  it("follows the worker host's control messages, and rejects everything pending when it fails", async () => {
    const { worker, client } = setup();
    const states: string[] = [];
    client.onState((state) => states.push(state.kind));
    const pending = client.request("hello", { protocol_versions: [1] });
    worker.answer({ worker: "ready", engine_version: "0.0.0" });
    worker.answer({ worker: "failed", reason: "restart_failed" });
    await expect(pending).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(client.request("hello", { protocol_versions: [1] })).rejects.toBeInstanceOf(EngineUnavailableError);
    expect(states).toEqual(["ready", "failed"]);
    expect(client.state).toEqual({ kind: "failed", reason: "worker_failed" });
    // After "failed" the worker host ignores every message, and the shell terminates the worker (spec §3.2).
    expect(worker.terminated).toBe(true);
  });

  it("treats a worker that cannot load, or a module that fails before the engine is ready, as an engine that could not start", () => {
    const first = setup();
    first.worker.dispatchEvent(new Event("error", { cancelable: true }));
    expect(first.client.state).toEqual({ kind: "failed", reason: "load_failed" });
    expect(first.worker.terminated).toBe(true);
    // The worker host's answer when the module does not match wasm_integrity (§14.8).
    const second = setup();
    second.worker.answer({ worker: "failed", reason: "load_failed" });
    expect(second.client.state).toEqual({ kind: "failed", reason: "load_failed" });
  });

  it("treats a worker error after the engine was ready as a failed worker, as the worker host's own failed message", async () => {
    const { worker, client } = setup();
    const pending = client.request("hello", { protocol_versions: [1] });
    worker.answer({ worker: "ready", engine_version: "0.0.0" });
    expect(client.state).toEqual({ kind: "ready", engineVersion: "0.0.0" });
    const error = new Event("error", { cancelable: true });
    worker.dispatchEvent(error);
    expect(error.defaultPrevented).toBe(true);
    expect(client.state).toEqual({ kind: "failed", reason: "worker_failed" });
    expect(worker.terminated).toBe(true);
    await expect(pending).rejects.toBeInstanceOf(EngineUnavailableError);
  });
});

describe("protocol violations (spec §14.1 item 5)", () => {
  /** Every kind of message that breaks the protocol, each arriving in a session that has started. */
  const violations: Record<string, unknown> = {
    "a message that is not an object": 7,
    null: null,
    "an array": [1],
    "an object that is not a plain object": new Date(0),
    "a v of the wrong type": { v: "1", type: "render.invalidate", seq: 1, payload: invalidate },
    "an event of another version": { v: 0, type: "render.invalidate", seq: 1, payload: invalidate },
    "an event of a later version": { v: 2, type: "render.invalidate", seq: 1, payload: invalidate },
    "an event without v": { type: "render.invalidate", seq: 1, payload: invalidate },
    "an event without type": { v: 1, seq: 1, payload: invalidate },
    "an event without seq": { v: 1, type: "render.invalidate", payload: invalidate },
    "a seq of the wrong type": { v: 1, type: "render.invalidate", seq: "1", payload: invalidate },
    "a payload that is not an object": { v: 1, type: "render.invalidate", seq: 1, payload: [] },
    "a re of the wrong type": { v: 1, re: "1", ok: true, payload: {} },
    "a reply without ok": { v: 1, re: 1, payload: {} },
    "a failed reply without an error": { v: 1, re: 1, ok: false },
    "an error without a code": { v: 1, re: 1, ok: false, error: { message_id: "x", args: {} } },
    "a reply of another version": { v: 0, re: 5, ok: true, payload: {} },
    "an invalidation without its revision": {
      v: 1,
      type: "render.invalidate",
      seq: 1,
      payload: { doc_id: 1, regions: [] },
    },
    "a region of the wrong type": {
      v: 1,
      type: "render.invalidate",
      seq: 1,
      payload: { doc_id: 1, revision: 2, regions: [{ page: 0, rect: { x: 0, y: 0, width: "10", height: 1 } }] },
    },
    "a rectangle beyond the coordinate limit": {
      v: 1,
      type: "render.invalidate",
      seq: 1,
      payload: { doc_id: 1, revision: 2, regions: [{ page: 0, rect: { x: 2 ** 41, y: 0, width: 1, height: 1 } }] },
    },
    "pages that do not count from 0": {
      v: 1,
      type: "view.pages",
      seq: 1,
      payload: { doc_id: 1, pages: [{ index: 1, width: 1, height: 1, section: 0, x: 0, y: 0 }] },
    },
    "an overlay without its revision": {
      v: 1,
      type: "overlay.update",
      seq: 1,
      payload: { doc_id: 1, caret: null, selection: [], remote: [], highlights: [] },
    },
    "an a11y.update with a change of an unknown kind": {
      v: 1,
      type: "a11y.update",
      seq: 1,
      payload: { doc_id: 1, changes: [{ kind: "insert", node: { id: 2, role: "paragraph" } }], caret: null },
    },
    "an a11y.update with a caret of the wrong type": {
      v: 1,
      type: "a11y.update",
      seq: 1,
      payload: { doc_id: 1, changes: [], caret: { node: "5", offset: 0 } },
    },
    "an engine.error whose recoverable is not a boolean": {
      v: 1,
      type: "engine.error",
      seq: 1,
      payload: { code: "panic", message_id: "engine-error-panic", recoverable: "no", args: {} },
    },
    "an engine.error with recoverable false and no restart": {
      v: 1,
      type: "engine.error",
      seq: 1,
      payload: { code: "panic", message_id: "engine-error-panic", recoverable: false, args: {} },
    },
    "an engine.error with a restart beyond its limit": {
      v: 1,
      type: "engine.error",
      seq: 1,
      payload: {
        code: "panic",
        message_id: "engine-error-panic",
        recoverable: false,
        args: {},
        restart: { number: 4, limit: 3 },
      },
    },
  };

  for (const [what, message] of Object.entries(violations)) {
    it(`ends the engine's use and terminates the worker: ${what}`, async () => {
      const { worker, client } = await connected();
      const pending = client.request("doc.close", { doc_id: 1 });
      worker.answer(message);
      expect(client.state).toEqual({ kind: "failed", reason: "protocol_violation" });
      expect(worker.terminated).toBe(true);
      await expect(pending).rejects.toBeInstanceOf(EngineUnavailableError);
      // No new session: nothing more is sent.
      const sent = worker.posted.length;
      await expect(client.request("hello", { protocol_versions: [1] })).rejects.toBeInstanceOf(EngineUnavailableError);
      expect(worker.posted).toHaveLength(sent);
    });
  }

  it("ends it for a message that cannot be deserialized", async () => {
    const { worker, client } = await connected();
    worker.dispatchEvent(new MessageEvent("messageerror"));
    expect(client.state).toEqual({ kind: "failed", reason: "protocol_violation" });
  });

  it("ends it for replies without the shape of their request's reply", async () => {
    const cases: [string, Record<string, unknown>][] = [
      [
        "doc.opened without its revision",
        { doc_id: 1, page_count_estimate: 1, warnings: [], fonts: { missing: [], machine_dependent: false } },
      ],
      ["a tile without a bitmap", { width: 1, height: 1, hash: "fnv1a64:0", revision: 1, bitmap: {} }],
      ["a tile without its revision", { width: 1, height: 1, hash: "fnv1a64:0", bitmap: new FakeBitmap() }],
      [
        "a tile larger than the protocol allows",
        { width: 4097, height: 1, hash: "x", revision: 1, bitmap: new FakeBitmap() },
      ],
      // The request below asks for 1 × 1 pixels: the reply and its bitmap must be of that size (§6.4).
      [
        "a tile of another size than asked for",
        { width: 2, height: 1, hash: "x", revision: 1, bitmap: new FakeBitmap(2, 1) },
      ],
      [
        "a tile whose bitmap has another size than it says",
        { width: 1, height: 1, hash: "x", revision: 1, bitmap: new FakeBitmap(1, 2) },
      ],
    ];
    for (const [what, payload] of cases) {
      const { worker, client } = await connected();
      const request = what.startsWith("doc")
        ? client.request("doc.open", { blob: new ArrayBuffer(0) })
        : client.request("render.tile", {
            doc_id: 1,
            page: 0,
            rect: { x: 0, y: 0, width: 1, height: 1 },
            width: 1,
            height: 1,
          });
      worker.answer({ v: 1, re: 3, ok: true, payload });
      expect(client.state, what).toEqual({ kind: "failed", reason: "protocol_violation" });
      await expect(request).rejects.toBeInstanceOf(EngineUnavailableError);
    }
  });

  it("takes a tile of the size its request asked for", async () => {
    const { worker, client } = await connected();
    const tile = client.request("render.tile", {
      doc_id: 1,
      page: 0,
      rect: { x: 0, y: 0, width: 2, height: 3 },
      width: 2,
      height: 3,
    });
    const bitmap = new FakeBitmap(2, 3);
    worker.answer({ v: 1, re: 3, ok: true, payload: { width: 2, height: 3, hash: "x", revision: 1, bitmap } });
    await expect(tile).resolves.toMatchObject({ width: 2, height: 3, bitmap });
    expect(worker.terminated).toBe(false);
  });

  it("ends it for a manifest whose key data the shell cannot read", async () => {
    const { worker, client } = await connected();
    const manifest = client.request("ui.manifest", { locale: "en" });
    worker.answer({
      v: 1,
      re: 3,
      ok: true,
      payload: {
        manifest_version: 0,
        locale: "en",
        // A binding must give all four modifiers.
        commands: [{ id: "x", label: "X", bindings: [{ key: "b", ctrl: true, label: "Ctrl+B" }] }],
        keys: { document: [], reserved: [] },
        ribbon: { tabs: [] },
      },
    });
    await expect(manifest).rejects.toBeInstanceOf(EngineUnavailableError);
    expect(client.state).toEqual({ kind: "failed", reason: "protocol_violation" });
  });

  it("ends it for an engine version longer than 64 ASCII characters, in welcome and in ready (spec §14.1 item 6)", async () => {
    const long = "1".repeat(65);
    const first = setup();
    first.worker.answer({ worker: "ready", engine_version: long });
    expect(first.client.state).toEqual({ kind: "failed", reason: "protocol_violation" });
    const second = setup();
    void second.client.request("hello", { protocol_versions: [1] }).catch(() => undefined);
    second.worker.answer({ v: 1, re: 1, ok: true, payload: { ...welcome, engine_version: long } });
    expect(second.client.state).toEqual({ kind: "failed", reason: "protocol_violation" });
    // 64 characters are fine.
    const third = setup();
    third.worker.answer({ worker: "ready", engine_version: "1".repeat(64) });
    expect(third.client.state).toEqual({ kind: "ready", engineVersion: "1".repeat(64) });
  });

  it("ends it for a welcome that names a version the shell did not offer (spec §14.1 item 3)", async () => {
    const { worker, client } = setup();
    const hello = client.request("hello", { protocol_versions: [1] });
    worker.answer({ v: 1, re: 1, ok: true, type: "welcome", payload: { ...welcome, protocol_version: 2 } });
    await expect(hello).rejects.toBeInstanceOf(EngineUnavailableError);
    expect(client.state).toEqual({ kind: "failed", reason: "protocol_violation" });
  });
});

describe("a refused hello (spec §14.1 item 3)", () => {
  it("ends the engine's use after unsupported_protocol_version, whatever the refusal's v, with its own reason", async () => {
    const { worker, client } = setup();
    const hello = client.request("hello", { protocol_versions: [1] });
    // An engine that speaks other versions answers with its own v; the reply to hello is the one message exempt from the check.
    worker.answer({
      v: 2,
      re: 1,
      ok: false,
      error: {
        code: "unsupported_protocol_version",
        message_id: "engine-error-unsupported-protocol-version",
        args: {},
      },
    });
    const error = await hello.catch((caught: unknown) => caught);
    expect((error as EngineRequestError).info.code).toBe("unsupported_protocol_version");
    expect(client.state).toEqual({ kind: "failed", reason: "unsupported_protocol_version" });
    expect(worker.terminated).toBe(true);
    // No new hello.
    await expect(client.request("hello", { protocol_versions: [1] })).rejects.toBeInstanceOf(EngineUnavailableError);
    expect(worker.posted).toHaveLength(1);
  });

  it("ends it after any other error but panic", async () => {
    const { worker, client } = setup();
    const hello = client.request("hello", { protocol_versions: [1] });
    worker.answer({
      v: 1,
      re: 1,
      ok: false,
      error: { code: "invalid_request", message_id: "engine-error-invalid-request", args: {} },
    });
    await expect(hello).rejects.toBeInstanceOf(EngineRequestError);
    expect(client.state).toEqual({ kind: "failed", reason: "hello_refused" });
    expect(worker.terminated).toBe(true);
  });

  it("leaves a panic to the engine.error that follows it (spec §14.2)", async () => {
    const { worker, client } = setup();
    const restarts: unknown[] = [];
    client.onRestart((restart) => restarts.push(restart));
    const hello = client.request("hello", { protocol_versions: [1] });
    worker.answer({ v: 1, re: 1, ok: false, error: { code: "panic", message_id: "engine-error-panic", args: {} } });
    await expect(hello).rejects.toBeInstanceOf(EngineSessionEndedError);
    expect(client.state.kind).toBe("starting");
    worker.answer({
      v: 1,
      type: "engine.error",
      seq: 1,
      payload: {
        code: "panic",
        message_id: "engine-error-panic",
        recoverable: false,
        args: {},
        restart: { number: 1, limit: 3 },
      },
    });
    expect(restarts).toEqual([{ number: 1, limit: 3 }]);
  });
});

describe("restarts (spec §14.2)", () => {
  const failure = (restart: unknown) => ({
    v: 1,
    type: "engine.error",
    seq: 1,
    payload: { code: "panic", message_id: "engine-error-panic", recoverable: false, args: {}, restart },
  });

  it("passes on the restart the engine granted, and ends the old session's requests", async () => {
    const { worker, client } = await connected();
    const restarts: unknown[] = [];
    client.onRestart((restart) => restarts.push(restart));
    const pending = client.request("doc.close", { doc_id: 1 });
    worker.answer(failure({ number: 2, limit: 3 }));
    expect(restarts).toEqual([{ number: 2, limit: 3 }]);
    await expect(pending).rejects.toBeInstanceOf(EngineSessionEndedError);
    expect(client.state.kind).toBe("starting");
  });

  it("stops when the engine used up its restarts, terminating the worker", async () => {
    const { worker, client } = await connected();
    worker.answer(failure(null));
    expect(client.state).toEqual({ kind: "failed", reason: "restarts_used_up" });
    expect(worker.terminated).toBe(true);
  });

  it("ends nothing for an engine.error the engine recovered from", async () => {
    const { worker, client } = await connected();
    const errors: unknown[] = [];
    client.on("engine.error", (payload) => errors.push(payload.code));
    worker.answer({
      v: 1,
      type: "engine.error",
      seq: 1,
      payload: { code: "not_found", message_id: "engine-error-not-found", recoverable: true, args: {} },
    });
    expect(errors).toEqual(["not_found"]);
    expect(client.state.kind).toBe("starting");
  });
});
