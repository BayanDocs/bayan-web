// The compositor's geometry (engine protocol §7): where pages sit on screen, which tiles cover them, and in what order to draw the tiles
// the compositor has. Pure functions without browser APIs, so the unit tests can check them exactly.
//
// Units: BLU (Bayan Layout Units, 19,050 per CSS pixel at zoom 1) for everything the engine describes; CSS pixels for the browser's
// layout and scrolling; device pixels for the canvas. The scale of a view is device pixels per CSS pixel at zoom 1: zoom × devicePixelRatio.

import { BLU_PER_DIP, MAX_TILE_SIDE, type PageInfo, type Rect } from "../engine/protocol.ts";

/** The side of a tile in device pixels: large enough to keep the number of requests small, small enough to re-render little. */
export const TILE_SIZE = 512;

/** The margin around the page area, in CSS pixels. */
export const PAGE_AREA_MARGIN = 24;

/** The scale at which tiles are rendered: device pixels per CSS pixel at zoom 1. */
export function viewScale(zoom: number, devicePixelRatio: number): number {
  return zoom * devicePixelRatio;
}

/** A stable key for a scale, so that tiles of one scale can be found again (floating-point noise below 10⁻⁶ is ignored). */
export function scaleKey(scale: number): string {
  return scale.toFixed(6);
}

/** The size of the page area in BLU: the box from the view origin to the far edges of the pages (spec §7). */
export function pageAreaSize(pages: readonly PageInfo[]): { width: number; height: number } {
  let width = 0;
  let height = 0;
  for (const page of pages) {
    width = Math.max(width, page.x + page.width);
    height = Math.max(height, page.y + page.height);
  }
  return { width, height };
}

/** Where the page area sits in the scrolled content, and how large the content is, in CSS pixels at a zoom. */
export interface ContentLayout {
  /** The view origin's position in the scrolled content: the page area is centred horizontally when it is narrower than the view. */
  readonly originX: number;
  readonly originY: number;
  readonly width: number;
  readonly height: number;
}

export function contentLayout(
  area: { width: number; height: number },
  zoom: number,
  viewportWidth: number,
  margin = PAGE_AREA_MARGIN,
): ContentLayout {
  const areaWidth = (area.width * zoom) / BLU_PER_DIP;
  const areaHeight = (area.height * zoom) / BLU_PER_DIP;
  const width = Math.max(viewportWidth, areaWidth + 2 * margin);
  return { originX: (width - areaWidth) / 2, originY: margin, width, height: areaHeight + 2 * margin };
}

/** Everything that places pages on the canvas. */
export interface ViewTransform {
  readonly zoom: number;
  readonly devicePixelRatio: number;
  readonly layout: ContentLayout;
  /** The scroll position, in CSS pixels. */
  readonly scrollX: number;
  readonly scrollY: number;
  /** The visible part of the scroller, in CSS pixels. */
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

/**
 * The device-pixel position on the canvas of a point given in view-space BLU (spec §7). Positions are rounded once, in content
 * coordinates, before the scroll offset is subtracted, so that tiles and overlays never shift against each other while scrolling.
 */
export function toCanvas(transform: ViewTransform, viewX: number, viewY: number): { x: number; y: number } {
  const ratio = transform.devicePixelRatio;
  const contentX = Math.round((transform.layout.originX + (viewX * transform.zoom) / BLU_PER_DIP) * ratio);
  const contentY = Math.round((transform.layout.originY + (viewY * transform.zoom) / BLU_PER_DIP) * ratio);
  return { x: contentX - Math.round(transform.scrollX * ratio), y: contentY - Math.round(transform.scrollY * ratio) };
}

/** A pointer position in CSS pixels relative to the scrolled content's visible top-left corner, as the engine wants it (spec §6.5). */
export function pointerToView(transform: ViewTransform, clientX: number, clientY: number): { x: number; y: number } {
  return {
    x: clientX + transform.scrollX - transform.layout.originX,
    y: clientY + transform.scrollY - transform.layout.originY,
  };
}

/** The `view.set` viewport: the visible part of the page area in CSS pixels from the view origin (spec §6.2). */
export function engineViewport(transform: ViewTransform): { x: number; y: number; width: number; height: number } {
  return {
    x: transform.scrollX - transform.layout.originX,
    y: transform.scrollY - transform.layout.originY,
    width: Math.max(1, transform.viewportWidth),
    height: Math.max(1, transform.viewportHeight),
  };
}

/** One tile of a page at one scale. */
export interface TileSpec {
  readonly key: string;
  readonly page: number;
  readonly scale: number;
  readonly scaleKey: string;
  readonly column: number;
  readonly row: number;
  /** The part of the page the tile shows, in page BLU. */
  readonly rect: Rect;
  /** Its size in device pixels. */
  readonly width: number;
  readonly height: number;
  /** Its offset in device pixels from the page's top-left corner on the canvas. */
  readonly offsetX: number;
  readonly offsetY: number;
}

export function tileKey(page: number, key: string, column: number, row: number): string {
  return `${page}@${key}:${column},${row}`;
}

/** The size of a page in device pixels at a scale, rounded up so that the tiles cover the whole page. */
export function pagePixels(page: Pick<PageInfo, "width" | "height">, scale: number): { width: number; height: number } {
  return {
    width: Math.max(1, Math.ceil((page.width * scale) / BLU_PER_DIP - 1e-9)),
    height: Math.max(1, Math.ceil((page.height * scale) / BLU_PER_DIP - 1e-9)),
  };
}

/**
 * The tile in `column` and `row` of a page at a scale. Its pixel edges are whole device pixels from the page's corner, and its rectangle
 * in BLU is derived from those edges, so neighbouring tiles share their edges exactly and no seam can appear between them; within a tile
 * the engine maps pixels to BLU exactly (spec §7). The last row and column are cut to the page's size in pixels.
 */
export function tileSpec(page: PageInfo, scale: number, column: number, row: number, size = TILE_SIZE): TileSpec {
  const pixels = pagePixels(page, scale);
  const left = column * size;
  const top = row * size;
  const width = Math.min(size, pixels.width - left);
  const height = Math.min(size, pixels.height - top);
  if (width < 1 || height < 1 || width > MAX_TILE_SIDE || height > MAX_TILE_SIDE) {
    throw new RangeError(`No tile ${column},${row} on page ${page.index} at scale ${scale}.`);
  }
  const blu = (pixel: number) => Math.round((pixel * BLU_PER_DIP) / scale);
  const x = blu(left);
  const y = blu(top);
  const key = scaleKey(scale);
  return {
    key: tileKey(page.index, key, column, row),
    page: page.index,
    scale,
    scaleKey: key,
    column,
    row,
    rect: { x, y, width: Math.max(1, blu(left + width) - x), height: Math.max(1, blu(top + height) - y) },
    width,
    height,
    offsetX: left,
    offsetY: top,
  };
}

/** A page's position on the canvas: its top-left corner in device pixels. */
export interface PlacedPage {
  readonly page: PageInfo;
  readonly x: number;
  readonly y: number;
}

/** The pages that intersect the canvas, extended by `marginPixels` (to prefetch tiles just outside the view), with their positions. */
export function visiblePages(
  pages: readonly PageInfo[],
  transform: ViewTransform,
  canvasWidth: number,
  canvasHeight: number,
  marginPixels = 0,
): PlacedPage[] {
  const scale = viewScale(transform.zoom, transform.devicePixelRatio);
  const placed: PlacedPage[] = [];
  for (const page of pages) {
    const origin = toCanvas(transform, page.x, page.y);
    const size = pagePixels(page, scale);
    const visible =
      origin.x < canvasWidth + marginPixels &&
      origin.y < canvasHeight + marginPixels &&
      origin.x + size.width > -marginPixels &&
      origin.y + size.height > -marginPixels;
    if (visible) placed.push({ page, x: origin.x, y: origin.y });
  }
  return placed;
}

/**
 * The tiles of a placed page that intersect the canvas, extended by `marginPixels`, ordered from the centre of the canvas outwards,
 * so that what the user looks at is requested first.
 */
export function visibleTiles(
  placed: PlacedPage,
  scale: number,
  canvasWidth: number,
  canvasHeight: number,
  marginPixels = 0,
  size = TILE_SIZE,
): TileSpec[] {
  const pixels = pagePixels(placed.page, scale);
  const columns = Math.ceil(pixels.width / size);
  const rows = Math.ceil(pixels.height / size);
  const first = (origin: number) => Math.max(0, Math.floor((-marginPixels - origin) / size));
  const last = (origin: number, extent: number, count: number) =>
    Math.min(count - 1, Math.floor((extent + marginPixels - origin - 1) / size));
  const tiles: TileSpec[] = [];
  for (let row = first(placed.y); row <= last(placed.y, canvasHeight, rows); row += 1) {
    for (let column = first(placed.x); column <= last(placed.x, canvasWidth, columns); column += 1) {
      tiles.push(tileSpec(placed.page, scale, column, row, size));
    }
  }
  const centreX = canvasWidth / 2;
  const centreY = canvasHeight / 2;
  const distance = (tile: TileSpec) =>
    Math.hypot(placed.x + tile.offsetX + tile.width / 2 - centreX, placed.y + tile.offsetY + tile.height / 2 - centreY);
  return tiles.sort((a, b) => distance(a) - distance(b));
}

/** Whether two rectangles in the same coordinates overlap. */
export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** A tile the compositor holds: its geometry, and whether a later invalidation has made its pixels stale. */
export interface HeldTile {
  readonly spec: TileSpec;
  readonly stale: boolean;
}

/** One drawing operation: a held tile, drawn at a device-pixel rectangle of the canvas. */
export interface DrawTile<T extends HeldTile> {
  readonly tile: T;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The drawing order for one page: first the tiles of other scales, scaled to the current one (stale-tile scaling: after a zoom or a
 * change of devicePixelRatio, the old pixels stand in until fresh tiles arrive), from the scale furthest from the current one to the
 * closest; then the tiles of the current scale, which cover them. A tile whose pixels are stale is still drawn until its replacement
 * arrives, so an edit never makes the page flicker.
 */
export function drawOrder<T extends HeldTile>(placed: PlacedPage, scale: number, held: readonly T[]): DrawTile<T>[] {
  const current = scaleKey(scale);
  const others = held
    .filter((tile) => tile.spec.page === placed.page.index && tile.spec.scaleKey !== current)
    .sort((a, b) => Math.abs(b.spec.scale - scale) - Math.abs(a.spec.scale - scale));
  const own = held.filter((tile) => tile.spec.page === placed.page.index && tile.spec.scaleKey === current);
  const factor = scale / BLU_PER_DIP;
  return [
    ...others.map((tile) => ({
      tile,
      x: placed.x + tile.spec.rect.x * factor,
      y: placed.y + tile.spec.rect.y * factor,
      width: tile.spec.rect.width * factor,
      height: tile.spec.rect.height * factor,
    })),
    ...own.map((tile) => ({
      tile,
      x: placed.x + tile.spec.offsetX,
      y: placed.y + tile.spec.offsetY,
      width: tile.spec.width,
      height: tile.spec.height,
    })),
  ];
}
