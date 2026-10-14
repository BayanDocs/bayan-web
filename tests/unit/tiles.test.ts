import { describe, expect, it } from "vitest";
import type { PageInfo } from "../../src/engine/protocol.ts";
import {
  contentLayout,
  drawOrder,
  type HeldTile,
  intersection,
  pageAreaSize,
  pagePixels,
  patchFor,
  pointerToView,
  scaleKey,
  tileSpec,
  toCanvas,
  union,
  type ViewTransform,
  visiblePages,
  visibleTiles,
} from "../../src/view/tiles.ts";

const BLU_PER_DIP = 19_050;
// The mock document's pages: US Letter (816 × 1056 CSS pixels at zoom 1), 24 CSS pixels apart (spec §7, bayan-engine's mock).
const letter = { width: 816 * BLU_PER_DIP, height: 1056 * BLU_PER_DIP, section: 0 };
const pages: PageInfo[] = [0, 1, 2].map((index) => ({ ...letter, index, x: 0, y: index * (1056 + 24) * BLU_PER_DIP }));

function transform(changes: Partial<ViewTransform> = {}): ViewTransform {
  const zoom = changes.zoom ?? 1;
  return {
    zoom,
    devicePixelRatio: 1,
    layout: contentLayout(pageAreaSize(pages), zoom, 1200),
    scrollX: 0,
    scrollY: 0,
    viewportWidth: 1200,
    viewportHeight: 800,
    ...changes,
  };
}

describe("page placement", () => {
  it("centres the page area horizontally with a margin, in CSS pixels at the zoom", () => {
    const layout = contentLayout(pageAreaSize(pages), 1, 1200);
    expect(layout.originX).toBe((1200 - 816) / 2);
    expect(layout.originY).toBe(24);
    expect(layout.height).toBe(3 * 1056 + 2 * 24 + 48);
    const wide = contentLayout(pageAreaSize(pages), 2, 1200);
    expect(wide.width).toBe(816 * 2 + 48);
    expect(wide.originX).toBe(24);
  });

  it("puts a page's corner on whole device pixels and moves it with the scroll position", () => {
    const at = toCanvas(transform({ devicePixelRatio: 2 }), pages[1]?.x ?? 0, pages[1]?.y ?? 0);
    expect(at).toEqual({ x: 192 * 2, y: (24 + 1080) * 2 });
    const scrolled = toCanvas(transform({ devicePixelRatio: 2, scrollY: 100.5 }), 0, pages[1]?.y ?? 0);
    expect(scrolled.y).toBe((24 + 1080) * 2 - 201);
  });

  it("converts pointer positions to the view origin, as the engine expects them", () => {
    expect(pointerToView(transform({ scrollY: 50 }), 192 + 10, 24 + 5)).toEqual({ x: 10, y: 55 });
  });

  it("finds the pages that intersect the canvas", () => {
    expect(visiblePages(pages, transform(), 1200, 800).map((placed) => placed.page.index)).toEqual([0]);
    const lower = transform({ scrollY: 1000 });
    expect(visiblePages(pages, lower, 1200, 800).map((placed) => placed.page.index)).toEqual([0, 1]);
  });
});

describe("tiles", () => {
  it("cover a page with whole device pixels, the last ones cut to the page", () => {
    expect(pagePixels(letter, 1)).toEqual({ width: 816, height: 1056 });
    expect(pagePixels(letter, 1.5)).toEqual({ width: 1224, height: 1584 });
    const page = pages[0] as PageInfo;
    const last = tileSpec(page, 1, 1, 2);
    expect(last).toMatchObject({ width: 816 - 512, height: 1056 - 1024, offsetX: 512, offsetY: 1024 });
  });

  it("share their edges exactly in BLU, so no seam can appear between neighbours", () => {
    const page = pages[0] as PageInfo;
    for (const scale of [1, 1.25, 1.5, 2, 0.67, 3 * 1.1]) {
      const left = tileSpec(page, scale, 0, 0);
      const right = tileSpec(page, scale, 1, 0);
      const below = tileSpec(page, scale, 0, 1);
      expect(left.rect.x + left.rect.width, `scale ${scale}`).toBe(right.rect.x);
      expect(left.rect.y + left.rect.height, `scale ${scale}`).toBe(below.rect.y);
    }
  });

  it("map the engine's BLU exactly at whole scales", () => {
    const tile = tileSpec(pages[0] as PageInfo, 2, 1, 0);
    expect(tile.rect).toEqual({
      x: (512 / 2) * BLU_PER_DIP,
      y: 0,
      width: (512 / 2) * BLU_PER_DIP,
      height: 256 * BLU_PER_DIP,
    });
  });

  it("are listed for the visible part only, nearest to the centre first", () => {
    const [placed] = visiblePages(pages, transform(), 1200, 800);
    const tiles = visibleTiles(placed as NonNullable<typeof placed>, 1, 1200, 800);
    expect(tiles.map((tile) => `${tile.column},${tile.row}`).sort()).toEqual(["0,0", "0,1", "1,0", "1,1"]);
    expect(tiles[0]?.column).toBe(0);
    expect(tiles[0]?.row).toBe(0);
  });

  it("refuse positions outside the page", () => {
    expect(() => tileSpec(pages[0] as PageInfo, 1, 2, 0)).toThrow(RangeError);
  });
});

describe("drawing order", () => {
  const page = pages[0] as PageInfo;
  const placed = { page, x: 10, y: 20 };
  const held = (scale: number, column: number, stale = false): HeldTile => ({
    spec: tileSpec(page, scale, column, 0),
    stale,
  });

  it("draws other scales first, scaled to the current one, farthest first, and the current scale on top", () => {
    const order = drawOrder(placed, 1, [held(1, 0), held(2, 0), held(1.25, 0), held(1, 1, true)]);
    expect(order.map((draw) => draw.tile.spec.scaleKey)).toEqual([
      scaleKey(2),
      scaleKey(1.25),
      scaleKey(1),
      scaleKey(1),
    ]);
    // A tile of scale 2 covers 256 CSS pixels of the page, drawn at scale 1 as 256 device pixels.
    expect(order[0]).toMatchObject({ x: 10, y: 20, width: 512 / 2, height: 512 / 2 });
    // A stale tile is still drawn until its replacement arrives.
    expect(order.some((draw) => draw.tile.stale)).toBe(true);
  });

  it("ignores tiles of other pages", () => {
    const other = { spec: tileSpec(pages[1] as PageInfo, 1, 0, 0), stale: false };
    expect(drawOrder(placed, 1, [other])).toEqual([]);
  });
});

describe("patches", () => {
  const page = pages[0] as PageInfo;

  it("cover the dirty rectangle with whole pixels of the tile, clipped to the tile", () => {
    const tile = tileSpec(page, 1, 0, 0);
    // A strip like the editable line: from 96 to 720 CSS pixels across, 250.5 to 285 down; at scale 1 one pixel is 19,050 BLU.
    const dirty = { x: 96 * BLU_PER_DIP, y: 250.5 * BLU_PER_DIP, width: 624 * BLU_PER_DIP, height: 34.5 * BLU_PER_DIP };
    expect(patchFor(tile, dirty)).toEqual({
      x: 96,
      y: 250,
      width: 512 - 96,
      height: 35,
      rect: { x: 96 * BLU_PER_DIP, y: 250 * BLU_PER_DIP, width: (512 - 96) * BLU_PER_DIP, height: 35 * BLU_PER_DIP },
    });
    const right = tileSpec(page, 1, 1, 0);
    expect(patchFor(right, dirty)).toMatchObject({ x: 0, width: 720 - 512, rect: { x: 512 * BLU_PER_DIP } });
  });

  it("share the tile grid's pixel edges at any scale, so a patch lines up with the tile beneath it", () => {
    for (const scale of [1.25, 1.5, 2.2, 0.67]) {
      const tile = tileSpec(page, scale, 1, 0);
      const patch = patchFor(tile, tile.rect);
      expect(patch?.rect, `scale ${scale}`).toEqual(tile.rect);
      expect(patch).toMatchObject({ x: 0, y: 0, width: tile.width, height: tile.height });
    }
  });

  it("are null when the dirty rectangle misses the tile", () => {
    const tile = tileSpec(page, 1, 0, 0);
    expect(patchFor(tile, { x: 600 * BLU_PER_DIP, y: 0, width: BLU_PER_DIP, height: BLU_PER_DIP })).toBeNull();
  });

  it("are built from unions and intersections of rectangles", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(intersection(a, { x: 5, y: 5, width: 10, height: 10 })).toEqual({ x: 5, y: 5, width: 5, height: 5 });
    expect(intersection(a, { x: 10, y: 0, width: 5, height: 5 })).toBeNull();
    expect(union(null, a)).toEqual(a);
    expect(union(a, { x: 20, y: -5, width: 1, height: 1 })).toEqual({ x: 0, y: -5, width: 21, height: 15 });
  });
});
