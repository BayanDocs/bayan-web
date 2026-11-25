import { expect, test } from "@playwright/test";
import { colourAt, mockColours, mockPage, pageBox, waitForDocument, waitForTiles } from "./document.ts";

// WEB-002 AC-1, the compositor: the engine's tiles reach the canvas, scrolling and zooming keep it filled, and a change of
// devicePixelRatio re-renders at the new resolution. Frame-time figures are in measurements.spec.ts. WEB-004: tiles are kept by render
// revision (engine protocol §14.6), and in print mode a view.set invalidates nothing, so the compositor requests what a new scale needs
// itself and nothing else.

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

test("an edit re-renders only the changed part of a tile, and the patch shows exactly what a whole tile would", async ({
  page,
}) => {
  const renders: { width: number; height: number }[] = [];
  await page.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    const sizes: { width: number; height: number }[] = [];
    Worker.prototype.postMessage = function (this: Worker, message: unknown, transfer?: Transferable[]) {
      const envelope = message as { type?: unknown; payload?: { width?: number; height?: number } };
      if (envelope.type === "render.tile")
        sizes.push({ width: envelope.payload?.width ?? 0, height: envelope.payload?.height ?? 0 });
      return Reflect.apply(post, this, [message, transfer]);
    } as typeof Worker.prototype.postMessage;
    Object.assign(globalThis, { __renders: sizes });
  });
  await page.goto("/");
  await waitForDocument(page);
  const first = await pageBox(page, 0);
  await page.getByTestId("document-scroller").click({ position: { x: first.x + first.width / 2, y: first.y + 60 } });
  await page.evaluate(() => {
    (globalThis as unknown as { __renders: unknown[] }).__renders.length = 0;
  });
  await page.keyboard.type("patch");
  await expect
    .poll(() =>
      page
        .locator(".input-bridge")
        .evaluate((element) => (element instanceof HTMLTextAreaElement ? element.value : element.textContent)),
    )
    .toBe("patch");
  await waitForTiles(page);
  renders.push(
    ...(await page.evaluate(
      () => (globalThis as unknown as { __renders: { width: number; height: number }[] }).__renders,
    )),
  );
  // Every request after typing was a strip of the editable line, far smaller than a whole tile.
  expect(renders.length).toBeGreaterThan(0);
  for (const size of renders) expect(size.width * size.height).toBeLessThan((512 * 512) / 4);

  const scroller = page.getByTestId("document-scroller");
  const digest = () =>
    page.getByTestId("document-tiles").evaluate(async (canvas: HTMLCanvasElement) => {
      const pixels =
        canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data ?? new Uint8ClampedArray();
      const hash = await crypto.subtle.digest("SHA-256", pixels);
      return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    });
  const position = await scroller.evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop }));
  const patched = await digest();
  // Zooming in and back out renders the tiles of this scale again, whole.
  await page.getByRole("button", { name: "Zoom in" }).click();
  await waitForTiles(page);
  await page.getByRole("button", { name: "Zoom out" }).click();
  await scroller.evaluate((element, { left, top }) => element.scrollTo({ left, top, behavior: "instant" }), position);
  await waitForTiles(page);
  expect(await digest()).toBe(patched);
});

test("a view.set for a new viewport renders nothing again: in print mode the engine invalidates nothing for it (FU-25)", async ({
  page,
}) => {
  // FU-25: the test above failed now and then on CI's macOS 15 runner because whole tiles were requested while typing. Its trace showed
  // the four requests after typing to be a whole tile, the edit's two patches and another whole tile: the pattern of a view.set that
  // arrived after the page had filled, sent by the app's resize handler a moment after the document opened, for which protocol v0
  // invalidated every page, so that the compositor rendered every tile again. Protocol v1 invalidates nothing for a view.set that changes
  // only the viewport, zoom or device scale (§14.6 item 2): this test sends one by resizing the window, and nothing is rendered again.
  await page.addInitScript(() => {
    const sent: string[] = [];
    const invalidations: unknown[] = [];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, transfer?: Transferable[]) {
      const envelope = message as { worker?: unknown; type?: unknown } | null;
      if (envelope?.worker === "init") {
        this.addEventListener("message", (event: MessageEvent<unknown>) => {
          const data = event.data as { type?: unknown; payload?: unknown } | null;
          if (data?.type === "render.invalidate") invalidations.push(data.payload);
        });
      }
      if (typeof envelope?.type === "string") sent.push(envelope.type);
      return Reflect.apply(post, this, [message, transfer]);
    } as typeof Worker.prototype.postMessage;
    Object.assign(globalThis, { __sent: sent, __invalidations: invalidations });
  });
  await page.goto("/");
  await waitForDocument(page);
  // Past the app's quiet period for view.set, so that no earlier one is still to come.
  await page.waitForTimeout(500);
  await waitForTiles(page);
  await page.evaluate(() => {
    const scope = globalThis as unknown as { __sent: string[]; __invalidations: unknown[] };
    scope.__sent.length = 0;
    scope.__invalidations.length = 0;
  });
  // Ten pixels taller: the same tiles are in view and in the margin around it, so the compositor needs no new one.
  const size = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.setViewportSize({ width: size.width, height: size.height + 10 });
  const sent = () => page.evaluate(() => (globalThis as unknown as { __sent: string[] }).__sent.slice());
  await expect.poll(sent).toContain("view.set");
  await page.waitForTimeout(500);
  await waitForTiles(page);
  expect((await sent()).filter((type) => type === "render.tile")).toEqual([]);
  expect(await page.evaluate(() => (globalThis as unknown as { __invalidations: unknown[] }).__invalidations)).toEqual(
    [],
  );
  const first = await pageBox(page, 0);
  expect(await colourAt(page, first.x + first.width / 2, first.y + 40)).toEqual(mockColours.paper);
});
