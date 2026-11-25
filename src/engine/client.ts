// The main thread's side of the engine protocol (spec §3.2, §4): sends requests to the worker host, matches replies to requests by their
// `id`, hands events to listeners, and follows the worker host's control messages. The main thread never calls the engine directly
// (ADR-0012 §4); everything crosses the worker boundary as structured-clone messages, with blobs and tiles transferred.
//
// Protocol v1 (spec §14.1, §14.2). Every message from the worker is checked before any of it is used (src/engine/checks.ts): its envelope,
// its version `v` (the session's, 1, on every message but the reply to hello), the payload of every message type this shell knows, and a
// tile's size, which must be what its request asked for. A message that fails is a protocol violation, and so is an engine.error that does
// not say what follows: the client then stops using the engine for good, terminating the worker, and starts no new session; only reloading
// the page brings the engine back. So does a refused hello (anything but the error panic), with its own reason after
// unsupported_protocol_version, for which the app shows the update prompt. What remains is sorted by session (src/engine/session.ts): what
// belongs to an earlier session is ignored, and engine.error with recoverable false tells the shell, through onRestart, which restart the
// engine's bindings granted, or stops the client when the engine has used them up. The shell counts no restarts itself.

import { checkEvent, checkReply, isPlainObject, readEnvelope } from "./checks.ts";
import type { ErrorInfo, Events, EventType, Replies, Requests, RequestType, Restart } from "./protocol.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { SessionTracker } from "./session.ts";

/** The engine answered a request of the current session with an error (spec §12). `info.code` says what; it never holds document content. */
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

/**
 * The request belonged to a session that the engine discarded (spec §12.1 step 4): it failed with the error panic, or the engine failed
 * while it waited. Nothing is shown for it; what follows comes through onRestart or the client's state.
 */
export class EngineSessionEndedError extends Error {
  override readonly name = "EngineSessionEndedError";
}

/** The client stopped using the engine: it could not start, it stopped, or it broke the protocol (see EngineState). */
export class EngineUnavailableError extends Error {
  override readonly name = "EngineUnavailableError";
}

/** Why the client stopped using the engine. */
export type StopReason =
  /** The worker or the engine module could not be loaded, for example because the module did not match its hash (§14.8). */
  | "load_failed"
  /** The worker host failed after the engine was running, such as when it could not replace the engine after a panic (§3.2). */
  | "worker_failed"
  /** The engine used up its restarts: an engine.error with restart null (§14.2). */
  | "restarts_used_up"
  /** A message broke the protocol (§14.1 item 5). */
  | "protocol_violation"
  /** The engine refused hello with unsupported_protocol_version: the app must be reloaded to finish an update (§14.1 item 3). */
  | "unsupported_protocol_version"
  /** The engine refused hello with any other error but panic (§14.1 item 3). */
  | "hello_refused"
  /** The app stopped it. */
  | "terminated";

export type EngineState =
  | { readonly kind: "starting" }
  | { readonly kind: "ready"; readonly engineVersion: string }
  | { readonly kind: "failed"; readonly reason: StopReason };

/** Arguments of request() and send(): the payload may be left out when every field of it is optional (spec §4). */
type RequestArgs<T extends RequestType> =
  Record<string, never> extends Requests[T]
    ? [payload?: Requests[T], transfer?: Transferable[]]
    : [payload: Requests[T], transfer?: Transferable[]];

/** A tile's size in pixels. */
interface PixelSize {
  readonly width: number;
  readonly height: number;
}

interface Pending {
  readonly type: RequestType;
  readonly sent: number;
  /** For hello: the protocol versions it offered, one of which its welcome must name (§14.1 item 3). */
  readonly offered?: readonly number[];
  /** For render.tile: the size it asked for, which its reply and the reply's bitmap must have (§6.4). */
  readonly size?: PixelSize;
  resolve(payload: unknown): void;
  reject(error: Error): void;
}

/** The pixel size that a render.tile request asks for. */
function requestedSize(payload: unknown): PixelSize | undefined {
  if (!isPlainObject(payload)) return undefined;
  const { width, height } = payload;
  return typeof width === "number" && typeof height === "number" ? { width, height } : undefined;
}

/**
 * Whether a tile's reply, and the bitmap it carries, have the size its request asked for (§6.4): the compositor keeps and draws the
 * bitmap as a tile of that size, and counts its memory by it.
 */
function hasSize(payload: Record<string, unknown>, size: PixelSize): boolean {
  const bitmap = payload["bitmap"] as { readonly width?: unknown; readonly height?: unknown };
  return (
    payload["width"] === size.width &&
    payload["height"] === size.height &&
    bitmap.width === size.width &&
    bitmap.height === size.height
  );
}

/** Frees the memory behind the ImageBitmap of a tile nobody will draw. */
function closeBitmap(payload: unknown): void {
  if (isPlainObject(payload) && typeof ImageBitmap === "function" && payload["bitmap"] instanceof ImageBitmap) {
    payload["bitmap"].close();
  }
}

/** Whether a value is an ImageBitmap, the form in which the worker host delivers tiles (§3.2). */
function isImageBitmap(value: unknown): boolean {
  return typeof ImageBitmap === "function" && value instanceof ImageBitmap;
}

export interface ClientOptions {
  /** A monotonic clock in milliseconds, for the round-trip times. */
  readonly now?: () => number;
  /** Tells a transferred ImageBitmap; the unit tests, which run without one, give their own. */
  readonly isBitmap?: (value: unknown) => boolean;
}

export class EngineClient {
  readonly #worker: Worker;
  readonly #now: () => number;
  readonly #isBitmap: (value: unknown) => boolean;
  readonly #session = new SessionTracker();
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  /** Every hello sent: the reply to a hello is the one message whose `v` may differ from the session's (§14.1 item 1). */
  readonly #hellos = new Set<number>();
  readonly #listeners = new Map<string, Set<(payload: never) => void>>();
  readonly #stateListeners = new Set<(state: EngineState) => void>();
  readonly #restartListeners = new Set<(restart: Restart) => void>();
  #state: EngineState = { kind: "starting" };
  /** Called with every completed request's type and round-trip time in milliseconds (main thread → worker → main thread). */
  onRoundTrip: ((type: RequestType, milliseconds: number) => void) | undefined;

  constructor(worker: Worker, options: ClientOptions = {}) {
    this.#worker = worker;
    this.#now = options.now ?? (() => performance.now());
    this.#isBitmap = options.isBitmap ?? isImageBitmap;
    worker.addEventListener("message", (event: MessageEvent<unknown>) => this.#receive(event.data));
    // A module worker that cannot be loaded (network error, refused by the Content Security Policy) reports a plain error event.
    // After ready, the engine was running: its worker failed, as with the worker host's own "failed" control message.
    worker.addEventListener("error", (event) => {
      event.preventDefault();
      this.#stop(this.#state.kind === "ready" ? "worker_failed" : "load_failed");
    });
    // A message that cannot be deserialized is not a plain object either (§14.1 item 5).
    worker.addEventListener("messageerror", () => this.#stop("protocol_violation"));
  }

  get state(): EngineState {
    return this.#state;
  }

  /** Calls `listener` whenever the state changes; returns a function that unsubscribes it. */
  onState(listener: (state: EngineState) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  /**
   * Calls `listener` when the engine discarded its session and is ready for a new one, which is restart `number` of `limit` within ten
   * minutes (§14.2): the shell tells the user and starts the new session with hello. Requests of the old session have been rejected with
   * EngineSessionEndedError by then.
   */
  onRestart(listener: (restart: Restart) => void): () => void {
    this.#restartListeners.add(listener);
    return () => this.#restartListeners.delete(listener);
  }

  /** Calls `listener` with the payload of every event of type `type` of the current session (spec §4); returns its unsubscriber. */
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
   * Sends a request and resolves with the payload of its reply, checked against the protocol, or rejects with EngineRequestError (the
   * engine refused it), EngineSessionEndedError (its session ended) or EngineUnavailableError (the client stopped). Messages are queued
   * by the worker host until the engine is ready (spec §3.2).
   */
  request<T extends RequestType>(type: T, ...[payload, transfer = []]: RequestArgs<T>): Promise<Replies[T]> {
    if (this.#state.kind === "failed") {
      return Promise.reject(new EngineUnavailableError(`The engine is not available (${this.#state.reason}).`));
    }
    const id = this.#nextId;
    this.#nextId += 1;
    if (type === "hello") this.#hellos.add(id);
    this.#session.sent(type, id);
    return new Promise<Replies[T]>((resolve, reject) => {
      const offered = type === "hello" ? (payload as Requests["hello"]).protocol_versions : undefined;
      const size = type === "render.tile" ? requestedSize(payload) : undefined;
      this.#pending.set(id, {
        type,
        sent: this.#now(),
        ...(offered === undefined ? {} : { offered }),
        ...(size === undefined ? {} : { size }),
        resolve: resolve as (payload: unknown) => void,
        reject,
      });
      const message =
        payload === undefined ? { v: PROTOCOL_VERSION, id, type } : { v: PROTOCOL_VERSION, id, type, payload };
      this.#worker.postMessage(message, transfer);
    });
  }

  /** Sends a message without an identifier, which the engine answers with nothing but, on failure, an engine.error (spec §4). */
  send<T extends RequestType>(type: T, ...[payload, transfer = []]: RequestArgs<T>): void {
    if (this.#state.kind === "failed") return;
    this.#session.sent(type, undefined);
    const message = payload === undefined ? { v: PROTOCOL_VERSION, type } : { v: PROTOCOL_VERSION, type, payload };
    this.#worker.postMessage(message, transfer);
  }

  /** Stops the worker. Pending requests reject with EngineUnavailableError. */
  terminate(): void {
    this.#stop("terminated");
  }

  /** The app found that something the engine sent breaks the protocol (an accessibility tree, src/a11y/tree.ts): stops for good. */
  violation(): void {
    this.#stop("protocol_violation");
  }

  #receive(data: unknown): void {
    if (this.#state.kind === "failed") {
      closeBitmap(isPlainObject(data) ? data["payload"] : undefined);
      return;
    }
    const message = readEnvelope(data);
    switch (message.kind) {
      case "violation":
        closeBitmap(isPlainObject(data) ? data["payload"] : undefined);
        this.#stop("protocol_violation");
        return;
      case "ready":
        if (this.#state.kind === "starting") this.#setState({ kind: "ready", engineVersion: message.engineVersion });
        return;
      case "failed":
        // After failed the worker host ignores every message; the engine cannot even be restarted (§3.2, §12.1 step 1).
        this.#stop(this.#state.kind === "ready" ? "worker_failed" : "load_failed");
        return;
      case "control":
        return;
      case "reply":
        this.#reply(message);
        return;
      case "event":
        this.#event(message.v, message.type, message.payload);
        return;
    }
  }

  #reply(
    reply:
      | { readonly v: unknown; readonly re: number; readonly ok: true; readonly payload: Record<string, unknown> }
      | { readonly v: unknown; readonly re: number; readonly ok: false; readonly error: ErrorInfo },
  ): void {
    const payload = reply.ok ? reply.payload : undefined;
    if (reply.v !== PROTOCOL_VERSION && !this.#hellos.has(reply.re)) {
      closeBitmap(payload);
      this.#stop("protocol_violation");
      return;
    }
    const pending = this.#pending.get(reply.re);
    // A reply to a request that the shell no longer waits for is no violation (§14.1 item 5); nobody reads it.
    if (pending === undefined) {
      closeBitmap(payload);
      return;
    }
    if (
      reply.ok &&
      (!checkReply(pending.type, reply.payload, this.#isBitmap) ||
        (pending.offered !== undefined && !pending.offered.includes(reply.payload["protocol_version"] as number)) ||
        (pending.size !== undefined && !hasSize(reply.payload, pending.size)))
    ) {
      // Every reply must have its type's shape; a welcome must name a version the shell offered (§14.1 item 3); a tile must have the
      // size its request asked for.
      closeBitmap(payload);
      this.#stop("protocol_violation");
      return;
    }
    const decision = this.#session.reply(
      reply.re,
      reply.ok,
      reply.ok ? reply.payload : {},
      reply.ok ? undefined : reply.error.code,
    );
    this.#pending.delete(reply.re);
    if (decision.action !== "handle") {
      closeBitmap(payload);
      pending.reject(new EngineSessionEndedError("The engine discarded the session of this request."));
      return;
    }
    this.onRoundTrip?.(pending.type, this.#now() - pending.sent);
    if (reply.ok) {
      pending.resolve(reply.payload);
      return;
    }
    pending.reject(new EngineRequestError(pending.type, reply.error));
    // A refused hello is not a failure that a new session repairs: the shell would send the same hello and be refused again (§14.1 item
    // 3). The error panic never gets here: it was ignored above, and the engine.error that follows says what comes next.
    if (pending.type === "hello") {
      this.#stop(
        reply.error.code === "unsupported_protocol_version" ? "unsupported_protocol_version" : "hello_refused",
      );
    }
  }

  #event(v: unknown, type: string, payload: Record<string, unknown>): void {
    if (v !== PROTOCOL_VERSION || !checkEvent(type, payload)) {
      this.#stop("protocol_violation");
      return;
    }
    const decision = this.#session.event(type, payload);
    switch (decision.action) {
      case "ignore":
        return;
      case "handle":
        for (const listener of this.#listeners.get(type) ?? []) listener(payload as never);
        return;
      case "restart":
        // The requests still waiting belong to the session the engine discarded (§12.1 step 4).
        for (const pending of this.#pending.values()) {
          pending.reject(new EngineSessionEndedError("The engine discarded the session of this request."));
        }
        this.#pending.clear();
        for (const listener of this.#restartListeners) listener(decision.restart);
        return;
      case "stop":
        this.#stop(decision.reason);
        return;
    }
  }

  /**
   * Stops for good. The worker is terminated: after failed or a used-up allowance its host ignores every message (§3.2, §14.2), and after a
   * protocol violation or a refused hello the shell must not use it any more (§14.1).
   */
  #stop(reason: StopReason): void {
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
