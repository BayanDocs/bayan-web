import { mkdirSync, writeFileSync } from "node:fs";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { pageBox, waitForDocument, waitForTiles } from "./document.ts";

// WEB-002's measurements (AC-1, AC-4; requirements PERF-04, PERF-06): keystroke to overlay and to tile, frame times while scrolling and
// zooming, the worker's message round trips, start-up and memory. Each test writes its figures to test-results/measurements/ and
// attaches them to the report; the WEB-002 report collects them. The assertions only catch gross breakage: timings on shared CI
// machines and headless browsers vary too much for tight limits, and the figures themselves are the result.

/** Percentiles and extremes of a list of milliseconds, rounded to 0.1 ms. */
function summarize(values: readonly number[]): Record<string, number> {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? Number.NaN;
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    count: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted.at(-1) ?? Number.NaN),
  };
}

async function record(testInfo: TestInfo, name: string, figures: unknown): Promise<void> {
  const directory = "test-results/measurements";
  mkdirSync(directory, { recursive: true });
  const body = JSON.stringify({ browser: testInfo.project.name, platform: process.platform, name, figures }, null, 2);
  writeFileSync(`${directory}/${testInfo.project.name}-${name}.json`, `${body}\n`);
  await testInfo.attach(name, { body, contentType: "application/json" });
  console.log(`[measurement] ${testInfo.project.name} ${name}: ${JSON.stringify(figures)}`);
}

/** The durations of the app's User Timing measures with a name (src/metrics.ts). */
async function measures(page: Page, name: string): Promise<number[]> {
  return page.evaluate((measureName) => performance.getEntriesByName(measureName).map((entry) => entry.duration), name);
}

/**
 * Records every frame for `run`, which scrolls or zooms: the time between frames, and whether the view was waiting for fresh tiles
 * (stand-ins shown) or showed a placeholder (no tile at all) in that frame.
 */
async function frames(page: Page, run: () => Promise<void>): Promise<Record<string, unknown>> {
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("[data-testid=document-tiles]");
    const log = { intervals: [] as number[], waiting: 0, placeholders: 0, frames: 0, last: 0, on: true };
    Object.assign(window, { __frames: log });
    const tick = (time: number) => {
      if (!log.on) return;
      if (log.last > 0) log.intervals.push(time - log.last);
      log.last = time;
      log.frames += 1;
      if (Number(canvas?.dataset["tilesVisibleMissing"] ?? 0) > 0) log.waiting += 1;
      if (Number(canvas?.dataset["placeholderPages"] ?? 0) > 0) log.placeholders += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await run();
  const log = await page.evaluate(() => {
    const result = (
      window as unknown as {
        __frames: { intervals: number[]; waiting: number; placeholders: number; frames: number; on: boolean };
      }
    ).__frames;
    result.on = false;
    return result;
  });
  return {
    frames: log.frames,
    frameIntervalMs: summarize(log.intervals),
    framesOver33ms: log.intervals.filter((interval) => interval > 33.4).length,
    framesWaitingForFreshTiles: log.waiting,
    framesWithPlaceholder: log.placeholders,
  };
}

test("keystroke to overlay and to tile, and the worker's round trips", async ({ page }, testInfo) => {
  await page.goto("/");
  await waitForDocument(page);
  const first = await pageBox(page, 0);
  await page.getByTestId("document-scroller").click({ position: { x: first.x + first.width / 2, y: first.y + 60 } });
  // Steady typing, about 12 characters a second, then a burst as fast as the keyboard sends.
  await page.keyboard.type("the quick brown fox jumps over the lazy dog ", { delay: 80 });
  await waitForTiles(page);
  const steady = {
    keyToOverlayDrawn: summarize(await measures(page, "bayan:key-to-overlay-drawn")),
    keyToOverlayFrame: summarize(await measures(page, "bayan:key-to-overlay-frame")),
    keyToTileDrawn: summarize(await measures(page, "bayan:key-to-tile-drawn")),
  };
  await page.evaluate(() => performance.clearMeasures());
  await page.keyboard.type("pack my box with five dozen liquor jugs ");
  await waitForTiles(page);
  const burst = {
    keyToOverlayDrawn: summarize(await measures(page, "bayan:key-to-overlay-drawn")),
    keyToOverlayFrame: summarize(await measures(page, "bayan:key-to-overlay-frame")),
    keyToTileDrawn: summarize(await measures(page, "bayan:key-to-tile-drawn")),
    roundTrips: {
      "input.text": summarize(await measures(page, "bayan:engine:input.text")),
      "render.tile": summarize(await measures(page, "bayan:engine:render.tile")),
    },
  };
  await record(testInfo, "keystroke-latency", { steady, burst });
  expect(steady.keyToOverlayDrawn["count"]).toBeGreaterThanOrEqual(40);
  expect(steady.keyToOverlayFrame["p95"]).toBeLessThan(1000);
});

test("frame times while scrolling through the document", async ({ page }, testInfo) => {
  await page.goto("/");
  await waitForDocument(page);
  const figures = await frames(page, async () => {
    // Scroll at 1,500 CSS pixels a second, one step per frame, to the end and back: about 3 seconds.
    await page.getByTestId("document-scroller").evaluate(
      (scroller) =>
        new Promise<void>((resolve) => {
          const end = scroller.scrollHeight - scroller.clientHeight;
          let direction = 1;
          let last = 0;
          const step = (time: number) => {
            const delta = last === 0 ? 16 : time - last;
            last = time;
            scroller.scrollTop += direction * 1.5 * delta;
            if (direction === 1 && scroller.scrollTop >= end - 1) direction = -1;
            if (direction === -1 && scroller.scrollTop <= 0) return resolve();
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }),
    );
    await waitForTiles(page);
  });
  await record(testInfo, "scroll-frames", figures);
  expect(figures["frames"]).toBeGreaterThan(30);
});

test("frame times while zooming", async ({ page }, testInfo) => {
  await page.goto("/");
  await waitForDocument(page);
  const figures = await frames(page, async () => {
    for (const button of [
      "Zoom in",
      "Zoom in",
      "Zoom in",
      "Zoom out",
      "Zoom out",
      "Zoom out",
      "Zoom out",
      "Zoom out",
    ]) {
      await page.getByRole("button", { name: button }).click();
      await waitForTiles(page);
    }
  });
  await record(testInfo, "zoom-frames", figures);
  expect(figures["framesWithPlaceholder"]).toBe(0);
});

test("start-up, the worker's round trips and memory", async ({ page, browserName }, testInfo) => {
  await page.goto("/");
  await waitForDocument(page);
  const startup = {
    engineVerifyAndWorker: summarize(await measures(page, "bayan:engine-verify")),
    engineReady: summarize(await measures(page, "bayan:engine-start")),
    navigationToEngineReady: await page.evaluate(() => {
      const ready = performance.getEntriesByName("bayan:engine-start")[0];
      return ready === undefined ? null : Math.round(ready.startTime + ready.duration);
    }),
  };
  const roundTrips = Object.fromEntries(
    await Promise.all(
      ["hello", "ui.manifest", "doc.open", "view.set", "query.a11y", "render.tile"].map(
        async (type) => [type, summarize(await measures(page, `bayan:engine:${type}`))] as const,
      ),
    ),
  );
  const tiles = page.getByTestId("document-tiles");
  const memory: Record<string, unknown> = {
    tilesHeld: Number(await tiles.getAttribute("data-tiles-held")),
    tileBytes: Number(await tiles.getAttribute("data-tile-bytes")),
  };
  if (browserName === "chromium") {
    memory["chromium"] = await page.evaluate(async () => {
      // The whole page's memory, the worker and its WebAssembly memory included. It needs cross-origin isolation, which the app has, and
      // a browser that offers it (Playwright's headless shell does not); the main thread's JavaScript heap is the fallback.
      const api = performance as unknown as {
        measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
        memory?: { usedJSHeapSize: number };
      };
      let userAgentSpecificMemoryBytes: number | null = null;
      try {
        if (api.measureUserAgentSpecificMemory !== undefined) {
          const result = await Promise.race([
            api.measureUserAgentSpecificMemory(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 25_000)),
          ]);
          userAgentSpecificMemoryBytes = result?.bytes ?? null;
        }
      } catch {
        userAgentSpecificMemoryBytes = null;
      }
      return { userAgentSpecificMemoryBytes, mainThreadJsHeapBytes: api.memory?.usedJSHeapSize ?? null };
    });
  }
  await record(testInfo, "startup-roundtrips-memory", { startup, roundTrips, memory });
  expect(startup.engineReady["count"]).toBe(1);
});
