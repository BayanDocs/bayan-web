import { expect, type Page, test } from "@playwright/test";
import { collectProblems } from "./collect-problems.ts";
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

test("the mirror and the input bridge are left out of the browser's page translation", async ({ page }) => {
  await page.goto("/");
  await waitForDocument(page);
  const mirror = page.getByTestId("a11y-mirror");
  await expect(mirror).toHaveAttribute("translate", "no");
  await expect(page.locator(".input-bridge")).toHaveAttribute("translate", "no");
  // Every element in the mirror inherits it, so a translator is offered none of the document's text.
  const translatable = await mirror.evaluate((container) =>
    [container, ...container.querySelectorAll("*")]
      .filter((element) => !(element instanceof HTMLElement) || element.translate)
      .map((element) => element.tagName),
  );
  expect(translatable).toEqual([]);
});

/** Keeps the engine's worker and the open document's identifier, so that a test can hand the app a message as the engine would. */
async function keepWorker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, transfer?: Transferable[]) {
      if ((message as { worker?: unknown } | null)?.worker === "init") {
        Object.assign(globalThis, { __engineWorker: this });
        this.addEventListener("message", (event: MessageEvent<unknown>) => {
          const reply = event.data as { type?: unknown; payload?: { doc_id?: unknown } } | null;
          if (reply?.type === "doc.opened") Object.assign(globalThis, { __docId: reply.payload?.doc_id });
        });
      }
      return Reflect.apply(post, this, [message, transfer]);
    } as typeof Worker.prototype.postMessage;
  });
}

test("a tree deeper than the mirror's limit becomes lines of text below the limit, without crashing or freezing", async ({
  page,
}) => {
  const problems = await collectProblems(page);
  await keepWorker(page);
  await page.goto("/");
  await waitForDocument(page);
  const mirror = page.getByTestId("a11y-mirror");
  const id = Number(await mirror.getByText("This is the end of the mock document.").getAttribute("data-node-id"));
  expect(id).toBeGreaterThan(0);
  // An a11y.update that replaces the last paragraph (level 2, below the document) with a chain of 100,000 nested nodes, which the
  // mirror would overflow the call stack on if it built the tree by recursion all the way down. Only some of the nodes have text.
  await page.evaluate(
    ({ nodeId, deepest }) => {
      interface Node {
        id: number;
        role: string;
        text?: string;
        children?: Node[];
      }
      const texts = new Map<number, string>([
        [2, "Level 2"],
        [64, "Level 64"],
        [65, "Level 65"],
        [66, "Level 66"],
        [deepest, "The deepest level"],
      ]);
      let node: Node | undefined;
      for (let level = deepest; level >= 2; level -= 1) {
        const parent: Node = { id: level === 2 ? nodeId : 1_000_000 + level, role: "paragraph" };
        const text = texts.get(level);
        if (text !== undefined) parent.text = text;
        if (node !== undefined) parent.children = [node];
        node = parent;
      }
      const scope = globalThis as unknown as { __engineWorker: Worker; __docId: number };
      const update = { doc_id: scope.__docId, changes: [{ kind: "replace", node }], caret: null };
      scope.__engineWorker.dispatchEvent(
        new MessageEvent("message", { data: { v: 0, type: "a11y.update", seq: 1_000_000, payload: update } }),
      );
    },
    { nodeId: id, deepest: 100_001 },
  );
  // The replaced paragraph, its own text first.
  const replaced = mirror.locator(`[data-node-id="${id}"]`);
  await expect(replaced).toBeAttached();
  expect(await replaced.evaluate((element) => element.firstChild?.textContent)).toBe("Level 2");
  // Levels 2 to 64 are elements of their own; below that, each node with text is one line in the element of level 64, in order.
  const deepestElement = mirror.locator('[data-node-id="1000064"]');
  await expect(deepestElement.locator("> div")).toHaveText(["Level 65", "Level 66", "The deepest level"]);
  const depth = await mirror.evaluate((container) => {
    let deepest = 0;
    for (const element of container.querySelectorAll("*")) {
      let level = 0;
      for (
        let current: Element | null = element;
        current !== null && current !== container;
        current = current.parentElement
      ) {
        level += 1;
      }
      deepest = Math.max(deepest, level);
    }
    return deepest;
  });
  // 64 levels of nodes, and the lines inside the last one.
  expect(depth).toBe(65);
  // The app still works: the editable line still takes typing and shows the engine's text.
  const editable = page.getByRole("textbox", { name: "Editable line" });
  const box = await page.getByTestId("document-scroller").boundingBox();
  await page.getByTestId("document-scroller").click({ position: { x: (box?.width ?? 800) / 2, y: 80 } });
  await expect(editable).toBeFocused();
  await page.keyboard.type("ok");
  await expect
    .poll(() =>
      editable.evaluate((element) =>
        element instanceof HTMLTextAreaElement ? element.value : (element.textContent ?? ""),
      ),
    )
    .toBe("ok");
  expect(await problems()).toEqual([]);
});

/**
 * The updates the timing test hands the app, built in the page: `many-deepest` replaces the last paragraph (level 2) with a chain down to
 * level 63 whose node there has `n` children on level 64, the mirror's deepest level, each with one child below it; `one-deepest` replaces
 * it with a chain to a single node on level 64 with 20,000 children below it; and `changes-below` changes `n` of those children.
 */
type UpdateShape = "many-deepest" | "one-deepest" | "changes-below";

/**
 * Hands the app an a11y.update of shape `shape` as the engine would send it, `rounds` times, each built afresh, and returns the fastest time
 * the mirror took, in milliseconds: the update is applied synchronously while the event is dispatched. The fastest of several rounds keeps
 * garbage collection and other noise out of the comparison.
 */
async function timeUpdates(
  page: Page,
  paragraph: number,
  shape: UpdateShape,
  n: number,
  rounds: number,
): Promise<number> {
  return page.evaluate(
    ({ paragraph, shape, n, rounds }) => {
      interface Node {
        id: number;
        role: string;
        text?: string;
        children?: Node[];
      }
      const chainDownTo = (deepest: Node, level: number): Node => {
        let node = deepest;
        for (let above = level - 1; above >= 2; above -= 1) {
          node = { id: above === 2 ? paragraph : 3_000_000 + above, role: "paragraph", children: [node] };
        }
        return node;
      };
      const changes = (round: number): { kind: string; node: Node }[] => {
        if (shape === "many-deepest") {
          const parent: Node = { id: 3_000_063, role: "paragraph", children: [] };
          for (let i = 0; i < n; i += 1) {
            const below: Node = { id: 5_000_000 + i, role: "paragraph", text: `Below ${i} in round ${round}` };
            parent.children?.push({ id: 4_000_000 + i, role: "paragraph", text: `Owner ${i}`, children: [below] });
          }
          return [{ kind: "replace", node: chainDownTo(parent, 63) }];
        }
        if (shape === "one-deepest") {
          const owner: Node = { id: 6_000_000, role: "paragraph", text: "Owner", children: [] };
          for (let i = 0; i < 20_000; i += 1)
            owner.children?.push({ id: 7_000_000 + i, role: "paragraph", text: `Line ${i}` });
          return [{ kind: "replace", node: chainDownTo(owner, 64) }];
        }
        return Array.from({ length: n }, (_, i) => ({
          kind: "replace",
          node: { id: 7_000_000 + i * 37, role: "paragraph", text: `Changed ${i * 37} in round ${round}` },
        }));
      };
      const scope = globalThis as unknown as { __engineWorker: Worker; __docId: number };
      let fastest = Number.POSITIVE_INFINITY;
      for (let round = 0; round < rounds; round += 1) {
        const payload = { doc_id: scope.__docId, changes: changes(round), caret: null };
        const event = new MessageEvent("message", {
          data: { v: 0, type: "a11y.update", seq: 2_000_000 + round, payload },
        });
        const start = performance.now();
        scope.__engineWorker.dispatchEvent(event);
        fastest = Math.min(fastest, performance.now() - start);
      }
      return fastest;
    },
    { paragraph, shape, n, rounds },
  );
}

test("updates below the mirror's depth limit take time in proportion to their size", async ({ page }) => {
  const problems = await collectProblems(page);
  await keepWorker(page);
  await page.goto("/");
  await waitForDocument(page);
  const mirror = page.getByTestId("a11y-mirror");
  const id = Number(await mirror.getByText("This is the end of the mock document.").getAttribute("data-node-id"));
  expect(id).toBeGreaterThan(0);
  // Replacing the ancestor of many nodes on the deepest level forgets them all and builds them again. Ten times as many must take about ten
  // times as long; forgetting each of them by searching all the others (the code before this test) made it a hundred times as long.
  const small = await timeUpdates(page, id, "many-deepest", 2_000, 3);
  const large = await timeUpdates(page, id, "many-deepest", 20_000, 3);
  await expect(mirror.getByText("Below 19999 in round 2")).toBeAttached();
  expect(large / Math.max(small, 1), `2,000 nodes took ${small} ms, 20,000 took ${large} ms`).toBeLessThan(30);
  // Many changes below one node on the deepest level: each costs time in proportion to its own size, and the node's flattened text is
  // rebuilt once per update, so 400 changes take about as long as one; rebuilding it after each change made them take 400 times as long.
  await timeUpdates(page, id, "one-deepest", 1, 1);
  const one = await timeUpdates(page, id, "changes-below", 1, 3);
  const many = await timeUpdates(page, id, "changes-below", 400, 3);
  expect(many / Math.max(one, 1), `1 change took ${one} ms, 400 took ${many} ms`).toBeLessThan(8);
  // And the changes are there, each in its place among the lines.
  const owner = mirror.locator('[data-node-id="6000000"]');
  await expect(owner.locator("> div").nth(0)).toHaveText("Changed 0 in round 2");
  await expect(owner.locator("> div").nth(37)).toHaveText("Changed 37 in round 2");
  await expect(owner.locator("> div").nth(38)).toHaveText("Line 38");
  await expect(owner.locator("> div").nth(399 * 37)).toHaveText(`Changed ${399 * 37} in round 2`);
  await expect(owner.locator("> div")).toHaveCount(20_000);
  expect(await problems()).toEqual([]);
});
