// The main thread's side of the engine protocol (spec §3.2, §4): sends requests to the worker host, matches replies to requests by their
// `id`, hands events to listeners, and follows the worker host's control messages. The main thread never calls the engine directly
// (ADR-0012 §4); everything crosses the worker boundary as structured-clone messages, with blobs and tiles transferred.
// Messages from the worker are checked for shape before use, so a malformed one is dropped instead of breaking the app.

import type { ErrorInfo, Events, EventType, Replies, Requests, RequestType, WorkerStatus } from "./protocol.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";

/** The engine answered a request with an error (spec §12). `info.code` says what went wrong; it never carries document content. */
export class EngineRequestError extends Error {
  override readonly name = "EngineRequestError";
  readonly type: RequestType;
  readonly info: ErrorInfo;

  constructor(type: RequestType, info: ErrorInfo) {
    super(`The engine refused ${type}: ${info.code}.`);
    this.type = type;
    this.info = info;
  }
}

/** The worker stopped (it failed to start, the engine could not be replaced after a panic, or the app terminated it). */
export class EngineUnavailableError extends Error {
  override readonly name = "EngineUnavailableError";
}

export type EngineState =
  | { readonly kind: "starting" }
  | { readonly kind: "ready"; readonly engineVersion: string }
  | { readonly kind: "failed"; readonly reason: string };

/** Arguments of request(): the payload may be left out when every field of it is optional (spec §4). */
type RequestArgs<T extends RequestType> =
  Record<string, never> extends Requests[T]
    ? [payload?: Requests[T], transfer?: Transferable[]]
    : [payload: Requests[T], transfer?: Transferable[]];

interface Pending {
  readonly type: RequestType;
  readonly sent: number;
  resolve(payload: unknown): void;
  reject(error: Error): void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Frees the GPU or memory backing of any ImageBitmap in a payload nobody will use. */
function closeBitmaps(payload: unknown): void {
  if (isObject(payload) && typeof ImageBitmap === "function" && payload["bitmap"] instanceof ImageBitmap) {
    payload["bitmap"].close();
  }
}

export class EngineClient {
  readonly #worker: Worker;
  readonly #now: () => number;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Map<string, Set<(payload: never) => void>>();
  readonly #stateListeners = new Set<(state: EngineState) => void>();
  #state: EngineState = { kind: "starting" };
  /** Called with every completed request's type and round-trip time in milliseconds (main thread → worker → main thread). */
  onRoundTrip: ((type: RequestType, milliseconds: number) => void) | undefined;

  constructor(worker: Worker, now: () => number = () => performance.now()) {
    this.#worker = worker;
    this.#now = now;
    worker.addEventListener("message", (event: MessageEvent<unknown>) => this.#receive(event.data));
    // A module worker that cannot be loaded (network error, refused by the Content Security Policy) reports a plain error event.
    worker.addEventListener("error", (event) => {
      event.preventDefault();
      this.#fail("load_failed");
    });
    worker.addEventListener("messageerror", () => this.#fail("message_error"));
  }

  get state(): EngineState {
    return this.#state;
  }

  /** Calls `listener` whenever the state changes; returns a function that unsubscribes it. */
  onState(listener: (state: EngineState) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  /** Calls `listener` with the payload of every event of type `type` (spec §4); returns a function that unsubscribes it. */
  on<T extends EventType>(type: T, listener: (payload: Events[T]) => void): () => void {
    let set = this.#listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener as (payload: never) => void);
    return () => set.delete(listener as (payload: never) => void);
  }

  /**
   * Sends a request and resolves with the payload of its reply, or rejects with EngineRequestError (the engine refused it) or
   * EngineUnavailableError (the worker stopped). Messages are queued by the worker host until the engine is ready (spec §3.2).
   */
  request<T extends RequestType>(type: T, ...[payload, transfer = []]: RequestArgs<T>): Promise<Replies[T]> {
    if (this.#state.kind === "failed") {
      return Promise.reject(new EngineUnavailableError(`The engine is not available (${this.#state.reason}).`));
    }
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise<Replies[T]>((resolve, reject) => {
      this.#pending.set(id, { type, sent: this.#now(), resolve: resolve as (payload: unknown) => void, reject });
      const message =
        payload === undefined ? { v: PROTOCOL_VERSION, id, type } : { v: PROTOCOL_VERSION, id, type, payload };
      this.#worker.postMessage(message, transfer);
    });
  }

  /** Stops the worker. Pending requests reject with EngineUnavailableError. */
  terminate(): void {
    this.#fail("terminated");
  }

  #receive(data: unknown): void {
    if (!isObject(data)) return;
    if ("worker" in data && !("v" in data)) {
      this.#control(data as unknown as WorkerStatus);
    } else if (typeof data["re"] === "number") {
      this.#reply(data["re"], data);
    } else if (typeof data["type"] === "string" && typeof data["seq"] === "number") {
      for (const listener of this.#listeners.get(data["type"]) ?? []) {
        listener(data["payload"] as never);
      }
    }
  }

  #control(status: WorkerStatus): void {
    if (status.worker === "ready" && typeof status.engine_version === "string") {
      this.#setState({ kind: "ready", engineVersion: status.engine_version });
    } else if (status.worker === "failed") {
      this.#fail(typeof status.reason === "string" ? status.reason : "failed");
    }
  }

  #reply(id: number, reply: Record<string, unknown>): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) {
      closeBitmaps(reply["payload"]);
      return;
    }
    this.#pending.delete(id);
    this.onRoundTrip?.(pending.type, this.#now() - pending.sent);
    if (reply["ok"] === true) {
      pending.resolve(reply["payload"]);
    } else {
      const error = isObject(reply["error"]) ? (reply["error"] as unknown as ErrorInfo) : undefined;
      pending.reject(
        new EngineRequestError(
          pending.type,
          error ?? { code: "internal", message_id: "engine-error-internal", args: {} },
        ),
      );
    }
  }

  /**
   * Stops for good. The worker is terminated: after `failed` its host ignores every message and the shell terminates it (spec §3.2), and
   * a worker that could not load or sent a message that could not be read is of no further use either.
   */
  #fail(reason: string): void {
    if (this.#state.kind === "failed") return;
    this.#worker.terminate();
    this.#setState({ kind: "failed", reason });
    for (const pending of this.#pending.values()) {
      pending.reject(new EngineUnavailableError(`The engine stopped (${reason}).`));
    }
    this.#pending.clear();
  }

  #setState(state: EngineState): void {
    this.#state = state;
    for (const listener of this.#stateListeners) listener(state);
  }
}
