// Performance measurements of the web shell (WEB-002; requirements PERF-04 and PERF-06), recorded as User Timing measures: they show in
// the browser's developer tools, and the end-to-end tests read them with performance.getEntriesByName(). They hold durations only,
// never document content. Each name keeps at most `limit` entries, so a long session cannot grow the browser's measure buffer forever.

export const measureNames = {
  /** From starting the engine (before the integrity check) to the worker host's "ready". */
  engineStart: "bayan:engine-start",
  /** Of the integrity check (fetching and hashing the engine's three files) and starting the worker. */
  engineVerify: "bayan:engine-verify",
  /** From a key press to when the compositor drew the overlay (caret) that the engine sent for it into its canvas. */
  keyToOverlayDrawn: "bayan:key-to-overlay-drawn",
  /**
   * From a key press to the start of the first animation frame after the overlay was drawn: the frame in which the browser will paint
   * it. A lower bound of keystroke-to-pixel latency (PERF-04): painting, compositing and the display add to it, and headless browsers
   * measure none of them.
   */
  keyToOverlayFrame: "bayan:key-to-overlay-frame",
  /**
   * From a key press to when the compositor drew the re-rendered tile or patch that shows the change into its canvas. Also a lower
   * bound: the wait for the next frame, painting, compositing and the display come after it.
   */
  keyToTileDrawn: "bayan:key-to-tile-drawn",
} as const;

/** The round trip of one request type, main thread → worker → main thread: `bayan:engine:<type>`. */
export function roundTripName(type: string): string {
  return `bayan:engine:${type}`;
}

const limit = 2000;
const counts = new Map<string, number>();

/** Records a duration between two performance.now() times. */
export function recordDuration(name: string, start: number, end: number): void {
  if (typeof performance === "undefined" || typeof performance.measure !== "function") return;
  const count = (counts.get(name) ?? 0) + 1;
  if (count > limit) {
    performance.clearMeasures(name);
    counts.set(name, 1);
  } else {
    counts.set(name, count);
  }
  try {
    performance.measure(name, { start, end: Math.max(start, end) });
  } catch {
    // A measurement must never break the app.
  }
}
