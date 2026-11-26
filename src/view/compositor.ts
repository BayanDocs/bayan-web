// The tile compositor (ADR-0014 §4, ADR-0011 §5): draws the engine's tiles, transferred from the worker as ImageBitmaps, onto a Canvas 2D
// that covers the visible part of the document, and draws the overlays (caret and selection) on a second canvas above it, so that a
// blinking caret or a moved selection never redraws the tiles. It runs on the main thread and never waits for the engine: it draws what it
// has on every frame that needs it, requests the tiles it lacks (one at a time, so that input messages never queue behind a flood of
// tile requests in the worker), and keeps drawing old tiles, scaled, until new ones arrive. When the engine invalidates part of a tile it
// has, it asks for just that part (a patch) and draws it over the tile, instead of rendering the whole tile again: typing changes a strip
// a few dozen pixels tall, and re-rendering two 512-pixel tiles for each key press was the largest cost in WEB-002's latency figures.
//
// Which tiles are current is decided by render revision (engine protocol §14.6 item 1), in the tile book (tile-book.ts): a tile is kept
// while no invalidation with a higher revision covers it, in whatever order tiles and invalidations arrive. The compositor requests the
// tiles of a new scale itself: in print mode a new zoom or device-pixel ratio invalidates nothing (§14.6 item 2).

import { BLU_PER_DIP, type OverlayUpdate, type PageInfo, type PageRect, type Rect } from "../engine/protocol.ts";
import { type HeldTile, TileBook, type TileRequest } from "./tile-book.ts";
import {
  type DrawTile,
  drawOrder,
  type PlacedPage,
  scaleKey,
  type TilePatch,
  type TileSpec,
  toCanvas,
  type ViewTransform,
  viewScale,
  visiblePages,
  visibleTiles,
} from "./tiles.ts";

/** What a tile request resolves with: the reply to render.tile on the web (spec §3.2), with the render revision it shows (§14.6). */
export interface TileImage {
  readonly bitmap: ImageBitmap;
  readonly hash: string;
  readonly revision: number;
}

/** What one frame drew, for measurements. */
export interface FrameReport {
  /** The frame's time (requestAnimationFrame's timestamp). */
  readonly time: number;
  readonly drewTiles: boolean;
  readonly drewOverlay: boolean;
  /** The parts of pages whose fresh pixels (tiles or patches) arrived since the last frame and were drawn in this one. */
  readonly arrived: readonly PageRect[];
}

export interface CompositorOptions {
  readonly tiles: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
  /** Renders a tile, or only a patch of it when `patch` is given. */
  readonly requestTile: (spec: TileSpec, patch?: TilePatch) => Promise<TileImage>;
  readonly onFrame?: (report: FrameReport) => void;
  /** A tile older than a revision the compositor had seen when it requested it: the engine broke the protocol (§14.1 item 5, §14.6). */
  readonly onViolation?: () => void;
  /** Whether the caret may blink; false when the user prefers reduced motion. */
  readonly blink?: boolean;
}

type Held = HeldTile<ImageBitmap>;

/**
 * At most this many tile requests wait in the worker at once. The worker handles messages in order, so a key press waits behind every
 * tile request already queued; one keeps that wait to a single tile's rendering (WEB-002's measurements).
 */
const MAX_IN_FLIGHT = 1;
/** Tiles just outside the view are requested too, this many device pixels around it, so that slow scrolling finds them ready. */
const PREFETCH_PIXELS = 256;
/** The memory the held tiles may take, in bytes of RGBA pixels. */
const MEMORY_BUDGET = 160 * 1024 * 1024;
/** Half a blink period of the caret, as in most systems. */
const BLINK_MS = 530;

const PLACEHOLDER = "rgba(128, 128, 128, 0.25)";
const CARET = "#000000";
const SELECTION = "rgba(51, 132, 255, 0.35)";

/**
 * A copy of a bitmap from the worker, in storage that the main thread owns; the transferred bitmap is closed. In Playwright's WebKit 26.6
 * on Linux, a tile's transferred bitmap sometimes showed another tile's pixels a while after it arrived, although the engine had rendered
 * the right ones (the hash in its reply was right): its storage was apparently reused for a bitmap that the worker made later. Copying
 * each tile and patch as it arrives keeps the pixels the compositor draws its own (WEB-002 report, section 11). Chromium and Firefox never
 * showed it; the copy costs one blit per tile or patch.
 */
function ownedCopy(bitmap: ImageBitmap): ImageBitmap {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  if (context === null) return bitmap;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.transferToImageBitmap();
}

export class Compositor {
  readonly #options: CompositorOptions;
  readonly #tiles: CanvasRenderingContext2D;
  readonly #overlay: CanvasRenderingContext2D;
  #pages: readonly PageInfo[] = [];
  #transform: ViewTransform | undefined;
  #overlayState: OverlayUpdate | null = null;
  /** The render revision of the overlay drawn: an older one that arrives later is not drawn over it (§14.6 item 1). */
  #overlayRevision = 0;
  #focused = false;
  #caretOn = true;
  #blinkTimer: ReturnType<typeof setInterval> | undefined;
  readonly #book = new TileBook<ImageBitmap>((bitmap) => bitmap.close());
  /** Increases whenever the document or session changes, so that replies to older requests are dropped. */
  #generation = 0;
  #frame = 0;
  #frameRequested = false;
  #tilesDirty = true;
  #overlayDirty = true;
  #arrived: PageRect[] = [];
  #destroyed = false;

  constructor(options: CompositorOptions) {
    this.#options = options;
    const tiles = options.tiles.getContext("2d");
    const overlay = options.overlay.getContext("2d");
    if (tiles === null || overlay === null) {
      throw new Error("This browser cannot draw on a 2D canvas.");
    }
    this.#tiles = tiles;
    this.#overlay = overlay;
  }

  /**
   * The document's pages (view.pages). The tiles of a page whose size is unchanged are kept, so that a view.pages that changes nothing
   * (or only other pages) never leaves a page empty until fresh tiles arrive.
   */
  setPages(pages: readonly PageInfo[]): void {
    for (const [key, held] of [...this.#book.held]) {
      const before = this.#pages[held.spec.page];
      const after = pages[held.spec.page];
      if (
        before === undefined ||
        after === undefined ||
        before.width !== after.width ||
        before.height !== after.height
      ) {
        this.#book.releaseTile(key);
      }
    }
    this.#pages = pages;
    this.#scheduleFrame(true, true);
  }

  /** The document's render revision when it opened (doc.opened, §14.6 item 1). */
  setRevision(revision: number): void {
    this.#book.saw(revision);
  }

  /** Forgets every tile and request, for a new session or document. */
  reset(): void {
    this.#generation += 1;
    this.#book.reset();
    this.#pages = [];
    this.#overlayState = null;
    this.#overlayRevision = 0;
    this.#scheduleFrame(true, true);
  }

  /** Sizes both canvases to the visible part of the scroller, in device pixels. */
  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
    for (const canvas of [this.#options.tiles, this.#options.overlay]) {
      const width = Math.max(1, Math.round(cssWidth * devicePixelRatio));
      const height = Math.max(1, Math.round(cssHeight * devicePixelRatio));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
    }
    this.#scheduleFrame(true, true);
  }

  /** Scroll position, zoom, devicePixelRatio and layout. Cheap: it only schedules a frame. */
  setTransform(transform: ViewTransform): void {
    this.#transform = transform;
    this.#scheduleFrame(true, true);
  }

  /**
   * render.invalidate: the document is at `revision` now, and these regions changed since the previous revision. The parts of the held tiles
   * inside them whose pixels are older are requested again (as patches, or whole), and the tiles are drawn as they are until the new
   * pixels arrive, so an edit never makes the page flicker (tile-book.ts).
   */
  invalidate(regions: readonly PageRect[], revision: number): void {
    for (const region of regions) this.#book.invalidate(region.page, region.rect, revision);
    this.#scheduleFrame(false, false);
  }

  /**
   * overlay.update: the caret and selection to draw over the tiles. They are drawn at once, not in the next animation frame: the browser
   * presents a canvas change with its next frame either way, and waiting for requestAnimationFrame would add up to a whole frame to
   * the keystroke-to-caret latency (WEB-002 measured it; requirement PERF-04).
   */
  setOverlay(overlay: OverlayUpdate): void {
    if (overlay.revision < this.#overlayRevision) return;
    this.#overlayRevision = overlay.revision;
    this.#overlayState = overlay;
    this.#caretOn = true;
    this.#restartBlink();
    if (this.#transform === undefined || this.#destroyed) {
      this.#scheduleFrame(false, true);
      return;
    }
    this.#drawOverlay();
    this.#options.onFrame?.({ time: performance.now(), drewTiles: false, drewOverlay: true, arrived: [] });
  }

  /** The caret shows only while the document has keyboard focus. */
  setFocused(focused: boolean): void {
    this.#focused = focused;
    this.#caretOn = true;
    this.#restartBlink();
    this.#scheduleFrame(false, true);
  }

  /** The caret's rectangle in CSS pixels relative to the canvas, or null: for the input bridge, which places the input method there. */
  caretBox(): { x: number; y: number; width: number; height: number } | null {
    const caret = this.#overlayState?.caret;
    const page = caret ? this.#pages[caret.page] : undefined;
    if (!caret || page === undefined || this.#transform === undefined) return null;
    const box = this.#deviceBox(page, caret.rect);
    const ratio = this.#transform.devicePixelRatio;
    return { x: box.x / ratio, y: box.y / ratio, width: box.width / ratio, height: box.height / ratio };
  }

  /** A rectangle on a page, in CSS pixels relative to the canvas, or null if the page is unknown. */
  pageBox(pageIndex: number, rect: Rect): { x: number; y: number; width: number; height: number } | null {
    const page = this.#pages[pageIndex];
    if (page === undefined || this.#transform === undefined) return null;
    const box = this.#deviceBox(page, rect);
    const ratio = this.#transform.devicePixelRatio;
    return { x: box.x / ratio, y: box.y / ratio, width: box.width / ratio, height: box.height / ratio };
  }

  destroy(): void {
    this.#destroyed = true;
    clearInterval(this.#blinkTimer);
    this.reset();
  }

  #restartBlink(): void {
    clearInterval(this.#blinkTimer);
    this.#blinkTimer = undefined;
    if (this.#options.blink !== false && this.#focused && !this.#destroyed) {
      this.#blinkTimer = setInterval(() => {
        this.#caretOn = !this.#caretOn;
        this.#scheduleFrame(false, true);
      }, BLINK_MS);
    }
  }

  #scheduleFrame(tiles: boolean, overlay: boolean): void {
    this.#tilesDirty ||= tiles;
    this.#overlayDirty ||= overlay;
    if (this.#frameRequested || this.#destroyed) return;
    this.#frameRequested = true;
    requestAnimationFrame((time) => this.#drawFrame(time));
  }

  #drawFrame(time: number): void {
    this.#frameRequested = false;
    const transform = this.#transform;
    if (transform === undefined || this.#destroyed) return;
    this.#frame += 1;
    const scale = viewScale(transform.zoom, transform.devicePixelRatio);
    const canvas = this.#options.tiles;
    const placed = visiblePages(this.#pages, transform, canvas.width, canvas.height);
    // Request and release tiles before drawing, so that no frame draws a stand-in that the same frame lets go of: the state the
    // compositor reports (data-tiles-missing and the others) then always describes what the canvas shows.
    if (this.#pump(transform, scale)) this.#tilesDirty = true;
    const drewTiles = this.#tilesDirty;
    const drewOverlay = this.#overlayDirty;
    if (this.#tilesDirty) {
      this.#tilesDirty = false;
      this.#drawTiles(placed, scale);
    }
    if (this.#overlayDirty) {
      this.#overlayDirty = false;
      this.#drawOverlay();
    }
    const arrived = this.#arrived;
    this.#arrived = [];
    this.#options.onFrame?.({ time, drewTiles, drewOverlay, arrived });
  }

  #drawTiles(placed: readonly PlacedPage[], scale: number): void {
    const context = this.#tiles;
    const canvas = this.#options.tiles;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    const held = [...this.#book.held.values()];
    let placeholders = 0;
    for (const page of placed) {
      const order = drawOrder(page, scale, held);
      if (order.length === 0) {
        const size = this.#deviceBox(page.page, { x: 0, y: 0, width: page.page.width, height: page.page.height });
        context.fillStyle = PLACEHOLDER;
        context.fillRect(size.x, size.y, size.width, size.height);
        placeholders += 1;
        continue;
      }
      for (const draw of order as DrawTile<Held>[]) {
        const tile = draw.tile;
        tile.lastUsed = this.#frame;
        context.drawImage(tile.image, draw.x, draw.y, draw.width, draw.height);
        const scaleX = draw.width / tile.spec.width;
        const scaleY = draw.height / tile.spec.height;
        for (const { image, place } of tile.patches) {
          context.drawImage(
            image,
            draw.x + place.x * scaleX,
            draw.y + place.y * scaleY,
            place.width * scaleX,
            place.height * scaleY,
          );
        }
      }
    }
    // For measurements: visible pages that had no tile at all and showed a placeholder in this frame.
    canvas.dataset["placeholderPages"] = String(placeholders);
  }

  #drawOverlay(): void {
    const context = this.#overlay;
    const canvas = this.#options.overlay;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const state = this.#overlayState;
    if (state === null) return;
    context.fillStyle = SELECTION;
    for (const selection of state.selection) {
      const page = this.#pages[selection.page];
      if (page === undefined) continue;
      for (const rect of selection.rects) {
        const box = this.#deviceBox(page, rect);
        context.fillRect(box.x, box.y, box.width, box.height);
      }
    }
    const caret = state.caret;
    const page = caret ? this.#pages[caret.page] : undefined;
    if (caret?.visible && page !== undefined && this.#focused && this.#caretOn) {
      const box = this.#deviceBox(page, caret.rect);
      const ratio = this.#transform?.devicePixelRatio ?? 1;
      context.fillStyle = CARET;
      context.fillRect(box.x, box.y, Math.max(Math.round(ratio), box.width), box.height);
    }
  }

  /** A rectangle in page BLU as device pixels on the canvas, positioned from the page's rounded origin like the tiles. */
  #deviceBox(page: PageInfo, rect: Rect): { x: number; y: number; width: number; height: number } {
    const transform = this.#transform;
    if (transform === undefined) return { x: 0, y: 0, width: 0, height: 0 };
    const origin = toCanvas(transform, page.x, page.y);
    const factor = viewScale(transform.zoom, transform.devicePixelRatio) / BLU_PER_DIP;
    const x = origin.x + Math.round(rect.x * factor);
    const y = origin.y + Math.round(rect.y * factor);
    return {
      x,
      y,
      width: origin.x + Math.round((rect.x + rect.width) * factor) - x,
      height: origin.y + Math.round((rect.y + rect.height) * factor) - y,
    };
  }

  /**
   * Requests the visible tiles that are missing or stale, nearest first, and lets go of tiles beyond the memory budget. Returns whether
   * it let go of stand-in tiles that the canvas may still show.
   */
  #pump(transform: ViewTransform, scale: number): boolean {
    const canvas = this.#options.tiles;
    const placed = visiblePages(this.#pages, transform, canvas.width, canvas.height, PREFETCH_PIXELS);
    const wanted = placed.flatMap((page) => visibleTiles(page, scale, canvas.width, canvas.height, PREFETCH_PIXELS));
    let missing = 0;
    for (const spec of wanted) {
      const held = this.#book.held.get(spec.key);
      if (held !== undefined) held.lastUsed = this.#frame;
      if (!this.#book.isStale(spec.key)) continue;
      missing += 1;
      if (this.#book.inFlight.size >= MAX_IN_FLIGHT) continue;
      const request = this.#book.next(spec);
      if (request !== null) this.#send(request);
    }
    // Once the current scale covers the visible part of a page, the stand-in tiles of other scales are no longer needed.
    const current = scaleKey(scale);
    let released = false;
    if (missing === 0) {
      for (const [key, held] of [...this.#book.held]) {
        if (held.spec.scaleKey !== current && placed.some((page) => page.page.index === held.spec.page)) {
          this.#book.releaseTile(key);
          released = true;
        }
      }
    }
    // For measurements: tiles in view (without the prefetch margin) that are not yet fresh at the current scale; while there are any,
    // the view shows stale or scaled stand-ins.
    const inView = visiblePages(this.#pages, transform, canvas.width, canvas.height).flatMap((page) =>
      visibleTiles(page, scale, canvas.width, canvas.height),
    );
    const visibleMissing = inView.filter((spec) => this.#book.isStale(spec.key)).length;
    this.#evict(new Set(wanted.map((spec) => spec.key)));
    const bytes = [...this.#book.held.values()].reduce((sum, held) => sum + held.bytes, 0);
    const data = this.#options.tiles.dataset;
    data["tilesHeld"] = String(this.#book.held.size);
    data["tileBytes"] = String(bytes);
    data["tilesInFlight"] = String(this.#book.inFlight.size);
    data["tilesMissing"] = String(missing);
    data["tilesVisibleMissing"] = String(visibleMissing);
    // Draw without them: a stand-in scaled to a fractional size can reach a pixel past the fresh tiles at a page's edge.
    return released;
  }

  /** Sends a request of the tile book, and hands it the reply; a reply of an earlier generation is dropped. */
  #send(request: TileRequest<ImageBitmap>): void {
    const { spec, patch } = request;
    const generation = this.#generation;
    this.#book.sent(request);
    this.#options.requestTile(spec, patch).then(
      (image) => {
        if (generation !== this.#generation || this.#destroyed) {
          image.bitmap.close();
          return;
        }
        const bitmap = ownedCopy(image.bitmap);
        const pixels = patch === undefined ? spec.width * spec.height : patch.width * patch.height;
        const outcome = this.#book.received(request, bitmap, image.revision, pixels * 4);
        if (outcome === "violation") {
          this.#options.onViolation?.();
          return;
        }
        if (outcome === "kept") {
          this.#arrived.push({ page: spec.page, rect: patch?.rect ?? spec.rect });
          const held = this.#book.held.get(spec.key);
          if (held !== undefined) held.lastUsed = this.#frame;
        }
        this.#scheduleFrame(true, false);
      },
      () => {
        // The engine refused or stopped; the controller learns why from the client. A later frame asks again if still current.
        if (generation === this.#generation) this.#book.failed(request);
      },
    );
  }

  /** Lets go of the least recently drawn tiles that are not wanted now, until the held tiles fit the memory budget. */
  #evict(wanted: ReadonlySet<string>): void {
    let bytes = [...this.#book.held.values()].reduce((sum, held) => sum + held.bytes, 0);
    if (bytes <= MEMORY_BUDGET) return;
    const candidates = [...this.#book.held.values()]
      .filter((held) => !wanted.has(held.spec.key))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const held of candidates) {
      if (bytes <= MEMORY_BUDGET) break;
      this.#book.releaseTile(held.spec.key);
      bytes -= held.bytes;
    }
  }
}
