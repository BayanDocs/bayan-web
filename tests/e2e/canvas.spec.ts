import { expect, test } from "@playwright/test";
import { colourAt, mockColours, mockPage, pageBox, waitForDocument, waitForTiles } from "./document.ts";

// WEB-002 AC-1, the compositor: the engine's tiles reach the canvas, scrolling and zooming keep it filled, and a change of
// devicePixelRatio re-renders at the new resolution. Frame-time figures are in measurements.spec.ts.

test("draws the mock document's first page from the engine's tiles", async ({ page }) => {
  await page.goto("/");
  await waitForDocument(page);
  const first = await pageBox(page, 0);
  expect(await colourAt(page, first.x + first.width / 2, first.y + 40)).toEqual(mockColours.paper);
  // Left of the page there is no page: the canvas is transparent there and the app's background shows.
  expect(await colourAt(page, first.x - 8, first.y + 40)).toEqual(mockColours.transparent);
  const held = Number(await page.getByTestId("document-tiles").getAttribute("data-tiles-held"));
  expect(held).toBeGreaterThan(0);
});

test("scrolls through every page, drawing each from fresh tiles", async ({ page }) => {
  await page.goto("/");
  await waitForDocument(page);
  const scroller = page.getByTestId("document-scroller");
  for (const index of [1, 2]) {
    await scroller.evaluate((element, top) => element.scrollTo({ top, behavior: "instant" }), 24 + index * 1080 - 40);
    await waitForTiles(page);
    const box = await pageBox(page, index);
    expect(box.y).toBeCloseTo(40, 0);
    expect(await colourAt(page, box.x + box.width / 2, box.y + 8), `page ${index + 1}`).toEqual(mockColours.paper);
    // The gap between pages stays empty.
    expect(await colourAt(page, box.x + box.width / 2, box.y - 12), `gap above page ${index + 1}`).toEqual(
      mockColours.transparent,
    );
  }
});

test("zooms in and out without an empty frame: old tiles stand in, scaled, until fresh ones arrive", async ({
  page,
}) => {
  await page.goto("/");
  await waitForDocument(page);
  // Watch one point inside the first page on every frame from before the first zoom until after the last.
  await page.getByTestId("document-tiles").evaluate((canvas: HTMLCanvasElement) => {
    const samples: number[] = [];
    Object.assign(window, { __zoomSamples: samples, __sampling: true });
    const context = canvas.getContext("2d");
    const sample = () => {
      if (!(window as unknown as { __sampling: boolean }).__sampling || context === null) return;
      const x = Math.round(canvas.width / 2);
      const y = Math.round(80 * window.devicePixelRatio);
      samples.push(context.getImageData(x, y, 1, 1).data[3] ?? 0);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const zoom = page.locator(".zoom-level");
  for (const [button, level] of [
    ["Zoom in", "110%"],
    ["Zoom in", "125%"],
    ["Zoom out", "110%"],
    ["Zoom out", "100%"],
    ["Zoom out", "90%"],
  ] as const) {
    await page.getByRole("button", { name: button }).click();
    await expect(zoom).toHaveText(level);
    await waitForTiles(page);
  }
  const samples = await page.evaluate(() => {
    Object.assign(window, { __sampling: false });
    return (window as unknown as { __zoomSamples: number[] }).__zoomSamples;
  });
  expect(samples.length).toBeGreaterThan(5);
  // Every frame showed the page's paper (alpha 255), never a gap, a placeholder or an empty canvas.
  expect(samples.filter((alpha) => alpha !== 255)).toEqual([]);
  const box = await pageBox(page, 0);
  expect(box.width).toBeCloseTo(mockPage.width * 0.9, 0);
  expect(await colourAt(page, box.x + box.width / 2, box.y + 40)).toEqual(mockColours.paper);
});

test("the zoom buttons work from the keyboard", async ({ page }) => {
  await page.goto("/");
  await waitForDocument(page);
  await page.getByRole("button", { name: "Zoom in" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".zoom-level")).toHaveText("110%");
  await page.getByRole("button", { name: "Zoom out" }).focus();
  await page.keyboard.press("Space");
  await expect(page.locator(".zoom-level")).toHaveText("100%");
});

test("follows a change of devicePixelRatio while running (Chromium)", async ({ page, browserName }) => {
  test.skip(
    browserName !== "chromium",
    "only Chromium lets a test change devicePixelRatio of a running page (DevTools protocol)",
  );
  await page.goto("/");
  await waitForDocument(page);
  // As when the window moves to another screen: a new ratio and a new size. (DevTools' emulation of a ratio change alone fires no event
  // the page could notice, which a real change of screen or of browser zoom does.)
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 700,
    deviceScaleFactor: 2,
    mobile: false,
  });
  const tiles = page.getByTestId("document-tiles");
  await expect
    .poll(() => tiles.evaluate((canvas: HTMLCanvasElement) => canvas.width / canvas.getBoundingClientRect().width))
    .toBeCloseTo(2, 2);
  await waitForTiles(page);
  const box = await pageBox(page, 0);
  expect(await colourAt(page, box.x + box.width / 2, box.y + 40)).toEqual(mockColours.paper);
});
