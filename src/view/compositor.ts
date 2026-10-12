// The tile compositor (ADR-0014 §4, ADR-0011 §5): draws the engine's tiles, transferred from the worker as ImageBitmaps, onto a Canvas 2D
// that covers the visible part of the document, and draws the overlays (caret and selection) on a second canvas above it, so that a
// blinking caret or a moved selection never redraws the tiles. It runs on the main thread and never waits for the engine: it draws what it
// has on every frame that needs it, requests the tiles it lacks (a few at a time, so that input messages never queue behind a flood of
// tile requests in the worker), and keeps drawing old tiles, scaled, until new ones arrive.

import { BLU_PER_DIP, type OverlayUpdate, type PageInfo, type PageRect, type Rect } from "../engine/protocol.ts";
import {
  type DrawTile,
  drawOrder,
  type HeldTile,
  intersects,
  type PlacedPage,
  scaleKey,
  type TileSpec,
  toCanvas,
  type ViewTransform,
  viewScale,
  visiblePages,
  visibleTiles,
} from "./tiles.ts";

/** What a tile request resolves with: the reply to render.tile on the web (spec §3.2). */
export interface TileImage {
  readonly bitmap: ImageBitmap;
  readonly hash: string;
}

/** What one frame drew, for measurements. */
export interface FrameReport {
  /** The frame's time (requestAnimationFrame's timestamp). */
  readonly time: number;
  readonly drewTiles: boolean;
  readonly drewOverlay: boolean;
  /** Tiles that arrived since the last frame and were drawn in this one. */
  readonly arrived: readonly TileSpec[];
}

export interface CompositorOptions {
  readonly tiles: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
  readonly requestTile: (spec: TileSpec) => Promise<TileImage>;
  readonly onFrame?: (report: FrameReport) => void;
  /** Whether the caret may blink; false when the user prefers reduced motion. */
  readonly blink?: boolean;
}

interface Held extends HeldTile {
  readonly bitmap: ImageBitmap;
  readonly bytes: number;
  lastUsed: number;
}

/** At most this many tile requests wait in the worker at once. */
const MAX_IN_FLIGHT = 2;
/** Tiles just outside the view are requested too, this many device pixels around it, so that slow scrolling finds them ready. */
const PREFETCH_PIXELS = 256;
/** The memory the held tiles may take, in bytes of RGBA pixels. */
const MEMORY_BUDGET = 160 * 1024 * 1024;
/** Half a blink period of the caret, as in most systems. */
const BLINK_MS = 530;

const PLACEHOLDER = "rgba(128, 128, 128, 0.25)";
const CARET = "#000000";
const SELECTION = "rgba(51, 132, 255, 0.35)";

export class Compositor {
  readonly #options: CompositorOptions;
  readonly #tiles: CanvasRenderingContext2D;
  readonly #overlay: CanvasRenderingContext2D;
  #pages: readonly PageInfo[] = [];
  #transform: ViewTransform | undefined;
  #overlayState: OverlayUpdate | null = null;
  #focused = false;
  #caretOn = true;
  #blinkTimer: ReturnType<typeof setInterval> | undefined;
  readonly #held = new Map<string, Held>();
  /** The invalidation count of each tile: a reply rendered before the latest invalidation of its tile is stale on arrival. */
  readonly #versions = new Map<string, number>();
  readonly #inFlight = new Map<string, { spec: TileSpec; version: number }>();
  /** Increases whenever the document or session changes, so that replies to older requests are dropped. */
  #generation = 0;
  #frame = 0;
  #frameRequested = false;
  #tilesDirty = true;
  #overlayDirty = true;
  #arrived: TileSpec[] = [];
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
   * The document's pages (view.pages). The tiles of a page whose size is unchanged are kept: v0's engine sends view.pages after every
   * view.set, and dropping them would leave the page empty until fresh tiles arrive, just when stale-tile scaling should stand in.
   */
  setPages(pages: readonly PageInfo[]): void {
    for (const [key, held] of this.#held) {
      const before = this.#pages[held.spec.page];
      const after = pages[held.spec.page];
      if (
        before === undefined ||
        after === undefined ||
        before.width !== after.width ||
        before.height !== after.height
      ) {
        held.bitmap.close();
        this.#held.delete(key);
      }
    }
    this.#pages = pages;
    this.#scheduleFrame(true, true);
  }

  /** Forgets every tile and request, for a new session or document. */
  reset(): void {
    this.#generation += 1;
    for (const held of this.#held.values()) held.bitmap.close();
    this.#held.clear();
    this.#versions.clear();
    this.#inFlight.clear();
    this.#pages = [];
    this.#overlayState = null;
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

  /** render.invalidate: the tiles that intersect these regions are re-requested, and drawn as they are until the new ones arrive. */
  invalidate(regions: readonly PageRect[]): void {
    const hits = (spec: TileSpec) =>
      regions.some((region) => region.page === spec.page && intersects(region.rect, spec.rect));
    for (const held of this.#held.values()) {
      if (hits(held.spec)) {
        this.#versions.set(held.spec.key, (this.#versions.get(held.spec.key) ?? 0) + 1);
        this.#held.set(held.spec.key, { ...held, stale: true });
      }
    }
    for (const { spec } of this.#inFlight.values()) {
      if (hits(spec) && !this.#held.has(spec.key)) {
        this.#versions.set(spec.key, (this.#versions.get(spec.key) ?? 0) + 1);
      }
    }
    this.#scheduleFrame(false, false);
  }

  /** overlay.update: the caret and selection to draw over the tiles. */
  setOverlay(overlay: OverlayUpdate): void {
    this.#overlayState = overlay;
    this.#caretOn = true;
    this.#restartBlink();
    this.#scheduleFrame(false, true);
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
    this.#pump(transform, scale);
    this.#options.onFrame?.({ time, drewTiles, drewOverlay, arrived });
  }

  #drawTiles(placed: readonly PlacedPage[], scale: number): void {
    const context = this.#tiles;
    const canvas = this.#options.tiles;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    const held = [...this.#held.values()];
    for (const page of placed) {
      const order = drawOrder(page, scale, held);
      if (order.length === 0) {
        const size = this.#deviceBox(page.page, { x: 0, y: 0, width: page.page.width, height: page.page.height });
        context.fillStyle = PLACEHOLDER;
        context.fillRect(size.x, size.y, size.width, size.height);
        continue;
      }
      for (const draw of order as DrawTile<Held>[]) {
        draw.tile.lastUsed = this.#frame;
        context.drawImage(draw.tile.bitmap, draw.x, draw.y, draw.width, draw.height);
      }
    }
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

  /** Requests the visible tiles that are missing or stale, nearest first, and lets go of tiles beyond the memory budget. */
  #pump(transform: ViewTransform, scale: number): void {
    const canvas = this.#options.tiles;
    const placed = visiblePages(this.#pages, transform, canvas.width, canvas.height, PREFETCH_PIXELS);
    const wanted = placed.flatMap((page) => visibleTiles(page, scale, canvas.width, canvas.height, PREFETCH_PIXELS));
    let missing = 0;
    for (const spec of wanted) {
      const held = this.#held.get(spec.key);
      if (held !== undefined && !held.stale) {
        held.lastUsed = this.#frame;
        continue;
      }
      missing += 1;
      const version = this.#versions.get(spec.key) ?? 0;
      const flying = this.#inFlight.get(spec.key);
      if (flying !== undefined || this.#inFlight.size >= MAX_IN_FLIGHT) continue;
      this.#request(spec, version);
    }
    // Once the current scale covers the visible part of a page, the stand-in tiles of other scales are no longer needed.
    const current = scaleKey(scale);
    if (missing === 0) {
      for (const [key, held] of this.#held) {
        if (held.spec.scaleKey !== current && placed.some((page) => page.page.index === held.spec.page)) {
          held.bitmap.close();
          this.#held.delete(key);
        }
      }
    }
    this.#evict(new Set(wanted.map((spec) => spec.key)));
    const bytes = [...this.#held.values()].reduce((sum, held) => sum + held.bytes, 0);
    const data = this.#options.tiles.dataset;
    data["tilesHeld"] = String(this.#held.size);
    data["tileBytes"] = String(bytes);
    data["tilesInFlight"] = String(this.#inFlight.size);
    data["tilesMissing"] = String(missing);
  }

  #request(spec: TileSpec, version: number): void {
    const generation = this.#generation;
    this.#inFlight.set(spec.key, { spec, version });
    this.#options.requestTile(spec).then(
      (image) => {
        if (generation !== this.#generation || this.#destroyed) {
          image.bitmap.close();
          return;
        }
        this.#inFlight.delete(spec.key);
        this.#held.get(spec.key)?.bitmap.close();
        const stale = version < (this.#versions.get(spec.key) ?? 0);
        this.#held.set(spec.key, {
          spec,
          stale,
          bitmap: image.bitmap,
          bytes: spec.width * spec.height * 4,
          lastUsed: this.#frame,
        });
        this.#arrived.push(spec);
        this.#scheduleFrame(true, false);
      },
      () => {
        // The engine refused or stopped; the controller learns why from the client. Try again on a later frame only if still current.
        if (generation === this.#generation) this.#inFlight.delete(spec.key);
      },
    );
  }

  /** Lets go of the least recently drawn tiles that are not wanted now, until the held tiles fit the memory budget. */
  #evict(wanted: ReadonlySet<string>): void {
    let bytes = [...this.#held.values()].reduce((sum, held) => sum + held.bytes, 0);
    if (bytes <= MEMORY_BUDGET) return;
    const candidates = [...this.#held.values()]
      .filter((held) => !wanted.has(held.spec.key))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const held of candidates) {
      if (bytes <= MEMORY_BUDGET) break;
      held.bitmap.close();
      this.#held.delete(held.spec.key);
      bytes -= held.bytes;
    }
  }
}
