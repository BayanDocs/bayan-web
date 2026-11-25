// The compositor's book of tiles (engine protocol §14.6 item 1): which tiles it holds, which it has requested, and which parts of them the
// document has changed since their pixels were rendered. Every tile and patch the engine renders carries the render revision it shows, and
// every render.invalidate the revision after its change, so a tile is kept while no invalidation with a higher revision covers it,
// whatever order tiles and invalidations arrive in. A tile requested before a change and delivered after it (the two cross) is therefore
// rendered again only where that change lies, and only if its revision is older than the change's, instead of the whole tile.
//
// No browser APIs, so that the unit tests can drive it exactly (tests/unit/tile-book.test.ts); the compositor (compositor.ts) draws what
// it holds. `B` is the picture of a tile or patch: an ImageBitmap in the app.

import type { Rect } from "../engine/protocol.ts";
import { intersection, patchFor, type TilePatch, type TileSpec, union } from "./tiles.ts";

/** A part of a page that changed, and the render revision after the change. */
export interface Change {
  readonly revision: number;
  readonly rect: Rect;
}

/** A re-rendered part of a held tile, drawn over it, and the revision it shows. */
export interface Patch<B> {
  readonly image: B;
  readonly place: TilePatch;
  readonly revision: number;
}

export interface HeldTile<B> {
  readonly spec: TileSpec;
  readonly image: B;
  /** The revision the tile's own pixels show; its patches show this revision or later ones. */
  readonly revision: number;
  /** Re-rendered parts, drawn over the tile in order. */
  readonly patches: Patch<B>[];
  /** The changes (clipped to the tile) with a higher revision than the pixels that show them: the parts to render again. */
  changes: Change[];
  bytes: number;
  lastUsed: number;
}

/** A request on its way to the engine: a whole tile, or a patch of a held one. */
export interface TileRequest<B> {
  readonly spec: TileSpec;
  readonly patch?: TilePatch;
  /** For a patch: the tile it is drawn over, and the changes it renders again. */
  readonly target?: HeldTile<B>;
  readonly covers?: ReadonlySet<Change>;
  /** The highest revision the book had seen when it sent the request: the engine renders it at that revision or a later one. */
  readonly known: number;
  /** Changes (clipped to the request) that arrived while it was on its way. */
  readonly crossed: Change[];
}

/** What became of a reply: kept and drawn, dropped because its tile is gone, or refused because it breaks the protocol. */
export type Received = "kept" | "dropped" | "violation";

/** A tile is rendered whole again instead of patched when the patch would cover more than this share of it, or after this many patches. */
export const PATCH_SHARE = 0.5;
export const MAX_PATCHES = 16;
/** At most this many changes are listed per tile; more are merged into one, which can only make a patch larger, never miss a change. */
const MAX_CHANGES = 32;

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** Adds a change to a list, merging the list into one change once it grows too long. */
function addChange(changes: Change[], change: Change): void {
  changes.push(change);
  if (changes.length <= MAX_CHANGES) return;
  const merged = changes.reduce<Change>(
    (all, next) => ({ revision: Math.max(all.revision, next.revision), rect: union(all.rect, next.rect) }),
    change,
  );
  changes.splice(0, changes.length, merged);
}

export class TileBook<B> {
  readonly held = new Map<string, HeldTile<B>>();
  readonly inFlight = new Map<string, TileRequest<B>>();
  readonly #release: (image: B) => void;
  /** The highest render revision seen so far: from the document's opening, invalidations and tiles. */
  #known = 0;

  /** `release` frees the picture of a tile or patch that the book lets go of. */
  constructor(release: (image: B) => void) {
    this.#release = release;
  }

  /** A render revision seen elsewhere, such as the document's in doc.opened (§14.6 item 1). */
  saw(revision: number): void {
    this.#known = Math.max(this.#known, revision);
  }

  /** Whether a wanted tile lacks pixels or shows a part older than a change: it must be requested (or is being requested). */
  isStale(key: string): boolean {
    const held = this.held.get(key);
    return held === undefined || held.changes.length > 0;
  }

  /**
   * What to request for a wanted tile: the whole tile if it is not held, or if its changed part is large or it has many patches already,
   * otherwise a patch of the changed part; null when it is current or already on its way.
   */
  next(spec: TileSpec): TileRequest<B> | null {
    if (this.inFlight.has(spec.key)) return null;
    const held = this.held.get(spec.key);
    if (held === undefined) return { spec, known: this.#known, crossed: [] };
    if (held.changes.length === 0) return null;
    const dirty = held.changes.map((change) => change.rect).reduce<Rect | null>(union, null) as Rect;
    const patch = patchFor(spec, dirty);
    if (patch === null) {
      // The changes touch no pixel of the tile.
      held.changes = [];
      return null;
    }
    if (patch.width * patch.height > PATCH_SHARE * spec.width * spec.height || held.patches.length >= MAX_PATCHES) {
      return { spec, known: this.#known, crossed: [] };
    }
    return { spec, patch, target: held, covers: new Set(held.changes), known: this.#known, crossed: [] };
  }

  /** The request went to the engine. */
  sent(request: TileRequest<B>): void {
    this.inFlight.set(request.spec.key, request);
  }

  /** The request failed (the engine refused it or stopped); a later frame asks again if the tile is still wanted. */
  failed(request: TileRequest<B>): void {
    if (this.inFlight.get(request.spec.key) === request) this.inFlight.delete(request.spec.key);
  }

  /**
   * render.invalidate (§14.6 item 1): `rect` of page `page` changed, and the document is at `revision` now. Every held tile whose pixels
   * there are older is marked to be rendered again there; a request on its way notes the change, so that its reply can tell whether it
   * shows it. The tiles are drawn as they are until the new pixels arrive, so an edit never makes the page flicker.
   */
  invalidate(page: number, rect: Rect, revision: number): void {
    this.saw(revision);
    for (const held of this.held.values()) {
      const part = held.spec.page === page ? intersection(rect, held.spec.rect) : null;
      // A held tile's own pixels are its oldest: its patches came later.
      if (part !== null && revision > held.revision) addChange(held.changes, { revision, rect: part });
    }
    for (const request of this.inFlight.values()) {
      const part = request.spec.page === page ? intersection(rect, request.patch?.rect ?? request.spec.rect) : null;
      if (part !== null) addChange(request.crossed, { revision, rect: part });
    }
  }

  /**
   * The reply to a request: the picture and the revision it shows. A whole tile replaces any tile held under its key and keeps, of the
   * changes that crossed it, those with a higher revision. A patch is drawn over its tile and clears the changes it renders again. A reply
   * older than a revision the book had seen when it sent the request breaks the protocol, because revisions only grow (§14.6 item 1): it
   * would otherwise leave the same changes to be requested again and again.
   */
  received(request: TileRequest<B>, image: B, revision: number, bytes: number): Received {
    const key = request.spec.key;
    if (this.inFlight.get(key) === request) this.inFlight.delete(key);
    if (revision < request.known) {
      this.#release(image);
      return "violation";
    }
    this.saw(revision);
    if (request.patch === undefined) {
      const previous = this.held.get(key);
      if (previous !== undefined) this.releaseTile(key);
      this.held.set(key, {
        spec: request.spec,
        image,
        revision,
        patches: [],
        changes: request.crossed.filter((change) => change.revision > revision),
        bytes,
        lastUsed: 0,
      });
      return "kept";
    }
    const held = this.held.get(key);
    if (held === undefined || held !== request.target) {
      // The tile was let go of, or replaced, while the patch was on its way.
      this.#release(image);
      return "dropped";
    }
    const area = request.patch.rect;
    held.patches.push({ image, place: request.patch, revision });
    held.bytes += bytes;
    held.changes = held.changes.filter(
      (change) => !(request.covers?.has(change) || (change.revision <= revision && contains(area, change.rect))),
    );
    return "kept";
  }

  /** Lets go of a held tile and its patches. */
  releaseTile(key: string): void {
    const held = this.held.get(key);
    if (held === undefined) return;
    this.#release(held.image);
    for (const patch of held.patches) this.#release(patch.image);
    this.held.delete(key);
  }

  /** Forgets every tile and request, for a new session or document. Replies to the requests forgotten must be dropped by the caller. */
  reset(): void {
    for (const key of [...this.held.keys()]) this.releaseTile(key);
    this.inFlight.clear();
    this.#known = 0;
  }
}
