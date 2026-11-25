// Connects the engine worker, the tile compositor, the input bridge and the accessibility mirror for one document view (WEB-002).
//
// It runs the session (hello, ui.manifest, doc.open, view.set, query.a11y; spec §5, §11, protocol v1 of §14), recovers from engine
// failures as spec §12.1 and §14.2 say (a new session for each restart that the engine's bindings grant, each announced with the number
// the engine gives, without reopening the document unasked, and the stop when the engine has used them up), stops for good after a refused
// hello or a message that breaks the protocol (§14.1), with the update prompt after unsupported_protocol_version, turns the engine's events
// into drawing, mirror updates and bridge updates, turns scrolling, zooming, devicePixelRatio changes, pointer presses and the bridge's
// input into messages, and measures the latencies of WEB-002 (src/metrics.ts). The scroll-and-draw path is imperative and
// allocation-light; React only renders the frame around it and the status line (DocumentView.tsx).

import { AccessibilityMirror } from "../a11y/mirror.ts";
import {
  EngineClient as Client,
  type EngineClient,
  EngineSessionEndedError,
  type EngineState,
  type StopReason,
} from "../engine/client.ts";
import { browserPlatform } from "../engine/platform.ts";
import type {
  A11yNode,
  A11yTree,
  ChildRange,
  InputKey,
  PageInfo,
  PageRect,
  RequestType,
  Restart,
} from "../engine/protocol.ts";
import { BLU_PER_DIP, PROTOCOL_VERSION } from "../engine/protocol.ts";
import { startEngineWorker } from "../engine/start.ts";
import type { InputBridge, InputSink } from "../input/bridge.ts";
import { createInputBridge } from "../input/create-bridge.ts";
import { type KeyData, keyDataOf, noKeys } from "../input/keys.ts";
import { measureNames, recordDuration, roundTripName } from "../metrics.ts";
import { Compositor, type FrameReport } from "./compositor.ts";
import {
  type ContentLayout,
  contentLayout,
  engineViewport,
  intersects,
  pageAreaSize,
  pointerToView,
  type TilePatch,
  type TileSpec,
  type ViewTransform,
} from "./tiles.ts";

/** The zoom steps of the zoom buttons. */
export const zoomSteps = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2, 3, 4, 5] as const;
export const maxZoom = 5;

export interface DocumentStatus {
  readonly engine: "starting" | "ready" | "failed";
  /** A short message for people, in the shell's own words; never document content, and never text from the engine. */
  readonly message: string;
  /**
   * What to offer after the engine was restarted (spec §12.1, point 3): to reopen the document a failure closed, or to open it if a failure
   * came before it was ever open; null when there is nothing to offer. The offer stays through further failures and goes at the stop.
   */
  readonly offer: "reopen" | "open" | null;
  /**
   * The update prompt (spec §14.1 item 3): the engine refused hello with unsupported_protocol_version, because the browser holds files of
   * two deployments of the app; reloading the page finishes the update. Shown with a button that reloads the page.
   */
  readonly reload: boolean;
  readonly zoom: number;
  readonly bridge: InputBridge["kind"];
}

/** What the status line says when the engine stops, by why it stopped (spec §12.1 step 2, §14.1, §14.2); never the engine's own words. */
function stopMessage(reason: StopReason): string {
  switch (reason) {
    case "load_failed":
      return "The engine could not be started. Reload the page to try again.";
    case "restarts_used_up":
      return "The engine stopped working again, so it was not restarted. Reload the page to start it again.";
    case "unsupported_protocol_version":
      return "The app was updated while this page was open. Reload the page to finish the update.";
    case "worker_failed":
    case "protocol_violation":
    case "hello_refused":
    case "terminated":
      return "The engine stopped. Reload the page to start it again.";
  }
}

export interface DocumentElements {
  /** The scrolling element; its content is `extent`, sized like the page area. */
  readonly scroller: HTMLElement;
  readonly extent: HTMLElement;
  readonly tiles: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
  /** The accessibility mirror's container, inside `extent`. */
  readonly mirror: HTMLElement;
  /** The button of the offer (spec §12.1, point 3), which React renders while the offer stands and removes when it goes; null without it. */
  readonly offer: { readonly current: HTMLElement | null };
}

/** A key press or input event on its way to the engine and back, for the latency measurements of WEB-002 (AC-4). */
interface Probe {
  readonly start: number;
  /** The engine replied to the message; the events it sent for it follow the reply (spec §3.2). */
  replied: boolean;
  /** The engine sent an overlay.update for it, and the compositor drew it. */
  overlay: boolean;
  overlayDrawn: boolean;
  /** The regions the engine invalidated for it, and whether a re-rendered tile in them has been drawn. */
  invalidated: PageRect[];
  tileDrawn: boolean;
}

function finished(probe: Probe): boolean {
  return probe.replied && (!probe.overlay || probe.overlayDrawn) && (probe.invalidated.length === 0 || probe.tileDrawn);
}

export class DocumentController {
  readonly #elements: DocumentElements;
  readonly #onStatus: (status: DocumentStatus) => void;
  readonly #compositor: Compositor;
  readonly #bridge: InputBridge;
  readonly #mirror: AccessibilityMirror;
  readonly #abort = new AbortController();
  #client: EngineClient | undefined;
  #docId: number | null = null;
  #pages: readonly PageInfo[] = [];
  #layout: ContentLayout = { originX: 0, originY: 0, width: 0, height: 0 };
  #zoom = 1;
  #devicePixelRatio = 1;
  /** The keys the engine handles and those the shell keeps, from the session's UI manifest (spec §14.3). */
  #keys: KeyData = noKeys;
  #status: DocumentStatus;
  #probes: Probe[] = [];
  /** A mouse pointerdown waits for its mousedown, which carries the click count. */
  #mousePress = false;
  /** The click count of the last mouse press, which its release repeats. */
  #clicks = 1;
  #viewSetTimer: ReturnType<typeof setTimeout> | undefined;
  #resizeObserver: ResizeObserver | undefined;
  #resolutionQuery: MediaQueryList | undefined;
  #watchingResize = false;
  #devicePixelObserver: ResizeObserver | undefined;
  #destroyed = false;
  /** Counts the sessions, so that what an older session's requests return is dropped (spec §12.1, point 4). */
  #session = 0;
  /** The client stopped using the engine (it failed, used up its restarts or broke the protocol): no session is started any more. */
  #stopped = false;
  /** A document is being opened (doc.open to query.a11y): a failure now closes it as much as one that is open. */
  #opening = false;

  constructor(elements: DocumentElements, onStatus: (status: DocumentStatus) => void) {
    this.#elements = elements;
    this.#onStatus = onStatus;
    this.#devicePixelRatio = window.devicePixelRatio || 1;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.#compositor = new Compositor({
      tiles: elements.tiles,
      overlay: elements.overlay,
      requestTile: (spec, patch) => this.#requestTile(spec, patch),
      onFrame: (report) => this.#frame(report),
      onViolation: () => this.#client?.violation(),
      blink: !reducedMotion,
    });
    this.#bridge = createInputBridge(this.#sink(), { keys: () => this.#keys });
    this.#mirror = new AccessibilityMirror(elements.mirror, this.#bridge, {
      load: (node, children) => this.#loadChildren(node, children),
      onViolation: () => this.#client?.violation(),
    });
    this.#mirror.clear();
    this.#status = {
      engine: "starting",
      message: "Starting the engine…",
      offer: null,
      reload: false,
      zoom: 1,
      bridge: this.#bridge.kind,
    };
    this.#listen();
  }

  get status(): DocumentStatus {
    return this.#status;
  }

  /** Checks and starts the engine worker, then opens the mock document. */
  async start(): Promise<void> {
    const started = performance.now();
    let worker: Worker;
    try {
      worker = await startEngineWorker();
      recordDuration(measureNames.engineVerify, started, performance.now());
    } catch {
      this.#setStatus({
        engine: "failed",
        message: "The engine could not be started: its files failed their integrity check.",
      });
      return;
    }
    if (this.#destroyed) {
      worker.terminate();
      return;
    }
    const client = new Client(worker);
    this.#client = client;
    client.onRoundTrip = (type: RequestType, milliseconds: number) =>
      recordDuration(roundTripName(type), performance.now() - milliseconds, performance.now());
    client.onState((state) => this.#engineState(state, started));
    client.onRestart((restart) => this.#restarted(client, restart));
    client.on("view.pages", (payload) => {
      if (payload.doc_id === this.#docId) this.#setPages(payload.pages);
    });
    client.on("render.invalidate", (payload) => {
      if (payload.doc_id !== this.#docId) return;
      this.#compositor.invalidate(payload.regions, payload.revision);
      const probe = this.#probes.findLast((candidate) => candidate.replied);
      probe?.invalidated.push(...payload.regions);
    });
    client.on("overlay.update", (payload) => {
      if (payload.doc_id !== this.#docId) return;
      // Mark the probe first: the compositor draws the overlay at once and reports it in the same call.
      const probe = this.#probes.findLast((candidate) => candidate.replied && !candidate.overlay);
      if (probe !== undefined) probe.overlay = true;
      this.#compositor.setOverlay(payload);
    });
    client.on("a11y.update", (payload) => {
      if (payload.doc_id === this.#docId) this.#mirror.update(payload);
    });
    // An engine.error with recoverable true ends nothing: the engine kept its state (spec §12). Its code and words are the engine's, which
    // the shell never shows; the client turns those with recoverable false into restarts or the stop (§14.2).
    if (await this.#startSession(client)) await this.#openDocument(client);
  }

  /** Takes the offer: opens the document a failure closed, or the one a failure kept from opening, when the user asks (spec §12.1). */
  reopen(): void {
    const client = this.#client;
    const offer = this.#status.offer;
    if (client === undefined || this.#destroyed || this.#stopped || offer === null) return;
    // The offer goes now. Keyboard focus on its button waits in the document area meanwhile (#setStatus), and goes into the document below.
    const focusWaits = this.#offerFocused();
    this.#setStatus({ offer: null, message: offer === "reopen" ? "Reopening the document…" : "Opening the document…" });
    void this.#openDocument(client).then((opened) => {
      if (!opened) return;
      this.#setStatus({ message: offer === "reopen" ? "The document was reopened." : "The document was opened." });
      // The button that was pressed is gone: keyboard focus that waited in the document area, or that is on the page, goes into the
      // document, unless it went elsewhere.
      const focused = document.activeElement;
      if (focused === null || focused === document.body || (focusWaits && focused === this.#elements.scroller)) {
        this.#bridge.focus();
      }
    });
  }

  zoomIn(): void {
    const next = zoomSteps.find((step) => step > this.#zoom + 1e-9);
    if (next !== undefined) this.setZoom(next);
  }

  zoomOut(): void {
    const next = [...zoomSteps].reverse().find((step) => step < this.#zoom - 1e-9);
    if (next !== undefined) this.setZoom(next);
  }

  /** Changes the zoom, keeping the point at the centre of the view where it is. */
  setZoom(zoom: number): void {
    if (zoom === this.#zoom || !(zoom >= 0.05 && zoom <= 64)) return;
    const scroller = this.#elements.scroller;
    const anchorX = scroller.clientWidth / 2;
    const anchorY = scroller.clientHeight / 2;
    const viewX = ((scroller.scrollLeft + anchorX - this.#layout.originX) * BLU_PER_DIP) / this.#zoom;
    const viewY = ((scroller.scrollTop + anchorY - this.#layout.originY) * BLU_PER_DIP) / this.#zoom;
    this.#zoom = zoom;
    this.#relayout();
    scroller.scrollTo({
      left: this.#layout.originX + (viewX * zoom) / BLU_PER_DIP - anchorX,
      top: this.#layout.originY + (viewY * zoom) / BLU_PER_DIP - anchorY,
      behavior: "instant",
    });
    this.#updateTransform();
    this.#scheduleViewSet();
    this.#setStatus({ zoom });
  }

  /** Gives the document keyboard focus. */
  focus(): void {
    this.#bridge.focus();
  }

  destroy(): void {
    this.#destroyed = true;
    this.#abort.abort();
    clearTimeout(this.#viewSetTimer);
    this.#resizeObserver?.disconnect();
    this.#devicePixelObserver?.disconnect();
    this.#client?.terminate();
    this.#compositor.destroy();
    this.#bridge.destroy();
  }

  #setStatus(change: Partial<DocumentStatus>): void {
    // The offer goes when the user takes it and at the stop (spec §12.1, point 3), and React then removes its button. Keyboard focus on
    // the button moves to the document area, the "Pages" region, before that: the browser would move it to the page itself, which leaves
    // a keyboard user nowhere (ADR-0020 decision 5). Not to whatever follows the button either, which the user never chose.
    if (change.offer === null && this.#offerFocused()) this.#elements.scroller.focus({ preventScroll: true });
    this.#status = { ...this.#status, ...change };
    this.#onStatus(this.#status);
  }

  /** Whether the offer's button has keyboard focus. */
  #offerFocused(): boolean {
    const button = this.#elements.offer.current;
    return button !== null && button === document.activeElement;
  }

  #engineState(state: EngineState, started: number): void {
    if (state.kind === "ready") {
      recordDuration(measureNames.engineStart, started, performance.now());
      this.#setStatus({ engine: "ready", message: `Engine ${state.engineVersion} ready.` });
    } else if (state.kind === "failed" && !this.#destroyed && !this.#stopped) {
      // The client stopped using the engine for good, and terminated its worker: only reloading the page brings it back (spec §12.1
      // step 1, §14.1, §14.2). After unsupported_protocol_version the update prompt replaces the stop message (§14.1 item 3).
      this.#stopped = true;
      this.#forgetSession();
      this.#setStatus({
        engine: "failed",
        offer: null,
        reload: state.reason === "unsupported_protocol_version",
        message: stopMessage(state.reason),
      });
    }
  }

  /**
   * The engine discarded its session and is ready for restart `number` of `limit`, which its bindings counted (spec §14.2): a new session
   * starts, without the document, and the user is told which restart this is (§12.1). Nothing of the error is shown: its code, message
   * identifier and arguments come from the engine.
   */
  #restarted(client: EngineClient, restart: Restart): void {
    if (this.#destroyed || this.#stopped) return;
    // What the failure closed decides what the message says and what is offered (spec §12.1, points 2 and 3).
    const closed = this.#docId !== null || this.#opening;
    const offer = closed || this.#status.offer === "reopen" ? "reopen" : "open";
    this.#forgetSession();
    const documentState = closed
      ? "The document was closed and can be reopened."
      : offer === "reopen"
        ? "The document is still closed and can be reopened."
        : "The document can be opened now.";
    this.#setStatus({
      offer,
      message: `The engine stopped working and was restarted (${restart.number} of ${restart.limit}). ${documentState}`,
    });
    void this.#startSession(client);
  }

  /** Forgets the session's document: replies and events that still arrive for it are dropped (spec §12.1, point 4). */
  #forgetSession(): void {
    // Keyboard focus that was in the document stays in the document area, the "Pages" region, when the document goes (spec §12.1,
    // point 3): not on the page, and never on the offer to reopen, which a key the user meant for the document would then accept.
    const scroller = this.#elements.scroller;
    const focused = document.activeElement;
    const keepFocus = focused !== null && focused !== scroller && scroller.contains(focused);
    this.#session += 1;
    this.#docId = null;
    this.#opening = false;
    this.#keys = noKeys;
    this.#probes = [];
    this.#compositor.reset();
    this.#setPages([]);
    this.#mirror.clear();
    if (keepFocus) scroller.focus({ preventScroll: true });
  }

  /**
   * hello and ui.manifest: a new session (spec §5, §14.1). Resolves with whether it started and is still the current one. hello offers
   * protocol version 1 and names the system the browser runs on, which the engine uses only to resolve the manifest's key bindings
   * (§14.3). A refused hello stops the client for good (src/engine/client.ts), and a refused ui.manifest leaves the session without keys.
   */
  async #startSession(client: EngineClient): Promise<boolean> {
    const session = this.#session;
    try {
      await client.request("hello", {
        protocol_versions: [PROTOCOL_VERSION],
        shell: { name: "bayan-web", version: "0.0.0", platform: browserPlatform(navigator), runtime: "browser" },
        capabilities: { ime: true, accessibility: true, clipboard_formats: ["text/plain"] },
        locale: navigator.language,
      });
      const manifest = await client.request("ui.manifest", { locale: navigator.language });
      if (session !== this.#session) return false;
      this.#keys = keyDataOf(manifest);
      return true;
    } catch (error) {
      // The session ended (EngineSessionEndedError: the engine.error that ended it says what follows), the client stopped (its state says
      // why), or the engine refused ui.manifest: then the document cannot be edited from the keyboard, and the user is told.
      if (error instanceof EngineSessionEndedError) return false;
      if (session === this.#session && !this.#destroyed && client.state.kind !== "failed") {
        this.#setStatus({ message: "The document could not be opened." });
      }
      return false;
    }
  }

  /** doc.open, view.set and query.a11y: opens the mock document in the current session (spec §11). Resolves with whether it opened. */
  async #openDocument(client: EngineClient): Promise<boolean> {
    const session = this.#session;
    this.#opening = true;
    let ended = false;
    try {
      // Until real documents can be opened, the engine opens its mock document whatever the bytes are (spec §6.1).
      const file = new ArrayBuffer(0);
      const opened = await client.request("doc.open", { blob: file }, [file]);
      if (session !== this.#session) return false;
      this.#docId = opened.doc_id;
      this.#compositor.setRevision(opened.revision);
      // In print mode the first view.set invalidates nothing (spec §14.6 item 2): the compositor requests the tiles it shows by itself.
      await this.#sendViewSet();
      if (session !== this.#session) return false;
      const tree = await client.request("query.a11y", { doc_id: opened.doc_id });
      if (session !== this.#session) return false;
      if (tree.doc_id !== opened.doc_id) {
        client.violation();
        return false;
      }
      this.#mirror.setTree(tree);
      // A tree that breaks the protocol has stopped the engine meanwhile, and ended the session.
      if (session !== this.#session) return false;
      this.#placeBridge();
      return true;
    } catch (error) {
      // A request of a session that ended (EngineSessionEndedError) changes nothing: the engine.error that ended it says what follows.
      ended = error instanceof EngineSessionEndedError;
      if (session === this.#session && !this.#destroyed && !ended && client.state.kind !== "failed") {
        this.#setStatus({ message: "The document could not be opened." });
      }
      return false;
    } finally {
      // The engine.error of a panic comes just after its reply (spec §12.1, point 4): until then, the document is still being opened.
      if (session === this.#session && !ended) this.#opening = false;
    }
  }

  /**
   * Loads a part of a node's children for the mirror (query.a11y with a children range, spec §14.7 item 1). An answer for another document
   * breaks the protocol.
   */
  async #loadChildren(node: number, children: ChildRange): Promise<A11yTree> {
    const client = this.#client;
    const docId = this.#docId;
    if (client === undefined || docId === null) throw new Error("no document");
    const tree = await client.request("query.a11y", { doc_id: docId, node, children });
    if (tree.doc_id !== docId) {
      client.violation();
      throw new Error("an answer for another document");
    }
    return tree;
  }

  #listen(): void {
    const signal = this.#abort.signal;
    const scroller = this.#elements.scroller;
    scroller.addEventListener("scroll", () => this.#updateTransform(), { passive: true, signal });
    // A mouse press reaches the engine from its mousedown, whose detail is the click count (following the system's double-click
    // settings): PointerEvent.detail is 0 in Chromium and Firefox. Touch and pen presses are sent from pointerdown; the mousedown that
    // browsers fire after them for compatibility is not sent again.
    scroller.addEventListener(
      "pointerdown",
      (event) => {
        if (event.pointerType === "mouse") this.#mousePress = true;
        else this.#pointer(event, "down", event.pointerType, Math.max(1, event.detail));
      },
      { signal },
    );
    scroller.addEventListener(
      "mousedown",
      (event) => {
        const press = this.#mousePress;
        this.#mousePress = false;
        if (!this.#onContent(event)) return;
        // Keep keyboard focus in the document when it is clicked (a click would otherwise move focus to the page).
        event.preventDefault();
        if (!press) return;
        this.#clicks = Math.max(1, event.detail);
        this.#pointer(event, "down", "mouse", this.#clicks);
      },
      { signal },
    );
    const release = (event: PointerEvent, kind: "up" | "cancel") =>
      this.#pointer(
        event,
        kind,
        event.pointerType,
        event.pointerType === "mouse" ? this.#clicks : Math.max(1, event.detail),
      );
    scroller.addEventListener("pointerup", (event) => release(event, "up"), { signal });
    scroller.addEventListener("pointercancel", (event) => release(event, "cancel"), { signal });
    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(scroller);
    this.#watchResolution();
  }

  /**
   * devicePixelRatio changes when the window moves to another screen or the browser zooms. The resolution media query reports a change of
   * screen; browser zoom also resizes the window, and some changes (such as the DevTools' device emulation) only do that, so both are
   * watched and compare the current value with the one the canvases were sized for.
   */
  #watchResolution(): void {
    const signal = this.#abort.signal;
    const check = () => {
      const ratio = window.devicePixelRatio || 1;
      if (this.#destroyed || ratio === this.#devicePixelRatio) return;
      this.#devicePixelRatio = ratio;
      this.#resize();
      this.#watchResolution();
    };
    this.#resolutionQuery = window.matchMedia(`(resolution: ${this.#devicePixelRatio}dppx)`);
    this.#resolutionQuery.addEventListener("change", check, { once: true, signal });
    if (!this.#watchingResize) {
      this.#watchingResize = true;
      window.addEventListener("resize", check, { signal });
      // The scroller's size in device pixels changes with the ratio even when nothing else does (Chromium and Firefox report it;
      // Safari does not know this box and throws, and then the two signals above remain).
      try {
        this.#devicePixelObserver = new ResizeObserver(check);
        this.#devicePixelObserver.observe(this.#elements.scroller, { box: "device-pixel-content-box" });
      } catch {
        this.#devicePixelObserver = undefined;
      }
    }
  }

  #resize(): void {
    const scroller = this.#elements.scroller;
    this.#compositor.resize(scroller.clientWidth, scroller.clientHeight, this.#devicePixelRatio);
    this.#relayout();
    this.#updateTransform();
    this.#scheduleViewSet();
  }

  #setPages(pages: readonly PageInfo[]): void {
    this.#pages = pages;
    this.#compositor.setPages(pages);
    this.#relayout();
    this.#updateTransform();
  }

  /** Sizes the scrolled content to the page area at the current zoom, centred in the view. */
  #relayout(): void {
    this.#layout = contentLayout(pageAreaSize(this.#pages), this.#zoom, this.#elements.scroller.clientWidth);
    this.#elements.extent.style.width = `${this.#layout.width}px`;
    this.#elements.extent.style.height = `${this.#layout.height}px`;
  }

  #transform(): ViewTransform {
    const scroller = this.#elements.scroller;
    return {
      zoom: this.#zoom,
      devicePixelRatio: this.#devicePixelRatio,
      layout: this.#layout,
      scrollX: scroller.scrollLeft,
      scrollY: scroller.scrollTop,
      viewportWidth: scroller.clientWidth,
      viewportHeight: scroller.clientHeight,
    };
  }

  #updateTransform(): void {
    this.#compositor.setTransform(this.#transform());
  }

  /**
   * The view is sent when the zoom, devicePixelRatio or size changes, at most once per quiet period, not while scrolling. In print mode the
   * engine invalidates nothing for it (spec §14.6 item 2): the compositor requests the tiles of a new scale itself.
   */
  #scheduleViewSet(): void {
    clearTimeout(this.#viewSetTimer);
    this.#viewSetTimer = setTimeout(() => void this.#sendViewSet(), 100);
  }

  async #sendViewSet(): Promise<void> {
    const client = this.#client;
    if (client === undefined || this.#docId === null) return;
    try {
      await client.request("view.set", {
        doc_id: this.#docId,
        viewport: engineViewport(this.#transform()),
        zoom: this.#zoom,
        device_scale: Math.min(16, this.#devicePixelRatio),
        mode: "print",
      });
    } catch {
      // The engine refused or stopped; its state handler reports it.
    }
  }

  #requestTile(spec: TileSpec, patch?: TilePatch): Promise<{ bitmap: ImageBitmap; hash: string; revision: number }> {
    const client = this.#client;
    if (client === undefined || this.#docId === null) return Promise.reject(new Error("no document"));
    return client.request("render.tile", {
      doc_id: this.#docId,
      page: spec.page,
      rect: patch?.rect ?? spec.rect,
      width: patch?.width ?? spec.width,
      height: patch?.height ?? spec.height,
      zoom: this.#zoom,
      device_scale: Math.min(16, this.#devicePixelRatio),
      mode: "interactive",
    });
  }

  /** Whether a mouse event is on the scroller's content rather than on one of its scrollbars. */
  #onContent(event: MouseEvent): boolean {
    const scroller = this.#elements.scroller;
    const box = scroller.getBoundingClientRect();
    return event.clientX - box.left < scroller.clientWidth && event.clientY - box.top < scroller.clientHeight;
  }

  /** Sends a press or release; `clicks` is the click count of the press it belongs to. */
  #pointer(event: MouseEvent, kind: "down" | "up" | "cancel", pointerType: string, clicks: number): void {
    if (!this.#onContent(event) || this.#client === undefined || this.#docId === null) return;
    // Focus moves to the editable text when the button is released, as a native text field's would be by then: Orca in Chromium stays
    // in browse mode when focus moves on press, and would then take the user's typing as its own commands (WEB-002 report).
    if (kind === "up") this.#bridge.focus();
    const box = this.#elements.scroller.getBoundingClientRect();
    const position = pointerToView(this.#transform(), event.clientX - box.left, event.clientY - box.top);
    const known = pointerType === "mouse" || pointerType === "pen" || pointerType === "touch";
    void this.#client
      .request("input.pointer", {
        doc_id: this.#docId,
        kind,
        x: position.x,
        y: position.y,
        button: event.button,
        clicks,
        modifiers: { shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey },
        ...(known ? { pointer_type: pointerType as "mouse" | "pen" | "touch" } : {}),
      })
      .catch(() => undefined);
  }

  /** What the input bridge reports, as engine messages; each starts a latency probe. */
  #sink(): InputSink {
    const send = (time: number, request: () => Promise<unknown> | undefined) => {
      const probe: Probe = {
        start: time,
        replied: false,
        overlay: false,
        overlayDrawn: false,
        invalidated: [],
        tileDrawn: false,
      };
      const sent = request();
      if (sent === undefined) return;
      this.#probes.push(probe);
      if (this.#probes.length > 64) this.#probes.shift();
      sent.then(
        () => {
          // Replies come before the events of the same message (spec §3.2), so an earlier probe that has seen no event by now
          // changed nothing on screen and is dropped.
          this.#probes = this.#probes.filter(
            (candidate) =>
              candidate === probe || candidate.overlay || candidate.invalidated.length > 0 || !candidate.replied,
          );
          probe.replied = true;
        },
        () => {
          this.#probes = this.#probes.filter((candidate) => candidate !== probe);
        },
      );
    };
    const docId = () => this.#docId;
    return {
      key: (message: Omit<InputKey, "doc_id">, time) => {
        const id = docId();
        send(time, () => (id === null ? undefined : this.#client?.request("input.key", { ...message, doc_id: id })));
      },
      text: (text, time) => {
        const id = docId();
        send(time, () => (id === null ? undefined : this.#client?.request("input.text", { doc_id: id, text })));
      },
      composition: (phase, text, selection, time) => {
        const id = docId();
        send(time, () =>
          id === null
            ? undefined
            : this.#client?.request("input.composition", {
                doc_id: id,
                phase,
                text,
                ...(selection === null ? {} : { selection }),
              }),
        );
      },
      focusChanged: (focused) => this.#compositor.setFocused(focused),
    };
  }

  /** After each frame: place the input bridge at the caret, and complete the latency probes whose results this frame showed. */
  #frame(report: FrameReport): void {
    if (report.drewOverlay) this.#placeBridge();
    const drawnAt = performance.now();
    for (const probe of this.#probes) {
      if (report.drewOverlay && probe.overlay && !probe.overlayDrawn) {
        probe.overlayDrawn = true;
        recordDuration(measureNames.keyToOverlayDrawn, probe.start, drawnAt);
        // The time inside the next frame's callback, not its timestamp (the frame's start, which can precede the key press). That frame
        // paints the overlay; painting, compositing and the display come after, so this is a lower bound of keystroke-to-pixel latency.
        requestAnimationFrame(() => recordDuration(measureNames.keyToOverlayFrame, probe.start, performance.now()));
      }
      const showsChange = report.arrived.some((tile) =>
        probe.invalidated.some((region) => region.page === tile.page && intersects(region.rect, tile.rect)),
      );
      if (showsChange && !probe.tileDrawn) {
        probe.tileDrawn = true;
        recordDuration(measureNames.keyToTileDrawn, probe.start, drawnAt);
      }
    }
    this.#probes = this.#probes.filter((probe) => !finished(probe));
  }

  /** Puts the input bridge at the caret and tells it where the editable text's characters are on screen. */
  #placeBridge(): void {
    const canvas = this.#elements.tiles.getBoundingClientRect();
    const caret = this.#compositor.caretBox();
    const editable: A11yNode | undefined = this.#mirror.editable;
    const toClient = (box: { x: number; y: number; width: number; height: number }) =>
      new DOMRect(canvas.left + box.x, canvas.top + box.y, box.width, box.height);
    this.#bridge.place({
      control: this.#elements.scroller.getBoundingClientRect(),
      caret: caret === null ? null : toClient(caret),
      characters: (start, end) => {
        const page = editable?.bounds?.page;
        if (page === undefined) return [];
        return (editable?.chars ?? [])
          .filter((box) => box.start >= start && box.end <= end)
          .map((box) => this.#compositor.pageBox(page, box.rect))
          .filter((box) => box !== null)
          .map(toClient);
      },
    });
  }
}
