import { expect, type Page } from "@playwright/test";

/**
 * How long to wait for the engine to start and for the tiles to arrive. The compositor asks for the next tile in the animation frame
 * after the last one arrived, so filling a page takes about one frame per tile, and where the browser's frames are slow its 12 to 18
 * tiles need more than Playwright's default 5 s: WebKit's single frames took up to 3 s on CI's macOS 26 Intel runner, and it is slow in
 * containers without a graphics processor too, where it draws in software. These waits check that the engine starts and the tiles
 * arrive, not how fast; measurements.spec.ts measures that.
 */
const renderTimeoutMs = 30_000;

/** Waits until the engine is ready, the mock document is open and every visible tile is drawn. */
export async function waitForDocument(page: Page): Promise<void> {
  await expect(page.locator(".document-view")).toHaveAttribute("data-engine-state", "ready", {
    timeout: renderTimeoutMs,
  });
  await expect(page.getByTestId("a11y-mirror").getByRole("heading", { level: 1 })).toBeAttached({
    timeout: renderTimeoutMs,
  });
  await waitForTiles(page);
}

/** Waits until the compositor has every visible tile at the current scale, with no request outstanding. */
export async function waitForTiles(page: Page): Promise<void> {
  // The counts are updated once per frame, so let a frame pass first: an invalidation that just arrived is then counted.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const tiles = page.getByTestId("document-tiles");
  await expect(tiles).toHaveAttribute("data-tiles-missing", "0", { timeout: renderTimeoutMs });
  await expect(tiles).toHaveAttribute("data-tiles-in-flight", "0", { timeout: renderTimeoutMs });
}

/** The colour of a device pixel of the tile canvas, as [r, g, b, a]. */
export async function tilePixel(page: Page, x: number, y: number): Promise<number[]> {
  return page.getByTestId("document-tiles").evaluate(
    (canvas, [px, py]) => {
      const context = (canvas as HTMLCanvasElement).getContext("2d");
      return context === null ? [] : [...context.getImageData(px ?? 0, py ?? 0, 1, 1).data];
    },
    [x, y],
  );
}

/** The mock document's page size and gap in CSS pixels at zoom 1 (bayan-engine's mock: US Letter pages, a quarter inch apart). */
export const mockPage = { width: 816, height: 1056, gap: 24 } as const;

/** The mock document's colours (bayan-engine's mock/geometry.rs), as [r, g, b, a] in the canvas. */
export const mockColours = {
  paper: [255, 255, 255, 255],
  editableFill: [255, 248, 220, 255],
  accent: [26, 115, 232, 255],
  ink: [32, 33, 36, 255],
  transparent: [0, 0, 0, 0],
} as const;

/** Where page `index` of the mock document is on the tile canvas, in CSS pixels, from the scrolled content's size and position. */
export async function pageBox(
  page: Page,
  index: number,
): Promise<{ x: number; y: number; width: number; height: number }> {
  return page.getByTestId("document-scroller").evaluate(
    (scroller, [pageIndex, width, height, gap]) => {
      const extent = scroller.firstElementChild as HTMLElement;
      const zoom = Number((document.querySelector(".zoom-level")?.textContent ?? "100").replace("%", "")) / 100;
      const areaWidth = (width ?? 0) * zoom;
      const x = (extent.offsetWidth - areaWidth) / 2 - scroller.scrollLeft;
      const y = 24 + (pageIndex ?? 0) * ((height ?? 0) + (gap ?? 0)) * zoom - scroller.scrollTop;
      return { x, y, width: areaWidth, height: (height ?? 0) * zoom };
    },
    [index, mockPage.width, mockPage.height, mockPage.gap],
  );
}

/** The colour of the tile canvas at a point given in CSS pixels relative to the canvas. */
export async function colourAt(page: Page, x: number, y: number): Promise<number[]> {
  const ratio = await page.evaluate(() => window.devicePixelRatio);
  return tilePixel(page, Math.round(x * ratio), Math.round(y * ratio));
}
