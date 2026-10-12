import { expect, test } from "@playwright/test";
import { waitForDocument } from "./document.ts";

// The accessibility mirror v0 (WEB-002, ADR-0020 §4): the engine's accessibility tree as DOM that assistive technology reads, and the
// caret-sync prototype. Screen readers themselves are tested by hand (docs/spikes/WEB-002-report.md, "Screen-reader scripts"); these
// tests check what the screen readers are given.

test("the mirror gives assistive technology the document's headings, paragraphs, list and table", async ({ page }) => {
  await page.goto("/");
  await waitForDocument(page);
  await expect(page.getByTestId("a11y-mirror")).toMatchAriaSnapshot(`
    - document "BayanDocs mock document":
      - heading "BayanDocs mock document" [level=1]
      - paragraph: /^This document stands in for real documents/
      - paragraph: /^The box below is the editable line/
      - textbox "Editable line"
      - heading "A short list" [level=2]
      - list:
        - listitem: Scrolling and zooming across pages
        - listitem: Typing and input method composition
        - listitem: Reading the document with a screen reader
      - heading "A small table" [level=2]
      - table:
        - row "Shell Toolkit Language":
          - columnheader "Shell"
          - columnheader "Toolkit"
          - columnheader "Language"
        - row "Desktop Qt Quick C++":
          - cell "Desktop"
          - cell "Qt Quick"
          - cell "C++"
        - row "Web React TypeScript":
          - cell "Web"
          - cell "React"
          - cell "TypeScript"
      - heading "Why a mock document" [level=2]
      - paragraph: /^The engine skeleton exists/
      - paragraph: /^Every page you see is drawn by the engine/
      - paragraph: /^Pressing a key/
      - paragraph: /^A recording captures every message/
      - paragraph: /^If the engine ever fails/
      - heading "The last page" [level=2]
      - paragraph: /^Tables, lists and headings/
      - paragraph: /^Characters from any script/
      - paragraph: /^The page size is US Letter/
      - paragraph: This is the end of the mock document.
  `);
});

test("the pages' pixels are hidden from assistive technology, which reads the mirror instead", async ({ page }) => {
  await page.goto("/");
  await waitForDocument(page);
  const pages = page.getByRole("region", { name: "Pages" });
  await expect(pages).toBeVisible();
  await expect(page.locator(".document-canvases")).toHaveAttribute("aria-hidden", "true");
  await expect(pages.getByRole("img")).toHaveCount(0);
  await expect(pages.getByRole("document", { name: "BayanDocs mock document" })).toBeAttached();
});

test("Chromium's own accessibility tree contains the mirror's structure and text", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "only Chromium's DevTools protocol exposes the browser's accessibility tree");
  await page.goto("/");
  await waitForDocument(page);
  const session = await page.context().newCDPSession(page);
  const { nodes } = (await session.send("Accessibility.getFullAXTree")) as {
    nodes: { ignored: boolean; role?: { value: string }; name?: { value: string } }[];
  };
  const exposed = nodes
    .filter((node) => !node.ignored)
    .map((node) => `${node.role?.value ?? ""}: ${node.name?.value ?? ""}`.trim());
  for (const expected of [
    "heading: BayanDocs mock document",
    "heading: A short list",
    "StaticText: Typing and input method composition",
    "columnheader: Toolkit",
    "cell: TypeScript",
    "textbox: Editable line",
  ]) {
    expect(exposed).toContain(expected);
  }
  expect(exposed.some((entry) => entry.startsWith("StaticText: This document stands in"))).toBe(true);
  expect(exposed.filter((entry) => entry === "listitem:")).toHaveLength(3);
  expect(exposed.filter((entry) => entry === "row:")).toHaveLength(3);
  expect(exposed.filter((entry) => entry.startsWith("canvas") || entry.startsWith("Canvas"))).toEqual([]);
});

test("the editable text is a textbox that holds the engine's text, with its caret where the engine's caret is", async ({
  page,
}) => {
  await page.goto("/");
  await waitForDocument(page);
  const editable = page.getByRole("textbox", { name: "Editable line" });
  const box = await page.getByTestId("document-scroller").boundingBox();
  await page.getByTestId("document-scroller").click({ position: { x: (box?.width ?? 800) / 2, y: 80 } });
  await expect(editable).toBeFocused();
  await page.keyboard.type("word");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  // What a screen reader reads at the caret: the textbox's text, and the caret two characters from its end.
  const state = async () =>
    editable.evaluate((element) => {
      if (element instanceof HTMLTextAreaElement) return { text: element.value, caret: element.selectionStart };
      const selection = document.getSelection();
      return {
        text: element.textContent,
        caret: selection?.anchorNode && element.contains(selection.anchorNode) ? selection.anchorOffset : null,
      };
    });
  await expect.poll(state).toEqual({ text: "word", caret: 2 });
});
