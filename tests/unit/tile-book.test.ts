import { describe, expect, it } from "vitest";
import type { PageInfo, Rect } from "../../src/engine/protocol.ts";
import { MAX_PATCHES, TileBook, type TileRequest } from "../../src/view/tile-book.ts";
import { tileSpec } from "../../src/view/tiles.ts";

// The compositor's book of tiles (src/view/tile-book.ts): tiles kept and replaced by render revision (engine protocol §14.6 item 1), in
// whatever order tiles and invalidations arrive.

const BLU_PER_DIP = 19_050;
const page: PageInfo = { index: 0, width: 816 * BLU_PER_DIP, height: 1056 * BLU_PER_DIP, section: 0, x: 0, y: 0 };
const tile = tileSpec(page, 1, 0, 0);
/** A strip of the editable line, as the mock document invalidates it while typing: inside the first tile. */
const strip: Rect = { x: 96 * BLU_PER_DIP, y: 250 * BLU_PER_DIP, width: 300 * BLU_PER_DIP, height: 35 * BLU_PER_DIP };

function book() {
  const released: string[] = [];
  return { tiles: new TileBook<string>((image) => released.push(image)), released };
}

/** Requests the tile, as the compositor's next frame does, and returns the request. */
function request(tiles: TileBook<string>): TileRequest<string> {
  const next = tiles.next(tile);
  if (next === null) throw new Error("nothing to request");
  tiles.sent(next);
  return next;
}

describe("a tile and an invalidation that cross", () => {
  it("keep the tile when it already shows the change: its revision is not older than the invalidation's", () => {
    const { tiles } = book();
    tiles.saw(1);
    const whole = request(tiles);
    // The document changes while the tile is on its way: the engine renders the tile after the change, at revision 2.
    tiles.invalidate(0, strip, 2);
    expect(tiles.received(whole, "tile@2", 2, 1)).toBe("kept");
    expect(tiles.isStale(tile.key)).toBe(false);
    expect(tiles.next(tile)).toBeNull();
  });

  it("render again only the changed part when the tile is older than the invalidation", () => {
    const { tiles } = book();
    tiles.saw(1);
    const whole = request(tiles);
    // The engine rendered the tile at revision 1, before the change of revision 2, whose invalidation the shell saw first.
    tiles.invalidate(0, strip, 2);
    expect(tiles.received(whole, "tile@1", 1, 1)).toBe("kept");
    expect(tiles.isStale(tile.key)).toBe(true);
    const patch = request(tiles);
    // A patch of the strip, not the whole tile, as a count of invalidations per tile would have asked for.
    expect(patch.patch).toMatchObject({ x: 96, y: 250, width: 300, height: 35 });
    expect(tiles.received(patch, "patch@2", 2, 1)).toBe("kept");
    expect(tiles.isStale(tile.key)).toBe(false);
    expect(tiles.held.get(tile.key)?.patches.map((drawn) => drawn.image)).toEqual(["patch@2"]);
  });

  it("do the same in either order: an invalidation that arrives after its tile marks it only if the tile is older", () => {
    const { tiles } = book();
    tiles.saw(1);
    const first = request(tiles);
    tiles.received(first, "tile@3", 3, 1);
    // An invalidation of revision 2 that arrives after a tile of revision 3 changes nothing: the tile shows it already.
    tiles.invalidate(0, strip, 2);
    expect(tiles.isStale(tile.key)).toBe(false);
    tiles.invalidate(0, strip, 4);
    expect(tiles.isStale(tile.key)).toBe(true);
  });
});

describe("the tile book", () => {
  it("requests a tile it does not hold whole, and a held one that is current not at all", () => {
    const { tiles } = book();
    expect(tiles.isStale(tile.key)).toBe(true);
    const whole = request(tiles);
    expect(whole.patch).toBeUndefined();
    // While it is on its way, nothing more is asked for it.
    expect(tiles.next(tile)).toBeNull();
    tiles.received(whole, "tile", 1, 1);
    expect(tiles.next(tile)).toBeNull();
  });

  it("ignores invalidations that miss a tile, and those of another page", () => {
    const { tiles } = book();
    tiles.received(request(tiles), "tile", 1, 1);
    tiles.invalidate(0, { x: 600 * BLU_PER_DIP, y: 0, width: BLU_PER_DIP, height: BLU_PER_DIP }, 2);
    tiles.invalidate(1, strip, 3);
    expect(tiles.isStale(tile.key)).toBe(false);
  });

  it("renders a tile whole again when its changed part is large, or after many patches", () => {
    const { tiles, released } = book();
    tiles.received(request(tiles), "tile", 1, 1);
    tiles.invalidate(0, tile.rect, 2);
    const whole = request(tiles);
    expect(whole.patch).toBeUndefined();
    expect(tiles.received(whole, "tile@2", 2, 1)).toBe("kept");
    // The tile it replaces is let go of.
    expect(released).toEqual(["tile"]);
    for (let revision = 3; revision < 3 + MAX_PATCHES; revision += 1) {
      tiles.invalidate(0, strip, revision);
      const patch = request(tiles);
      expect(patch.patch).toBeDefined();
      tiles.received(patch, `patch@${revision}`, revision, 1);
    }
    tiles.invalidate(0, strip, 100);
    expect(request(tiles).patch).toBeUndefined();
  });

  it("keeps a change that arrives while a patch is on its way, if the patch is older", () => {
    const { tiles } = book();
    tiles.received(request(tiles), "tile", 1, 1);
    tiles.invalidate(0, strip, 2);
    const patch = request(tiles);
    tiles.invalidate(0, strip, 3);
    tiles.received(patch, "patch@2", 2, 1);
    expect(tiles.isStale(tile.key)).toBe(true);
    const again = request(tiles);
    tiles.received(again, "patch@3", 3, 1);
    expect(tiles.isStale(tile.key)).toBe(false);
  });

  it("drops a patch whose tile was let go of while it was on its way", () => {
    const { tiles, released } = book();
    tiles.received(request(tiles), "tile", 1, 1);
    tiles.invalidate(0, strip, 2);
    const patch = request(tiles);
    tiles.releaseTile(tile.key);
    expect(tiles.received(patch, "patch", 2, 1)).toBe("dropped");
    expect(released).toEqual(["tile", "patch"]);
  });

  it("refuses a reply older than a revision it had seen when it asked: revisions only grow (§14.6 item 1)", () => {
    const { tiles, released } = book();
    tiles.received(request(tiles), "tile", 1, 1);
    tiles.invalidate(0, strip, 5);
    const patch = request(tiles);
    // A faulty engine that answered with revision 4 would leave the change of revision 5 to be asked for again and again.
    expect(tiles.received(patch, "patch@4", 4, 1)).toBe("violation");
    expect(released).toEqual(["patch@4"]);
  });

  it("forgets everything for a new session, and lets go of every picture", () => {
    const { tiles, released } = book();
    tiles.received(request(tiles), "tile", 1, 1);
    tiles.invalidate(0, strip, 2);
    tiles.received(request(tiles), "patch", 2, 1);
    tiles.reset();
    expect(tiles.held.size).toBe(0);
    expect(tiles.inFlight.size).toBe(0);
    expect(released.sort()).toEqual(["patch", "tile"]);
  });
});
