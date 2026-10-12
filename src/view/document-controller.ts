// Connects the engine worker, the tile compositor, the input bridge and the accessibility mirror for one document view (WEB-002).
//
// It runs the session (hello, ui.manifest, doc.open, view.set, query.a11y; spec §5, §11), turns the engine's events into drawing,
// mirror updates and bridge updates, turns scrolling, zooming, devicePixelRatio changes, pointer presses and the bridge's input into
// messages, and measures the latencies of WEB-002 (src/metrics.ts). The scroll-and-draw path is imperative and allocation-light; React
// only renders the frame around it and the status line (DocumentView.tsx).

import { AccessibilityMirror } from "../a11y/mirror.ts";
import { EngineClient as Client, type EngineClient, EngineRequestError, type EngineState } from "../engine/client.ts";
import type { A11yNode, InputKey, PageInfo, PageRect, RequestType } from "../engine/protocol.ts";
import { BLU_PER_DIP, PROTOCOL_VERSION } from "../engine/protocol.ts";
import { startEngineWorker } from "../engine/start.ts";
import type { InputBridge, InputSink } from "../input/bridge.ts";
import { createInputBridge } from "../input/create-bridge.ts";
import { isApplePlatform, manifestShortcuts, type Shortcut } from "../input/keys.ts";
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
  /** A short message for people; never document content. */
  readonly message: string;
  readonly zoom: number;
  readonly bridge: InputBridge["kind"];
}

export interface DocumentElements {
  /** The scrolling element; its content is `extent`, sized like the page area. */
  readonly scroller: HTMLElement;
  readonly extent: HTMLElement;
  readonly tiles: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
  /** The accessibility mirror's container, inside `extent`. */
  readonly mirror: HTMLElement;
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
  #shortcuts: Shortcut[] = [];
  #status: DocumentStatus;
  #probes: Probe[] = [];
  #viewSetTimer: ReturnType<typeof setTimeout> | undefined;
  #resizeObserver: ResizeObserver | undefined;
  #resolutionQuery: MediaQueryList | undefined;
  #watchingResize = false;
  #devicePixelObserver: ResizeObserver | undefined;
  #destroyed = false;

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
      blink: !reducedMotion,
    });
    this.#bridge = createInputBridge(this.#sink(), {
      shortcuts: () => this.#shortcuts,
      apple: isApplePlatform(navigator.platform),
    });
    this.#mirror = new AccessibilityMirror(elements.mirror, this.#bridge);
    this.#mirror.clear();
    this.#status = { engine: "starting", message: "Starting the engine…", zoom: 1, bridge: this.#bridge.kind };
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
    client.on("view.pages", (payload) => {
      if (payload.doc_id === this.#docId) this.#setPages(payload.pages);
    });
    client.on("render.invalidate", (payload) => {
      if (payload.doc_id !== this.#docId) return;
      this.#compositor.invalidate(payload.regions);
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
    client.on("engine.error", (payload) => {
      // A panic discarded the session (spec §12): start a new one. A recoverable error needs nothing.
      if (!payload.recoverable) void this.#openSession(client);
    });
    await this.#openSession(client);
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
    this.#status = { ...this.#status, ...change };
    this.#onStatus(this.#status);
  }

  #engineState(state: EngineState, started: number): void {
    if (state.kind === "ready") {
      recordDuration(measureNames.engineStart, started, performance.now());
      this.#setStatus({ engine: "ready", message: `Engine ${state.engineVersion} ready.` });
    } else if (state.kind === "failed" && !this.#destroyed) {
      this.#setStatus({ engine: "failed", message: "The engine stopped. Reload the page to start it again." });
    }
  }

  /** hello, ui.manifest, doc.open, view.set and query.a11y: a new session with the mock document (spec §5, §11). */
  async #openSession(client: EngineClient): Promise<void> {
    this.#docId = null;
    this.#compositor.reset();
    this.#mirror.clear();
    try {
      await client.request("hello", {
        protocol_versions: [PROTOCOL_VERSION],
        shell: { name: "bayan-web", version: "0.0.0", platform: "web" },
        capabilities: { ime: true, accessibility: true, clipboard_formats: ["text/plain"] },
        locale: navigator.language,
      });
      const manifest = await client.request("ui.manifest", { locale: navigator.language });
      this.#shortcuts = manifestShortcuts(manifest.commands);
      // v0 opens its mock document whatever the bytes are (spec §6.1).
      const file = new ArrayBuffer(0);
      const opened = await client.request("doc.open", { blob: file }, [file]);
      this.#docId = opened.doc_id;
      await this.#sendViewSet();
      const tree = await client.request("query.a11y", { doc_id: opened.doc_id });
      this.#mirror.setTree(tree);
      this.#placeBridge();
    } catch (error) {
      if (!this.#destroyed && !(error instanceof EngineRequestError && error.info.code === "panic")) {
        this.#setStatus({ message: "The document could not be opened." });
      }
    }
  }

  #listen(): void {
    const signal = this.#abort.signal;
    const scroller = this.#elements.scroller;
    scroller.addEventListener("scroll", () => this.#updateTransform(), { passive: true, signal });
    // Keep keyboard focus in the document when it is clicked (a click would otherwise move focus to the page), except on scrollbars.
    scroller.addEventListener(
      "mousedown",
      (event) => {
        if (this.#onContent(event)) event.preventDefault();
      },
      { signal },
    );
    scroller.addEventListener("pointerdown", (event) => this.#pointer(event, "down"), { signal });
    scroller.addEventListener("pointerup", (event) => this.#pointer(event, "up"), { signal });
    scroller.addEventListener("pointercancel", (event) => this.#pointer(event, "cancel"), { signal });
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
   * v0's engine answers every view.set by invalidating every page (spec §6.2), so the view is sent only when what the tiles depend on
   * changes (zoom, devicePixelRatio, size), never while scrolling, and at most once per quiet period.
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

  #requestTile(spec: TileSpec, patch?: TilePatch): Promise<{ bitmap: ImageBitmap; hash: string }> {
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

  #pointer(event: PointerEvent, kind: "down" | "up" | "cancel"): void {
    if (!this.#onContent(event) || this.#client === undefined || this.#docId === null) return;
    if (kind === "down") this.#bridge.focus();
    const box = this.#elements.scroller.getBoundingClientRect();
    const position = pointerToView(this.#transform(), event.clientX - box.left, event.clientY - box.top);
    const pointerType = event.pointerType === "mouse" || event.pointerType === "pen" || event.pointerType === "touch";
    void this.#client
      .request("input.pointer", {
        doc_id: this.#docId,
        kind,
        x: position.x,
        y: position.y,
        button: event.button,
        clicks: event.detail,
        modifiers: { shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey },
        ...(pointerType ? { pointer_type: event.pointerType as "mouse" | "pen" | "touch" } : {}),
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
        // The time inside the next frame's callback, not its timestamp (the frame's start, which can precede the key press).
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
