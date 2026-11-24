import type { Page } from "@playwright/test";

// Engine failures on purpose, against the real engine, for the recovery tests (recovery.spec.ts) and for the accessibility rules in the
// states that failures lead to (axe.spec.ts).
//
// The engine panics on diag.panic only when its configuration's test switch test.allow_panic is on (spec §3.3, §6.7), which the app never
// turns on. Before the app starts, enablePanics wraps Worker.prototype.postMessage: the wrapper adds the switch to the worker host's init
// message, records the type of every message the app sends, keeps the worker so that a test can send diag.panic itself, and can turn the
// app's own requests of one type (from the start, or from a point the test chooses) into diag.panic with the same id, so that the engine
// fails while handling them and answers the app's request with the error panic, as a document that makes the engine panic when it opens
// would.

export interface Traffic {
  /** The type of every protocol message sent to the worker, in order, as the app sent it, and the test's own diag.panic. */
  readonly sent: string[];
  /** How many welcome replies (successful handshakes) and unrecoverable engine.error events arrived. */
  readonly welcomes: number;
  readonly failures: number;
  /** Every text the status line has shown, in order, also those that lasted only a moment. */
  readonly statuses: string[];
}

/** Which of the app's requests the engine fails on: the first `times` of type `type`, or every one if `times` is null. */
export interface Failing {
  readonly type: string;
  readonly times: number | null;
}

export async function enablePanics(page: Page, failing: Failing | null = null): Promise<void> {
  await page.addInitScript((fail) => {
    const traffic = { sent: [] as string[], welcomes: 0, failures: 0, statuses: [] as string[] };
    let engineWorker: Worker | undefined;
    let failed = 0;
    /** The type of the app's next request that the engine is to fail on, set by failNext(). */
    let failNext: string | null = null;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, transfer?: Transferable[]) {
      const envelope = message as { worker?: unknown; type?: unknown; id?: unknown } | null;
      if (envelope?.worker === "init") {
        engineWorker = this;
        this.addEventListener("message", (event: MessageEvent<unknown>) => {
          const data = event.data as { type?: unknown; payload?: { recoverable?: unknown } } | null;
          if (data?.type === "welcome") traffic.welcomes += 1;
          if (data?.type === "engine.error" && data.payload?.recoverable === false) traffic.failures += 1;
        });
        return Reflect.apply(post, this, [{ ...envelope, config: { test: { allow_panic: true } } }, transfer]);
      }
      if (typeof envelope?.type === "string") traffic.sent.push(envelope.type);
      const next = failNext !== null && envelope?.type === failNext;
      if (next) failNext = null;
      if (next || (fail !== null && envelope?.type === fail.type && (fail.times === null || failed < fail.times))) {
        if (!next) failed += 1;
        // The same id, so that the engine's error panic answers the app's own request; the transfer list still moves any blob.
        return Reflect.apply(post, this, [{ v: 0, id: envelope.id, type: "diag.panic" }, transfer]);
      }
      return Reflect.apply(post, this, [message, transfer]);
    } as typeof Worker.prototype.postMessage;
    new MutationObserver(() => {
      const text = document.querySelector(".document-status")?.textContent ?? null;
      if (text !== null && text !== "" && traffic.statuses.at(-1) !== text) traffic.statuses.push(text);
    }).observe(document, { subtree: true, childList: true, characterData: true });
    Object.assign(globalThis, {
      __traffic: traffic,
      // Without an id, so the app's requests and their identifiers are untouched; the engine answers with engine.error only.
      __panic: () => engineWorker?.postMessage({ v: 0, type: "diag.panic" }),
      __failNext: (type: string) => {
        failNext = type;
      },
    });
  }, failing);
}

export async function traffic(page: Page): Promise<Traffic> {
  return page.evaluate(() => {
    const { sent, welcomes, failures, statuses } = (globalThis as unknown as { __traffic: Traffic }).__traffic;
    return { sent: sent.slice(), welcomes, failures, statuses: statuses.slice() };
  });
}

/** Makes the real engine panic, and returns how many messages had been sent before. */
export async function panic(page: Page): Promise<number> {
  const before = (await traffic(page)).sent.length;
  await page.evaluate(() => (globalThis as unknown as { __panic: () => void }).__panic());
  return before;
}

/**
 * Makes the engine fail on the app's next request of type `type`, which goes to the engine as diag.panic with the same id (see
 * enablePanics): the engine fails while it handles exactly that request, whatever the timing.
 */
export async function failNext(page: Page, type: string): Promise<void> {
  await page.evaluate(
    (next) => (globalThis as unknown as { __failNext: (type: string) => void }).__failNext(next),
    type,
  );
}

/**
 * Makes the worker host unable to replace the engine after its next panic, so that the host itself reports
 * { worker: "failed", reason: "restart_failed" } (spec §3.2) and the app stops (§12.1, point 1). The host's restart() creates the new
 * instance through the glue's __wbg_reset_state(), which calls new WebAssembly.Instance(); the test replaces that constructor, inside the
 * engine's worker only, with one that throws. The engine package's files are served unchanged.
 */
export async function breakEngineRestarts(page: Page): Promise<void> {
  const engine = page.workers().find((worker) => worker.url().includes("bayan-worker.js"));
  if (engine === undefined) throw new Error("The engine's worker is not running.");
  await engine.evaluate(() => {
    WebAssembly.Instance = class {
      constructor() {
        throw new Error("A test made the engine's replacement fail.");
      }
    } as unknown as typeof WebAssembly.Instance;
  });
}

/** The types of the messages sent since `before` messages had been sent. */
export async function sentSince(page: Page, before: number): Promise<string[]> {
  return (await traffic(page)).sent.slice(before);
}
