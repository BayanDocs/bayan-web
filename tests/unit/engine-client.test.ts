import { describe, expect, it } from "vitest";
import { EngineClient, EngineRequestError, EngineUnavailableError } from "../../src/engine/client.ts";

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

function setup() {
  const worker = new FakeWorker();
  let now = 0;
  const client = new EngineClient(worker as unknown as Worker, () => now);
  return { worker, client, advance: (ms: number) => (now += ms) };
}

describe("EngineClient", () => {
  it("sends requests in the envelope of spec §4 with increasing ids, and resolves each with its own reply", async () => {
    const { worker, client, advance } = setup();
    const trips: [string, number][] = [];
    client.onRoundTrip = (type, ms) => trips.push([type, ms]);
    const hello = client.request("hello", { protocol_versions: [0] });
    const manifest = client.request("ui.manifest", { locale: "en" });
    expect(worker.posted).toEqual([
      { v: 0, id: 1, type: "hello", payload: { protocol_versions: [0] } },
      { v: 0, id: 2, type: "ui.manifest", payload: { locale: "en" } },
    ]);
    advance(3);
    worker.answer({ v: 0, re: 2, ok: true, payload: { manifest_version: 0 } });
    worker.answer({ v: 0, re: 1, ok: true, type: "welcome", payload: { protocol_version: 0 } });
    await expect(manifest).resolves.toEqual({ manifest_version: 0 });
    await expect(hello).resolves.toEqual({ protocol_version: 0 });
    expect(trips).toEqual([
      ["ui.manifest", 3],
      ["hello", 3],
    ]);
  });

  it("leaves out an empty payload", () => {
    const { worker, client } = setup();
    void client.request("diag.record.start");
    expect(worker.posted).toEqual([{ v: 0, id: 1, type: "diag.record.start" }]);
  });

  it("rejects with the engine's error code, which never carries document content", async () => {
    const { worker, client } = setup();
    const open = client.request("doc.close", { doc_id: 9 });
    worker.answer({
      v: 0,
      re: 1,
      ok: false,
      error: { code: "not_found", message_id: "engine-error-not-found", args: {} },
    });
    const error = await open.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineRequestError);
    expect((error as EngineRequestError).info.code).toBe("not_found");
  });

  it("hands events to their listeners and ignores malformed messages", () => {
    const { worker, client } = setup();
    const seen: unknown[] = [];
    const stop = client.on("render.invalidate", (payload) => seen.push(payload));
    for (const junk of [
      null,
      7,
      "x",
      { re: "1" },
      { type: "render.invalidate" },
      { v: 0, re: 99, ok: true, payload: {} },
    ]) {
      worker.answer(junk);
    }
    worker.answer({ v: 0, type: "render.invalidate", seq: 1, payload: { doc_id: 1, regions: [] } });
    stop();
    worker.answer({ v: 0, type: "render.invalidate", seq: 2, payload: { doc_id: 1, regions: [] } });
    expect(seen).toEqual([{ doc_id: 1, regions: [] }]);
  });

  it("follows the worker host's control messages, and rejects everything pending when it fails", async () => {
    const { worker, client } = setup();
    const states: string[] = [];
    client.onState((state) => states.push(state.kind));
    const pending = client.request("hello", { protocol_versions: [0] });
    worker.answer({ worker: "ready", engine_version: "0.0.0" });
    worker.answer({ worker: "failed", reason: "restart_failed" });
    await expect(pending).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(client.request("hello", { protocol_versions: [0] })).rejects.toBeInstanceOf(EngineUnavailableError);
    expect(states).toEqual(["ready", "failed"]);
    expect(client.state).toEqual({ kind: "failed", reason: "restart_failed" });
  });

  it("treats a worker that cannot load as failed", () => {
    const { worker, client } = setup();
    worker.dispatchEvent(new Event("error", { cancelable: true }));
    expect(client.state.kind).toBe("failed");
  });
});
