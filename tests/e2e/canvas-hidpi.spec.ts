import { expect, test } from "@playwright/test";
import { colourAt, mockColours, pageBox, waitForDocument } from "./document.ts";

// WEB-002 AC-1: the compositor renders at device resolution on a high-density screen, in all three engines. A file of its own, because
// Firefox needs a launch option: Playwright's Firefox ignores deviceScaleFactor, and Firefox's own preference sets the ratio instead
// (the other browsers ignore that preference).
test.use({ deviceScaleFactor: 2, launchOptions: { firefoxUserPrefs: { "layout.css.devPixelsPerPx": "2" } } });

test("renders tiles at device resolution when devicePixelRatio is 2", async ({ page }) => {
  await page.goto("/");
  await waitForDocument(page);
  const size = await page.getByTestId("document-tiles").evaluate((canvas: HTMLCanvasElement) => ({
    width: canvas.width,
    cssWidth: canvas.getBoundingClientRect().width,
  }));
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);
  expect(size.width).toBe(Math.round(size.cssWidth * 2));
  const box = await pageBox(page, 0);
  expect(await colourAt(page, box.x + box.width / 2, box.y + 40)).toEqual(mockColours.paper);
});
