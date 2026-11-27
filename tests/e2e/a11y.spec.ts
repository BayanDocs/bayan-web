import { expect, type Page, test } from "@playwright/test";
import type { A11yChange, A11yNode, A11yUpdate, EngineEvent } from "../../src/engine/protocol.ts";
import { partId, partQueries, releaseParts, standInForParts } from "./a11y-parts.ts";
import { collectProblems } from "./collect-problems.ts";
import { keepWorker, waitForDocument } from "./document.ts";

// The accessibility mirror (WEB-002, ADR-0020 §4): the engine's accessibility tree as DOM that assistive technology reads, and the
// caret-sync prototype. Screen readers themselves are tested by hand (docs/spikes/WEB-002-report.md, "Screen-reader scripts"); these
// tests check what the screen readers are given. Protocol v1 (WEB-004, engine protocol §14.7 item 1): the engine keeps its trees within
// 64 levels and 200,000 nodes per message, the mirror treats a tree beyond them as a protocol violation, and it loads the parts of a
// node's children that one message did not hold. The messages that the tests hand the app as the engine would send them are typed with
// the protocol's types from the pinned engine package (src/engine/protocol.ts), so that the type check holds them to the protocol.

const stopped = "The engine stopped. Reload the page to start it again.";

/** Dispatches an a11y.update that replaces node `nodeId` (on level 2) with a chain of paragraphs down to level `deepest`. */
async function replaceWithChain(page: Page, nodeId: number, deepest: number): Promise<void> {
  await page.evaluate(
    ({ nodeId, deepest }) => {
      let node: A11yNode | undefined;
      for (let level = deepest; level >= 2; level -= 1) {
        const parent: A11yNode = {
          id: level === 2 ? nodeId : 1_000_000 + level,
          role: "paragraph",
          text: `Level ${level}`,
        };
        if (node !== undefined) parent.children = [node];
        node = parent;
      }
      if (node === undefined) throw new Error("A chain starts on level 2.");
      const scope = globalThis as unknown as { __engineWorker: Worker; __docId: number };
      const update: A11yUpdate = { doc_id: scope.__docId, changes: [{ kind: "replace", node }], caret: null };
      const message: EngineEvent<"a11y.update"> = { v: 1, type: "a11y.update", seq: 1_000_000, payload: update };
      scope.__engineWorker.dispatchEvent(new MessageEvent("message", { data: message }));
    },
    { nodeId, deepest },
  );
}

/** How many levels of elements the mirror holds below its container. */
function mirrorDepth(page: Page): Promise<number> {
  return page.getByTestId("a11y-mirror").evaluate((container) => {
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
}

/** Clicks into the editable line, which takes keyboard focus. */
async function focusTheEditableLine(page: Page): Promise<void> {
  const box = await page.getByTestId("document-scroller").boundingBox();
  await page.getByTestId("document-scroller").click({ position: { x: (box?.width ?? 800) / 2, y: 80 } });
  await expect(page.getByRole("textbox", { name: "Editable line" })).toBeFocused();
}

/** Types into the editable line and waits until the engine's text is back in it. */
async function typeIntoTheEditableLine(page: Page, text: string): Promise<void> {
  const editable = page.getByRole("textbox", { name: "Editable line" });
  await page.keyboard.type(text);
  await expect
    .poll(() =>
      editable.evaluate((element) =>
        element instanceof HTMLTextAreaElement ? element.value : (element.textContent ?? ""),
      ),
    )
    .toBe(text);
}

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

test("a tree 64 levels deep, the deepest the engine sends, gets an element of its own for every level", async ({
  page,
}) => {
  const problems = await collectProblems(page);
  await keepWorker(page);
  await page.goto("/");
  await waitForDocument(page);
  const mirror = page.getByTestId("a11y-mirror");
  const id = Number(await mirror.getByText("This is the end of the mock document.").getAttribute("data-node-id"));
  expect(id).toBeGreaterThan(0);
  // The last paragraph (level 2, below the document) becomes a chain down to level 64. The engine flattens whatever lies deeper into the
  // text of the node at level 64 (spec §14.7 item 1), so the mirror flattens nothing itself.
  await replaceWithChain(page, id, 64);
  const deepest = mirror.locator('[data-node-id="1000064"]');
  await expect(deepest).toHaveText("Level 64");
  await expect(mirror.locator(`[data-node-id="${id}"]`)).toBeAttached();
  expect(await mirrorDepth(page)).toBe(64);
  await expect(page.locator(".document-view")).toHaveAttribute("data-engine-state", "ready");
  // The app still works: the editable line still takes typing and shows the engine's text.
  await focusTheEditableLine(page);
  await typeIntoTheEditableLine(page, "ok");
  expect(await problems()).toEqual([]);
});

test("a tree deeper than 64 levels breaks the protocol: the app stops using the engine and says so", async ({
  page,
}) => {
  await keepWorker(page);
  await page.goto("/");
  await waitForDocument(page);
  const mirror = page.getByTestId("a11y-mirror");
  const id = Number(await mirror.getByText("This is the end of the mock document.").getAttribute("data-node-id"));
  // A chain of 100,000 levels: refused before anything is built, without exhausting the call stack or freezing.
  await replaceWithChain(page, id, 100_001);
  await expect(page.locator(".document-view")).toHaveAttribute("data-engine-state", "failed");
  await expect(page.locator(".document-status")).toHaveText(stopped);
  // The worker is terminated (spec §14.1 item 5), and the document is gone with the session.
  await expect.poll(() => page.workers().length).toBe(0);
  await expect(mirror.getByRole("heading")).toHaveCount(0);
  await expect(mirror.locator('[data-node-id="1000064"]')).toHaveCount(0);
});

test("a node with more children than one message holds is mirrored in full, its parts loaded without moving focus", async ({
  page,
}) => {
  const problems = await collectProblems(page);
  // 2,500 paragraphs after the mock document's own, at most 1,000 to a message (a11y-parts.ts).
  await standInForParts(page, { extra: 2_500, perMessage: 1_000 });
  await page.goto("/");
  await waitForDocument(page);
  const mirror = page.getByTestId("a11y-mirror");
  // The first message held the mock document's children and the first 1,000 added ones.
  await expect(mirror.locator(`[data-node-id="${partId(999)}"]`)).toBeAttached();
  await expect(mirror.locator(`[data-node-id="${partId(1_000)}"]`)).toHaveCount(0);
  // Keyboard focus in the editable line while the parts arrive: loading them must not move it.
  await focusTheEditableLine(page);
  await releaseParts(page);
  await expect(mirror.locator(`[data-node-id="${partId(2_499)}"]`)).toBeAttached();
  // Every child once, in order: the mock document's own, then the added ones.
  const ids = await mirror
    .locator('[role="document"]')
    .evaluate((document) => [...document.children].map((child) => Number((child as HTMLElement).dataset["nodeId"])));
  const own = ids.length - 2_500;
  expect(own).toBeGreaterThan(10);
  expect(ids.slice(own)).toEqual(Array.from({ length: 2_500 }, (_, index) => 9_000_000 + index));
  expect(new Set(ids).size).toBe(ids.length);
  await expect(mirror.getByText("Added paragraph 2499")).toBeAttached();
  // Two parts, each asked for as the whole gap that remained (spec §14.7 item 1), each holding 1,000 and then 500.
  expect(await partQueries(page)).toEqual([
    { start: own + 1_000, count: 1_500 },
    { start: own + 2_000, count: 500 },
  ]);
  await expect(page.getByRole("textbox", { name: "Editable line" })).toBeFocused();
  await typeIntoTheEditableLine(page, "ok");
  expect(await problems()).toEqual([]);
});

test("a part without the child its range starts with breaks the protocol, and the app stops instead of asking again", async ({
  page,
}) => {
  await standInForParts(page, { extra: 2_500, perMessage: 1_000, withoutStart: true });
  await page.goto("/");
  await waitForDocument(page);
  await releaseParts(page);
  await expect(page.locator(".document-view")).toHaveAttribute("data-engine-state", "failed");
  await expect(page.locator(".document-status")).toHaveText(stopped);
  await page.waitForTimeout(500);
  expect(await partQueries(page)).toHaveLength(1);
});

test("a part that the engine refuses is not asked for again, also after updates, and the rest of the document stays", async ({
  page,
}) => {
  const problems = await collectProblems(page);
  await keepWorker(page);
  await standInForParts(page, { extra: 2_500, perMessage: 1_000, refuse: true });
  await page.goto("/");
  await waitForDocument(page);
  const mirror = page.getByTestId("a11y-mirror");
  const last = Number(await mirror.getByText("This is the end of the mock document.").getAttribute("data-node-id"));
  await releaseParts(page);
  await expect.poll(() => partQueries(page)).toHaveLength(1);
  // Updates afterwards, as typing brings, here replacing the mock document's last paragraph with itself: the node whose part the engine
  // refused leaves the queue for good, so nothing is asked for again.
  await page.evaluate((id) => {
    const scope = globalThis as unknown as { __engineWorker: Worker; __docId: number };
    for (const seq of [3_000_000, 3_000_001, 3_000_002]) {
      const node: A11yNode = { id, role: "paragraph", text: "This is the end of the mock document." };
      const payload: A11yUpdate = { doc_id: scope.__docId, changes: [{ kind: "replace", node }], caret: null };
      const message: EngineEvent<"a11y.update"> = { v: 1, type: "a11y.update", seq, payload };
      scope.__engineWorker.dispatchEvent(new MessageEvent("message", { data: message }));
    }
  }, last);
  await page.waitForTimeout(500);
  expect(await partQueries(page)).toHaveLength(1);
  // The children the first message held stay; a refused part is no violation, and the app keeps running.
  await expect(mirror.locator(`[data-node-id="${partId(999)}"]`)).toBeAttached();
  await expect(mirror.locator(`[data-node-id="${partId(1_000)}"]`)).toHaveCount(0);
  await expect(page.locator(".document-view")).toHaveAttribute("data-engine-state", "ready");
  expect(await problems()).toEqual([]);
});

test("a part of 199,999 children, as many as one message holds, is mirrored in full, and loading then stops", async ({
  page,
}) => {
  // Mirroring the part's 199,999 elements takes the browser most of this test's time: on CI's macOS 26 Intel runner the test waited
  // 19.5 to 24.2 s of its 30 s for the last of them (bayan-web#25), and Playwright's trace snapshot of the 200,000 elements after the
  // next action took 2 to 3 s more, so this test gets three times its project's time limit.
  test.slow();
  const problems = await collectProblems(page);
  await keepWorker(page);
  // The reply for the whole document holds the mock document's own children only, and the one part all 199,999 added paragraphs: with
  // its node, 200,000 nodes, the most one message may hold (spec §14.7 item 1). Browsers refuse a call with that many arguments, so the
  // mirror must add them one at a time. The added paragraphs have no text, which only spares the browser's layout work.
  await standInForParts(page, { extra: 199_999, firstMessage: 0, perMessage: 199_999, withoutText: true });
  await page.goto("/");
  await waitForDocument(page);
  const mirror = page.getByTestId("a11y-mirror");
  await focusTheEditableLine(page);
  // Everything the test needs to find is found before the part arrives. Once the page holds 200,000 more elements, every Playwright action
  // takes a snapshot of them for the trace, so the rest happens in two actions, in the page.
  const editable = await page.getByRole("textbox", { name: "Editable line" }).getAttribute("data-node-id");
  const last = await mirror.getByText("This is the end of the mock document.").getAttribute("data-node-id");
  await releaseParts(page);
  await page.waitForFunction((id) => document.querySelector(`[data-node-id="${id}"]`) !== null, partId(199_998));
  const result = await page.evaluate(
    ({ editable, last }) => {
      const scope = globalThis as unknown as {
        __engineWorker: Worker;
        __docId: number;
        __partQueries: { start: number; count: number }[];
      };
      // Every child once, in order, the added ones after the mock document's own.
      const own = new Set<number>();
      let added = 0;
      let inOrder = true;
      for (const child of document.querySelector('[data-testid="a11y-mirror"] [role="document"]')?.children ?? []) {
        const id = Number(child.getAttribute("data-node-id"));
        if (id < 9_000_000) {
          if (added > 0 || own.has(id)) inOrder = false;
          own.add(id);
        } else {
          if (id !== 9_000_000 + added) inOrder = false;
          added += 1;
        }
      }
      const queriesForThePart = scope.__partQueries.slice();
      // An update after the part, as typing brings, here replacing the mock document's last paragraph with itself. The mirror applies it
      // while its event is dispatched, and with all its node's children held it asks for no part again.
      const node: A11yNode = { id: Number(last), role: "paragraph", text: "This is the end of the mock document." };
      const payload: A11yUpdate = { doc_id: scope.__docId, changes: [{ kind: "replace", node }], caret: null };
      const message: EngineEvent<"a11y.update"> = { v: 1, type: "a11y.update", seq: 3_000_000, payload };
      scope.__engineWorker.dispatchEvent(new MessageEvent("message", { data: message }));
      return {
        own: own.size,
        added,
        inOrder,
        queriesForThePart,
        queriesAfterTheUpdate: scope.__partQueries.length,
        replaced: document.querySelector(`[data-node-id="${last}"]`)?.textContent ?? null,
        // Keyboard focus stayed in the editable line while the part arrived.
        focused: document.activeElement?.getAttribute("data-node-id") === editable,
        engine: document.querySelector(".document-view")?.getAttribute("data-engine-state") ?? null,
      };
    },
    { editable, last },
  );
  expect(result).toEqual({
    own: result.own,
    added: 199_999,
    inOrder: true,
    queriesForThePart: [{ start: result.own, count: 199_999 }],
    queriesAfterTheUpdate: 1,
    replaced: "This is the end of the mock document.",
    focused: true,
    engine: "ready",
  });
  expect(result.own).toBeGreaterThan(10);
  expect(await problems()).toEqual([]);
});

test("an update that replaces a node holding 150,001 children forgets them all and keeps the app running", async ({
  page,
}) => {
  const problems = await collectProblems(page);
  await keepWorker(page);
  await page.goto("/");
  await waitForDocument(page);
  const documentId = Number(
    await page.getByTestId("a11y-mirror").locator('[role="document"]').getAttribute("data-node-id"),
  );
  // Two updates as the engine would send them, built and checked in the page, in one action (each action with 150,000 more elements
  // would take a snapshot of them for the trace): the first gives the document node 150,001 paragraphs (150,002 nodes, within one
  // message's 200,000), the second replaces it with a single paragraph, which forgets all of them. Browsers refuse a call with that many
  // arguments, so the mirror must walk them one at a time. The mirror applies an update while its event is dispatched.
  const result = await page.evaluate((documentId) => {
    const scope = globalThis as unknown as { __engineWorker: Worker; __docId: number };
    const replaceDocument = (seq: number, paragraphs: number, firstId: number) => {
      const node: A11yNode = {
        id: documentId,
        role: "document",
        children: Array.from(
          { length: paragraphs },
          (_, index): A11yNode => ({ id: firstId + index, role: "paragraph" }),
        ),
      };
      const payload: A11yUpdate = { doc_id: scope.__docId, changes: [{ kind: "replace", node }], caret: null };
      const message: EngineEvent<"a11y.update"> = { v: 1, type: "a11y.update", seq, payload };
      scope.__engineWorker.dispatchEvent(new MessageEvent("message", { data: message }));
    };
    const held = (id: number) => document.querySelector(`[data-testid="a11y-mirror"] [data-node-id="${id}"]`) !== null;
    replaceDocument(3_000_001, 150_001, 5_000_000);
    const afterFirst = { first: held(5_000_000), last: held(5_150_000) };
    replaceDocument(3_000_002, 1, 6_000_000);
    return {
      afterFirst,
      afterSecond: { replacement: held(6_000_000), first: held(5_000_000), last: held(5_150_000) },
      engine: document.querySelector(".document-view")?.getAttribute("data-engine-state") ?? null,
    };
  }, documentId);
  expect(result).toEqual({
    afterFirst: { first: true, last: true },
    afterSecond: { replacement: true, first: false, last: false },
    engine: "ready",
  });
  await expect(page.locator(".document-view")).toHaveAttribute("data-engine-state", "ready");
  expect(await problems()).toEqual([]);
});

/**
 * Times the mirror's work on a11y.updates that the test hands the app as the engine would send them, and returns how long the mirror took
 * for each timed update, in milliseconds, one list for each of `sizes`: the mirror applies an update synchronously while its event is
 * dispatched. Every update replaces the last paragraph (level 2) or nodes below it. Each round times one update of each size in turn, so
 * that a machine that is busy for a while slows all sizes alike. `forget`: for each size n, a chain down to level 62 whose node there has n
 * children on level 63, each with one node below it on level 64, the deepest the engine sends, is built untimed, and then replacing that
 * chain with a single paragraph is timed, which forgets all of them. `change`: for each size n, a chain down to a node on level 63 with n
 * nodes below it on level 64 is built untimed, and then one update that changes 400 of those nodes is timed.
 */
async function timeUpdates(
  page: Page,
  paragraph: number,
  kind: "forget" | "change",
  sizes: readonly number[],
  rounds: number,
): Promise<number[][]> {
  return page.evaluate(
    ({ paragraph, kind, sizes, rounds }) => {
      const chainDownTo = (deepest: A11yNode, level: number): A11yNode => {
        let node = deepest;
        for (let above = level - 1; above >= 2; above -= 1) {
          node = { id: above === 2 ? paragraph : 3_000_000 + above, role: "paragraph", children: [node] };
        }
        return node;
      };
      const scope = globalThis as unknown as { __engineWorker: Worker; __docId: number };
      let seq = 2_000_000;
      const apply = (changes: A11yChange[]): number => {
        seq += 1;
        const payload: A11yUpdate = { doc_id: scope.__docId, changes, caret: null };
        const message: EngineEvent<"a11y.update"> = { v: 1, type: "a11y.update", seq, payload };
        const event = new MessageEvent("message", { data: message });
        const start = performance.now();
        scope.__engineWorker.dispatchEvent(event);
        return Math.round((performance.now() - start) * 10) / 10;
      };
      const times = sizes.map((): number[] => []);
      for (let round = 1; round <= rounds; round += 1) {
        for (const [size, n] of sizes.entries()) {
          if (kind === "forget") {
            const parent: A11yNode = { id: 3_000_062, role: "paragraph", children: [] };
            for (let i = 0; i < n; i += 1) {
              const below: A11yNode = { id: 5_000_000 + i, role: "paragraph", text: `Below ${i}` };
              parent.children?.push({ id: 4_000_000 + i, role: "paragraph", text: `Owner ${i}`, children: [below] });
            }
            apply([{ kind: "replace", node: chainDownTo(parent, 62) }]);
            // Without the tree in place, the timed update would have nothing to forget.
            if (document.querySelector(`[data-node-id="${5_000_000 + n - 1}"]`) === null)
              throw new Error("The tree to forget is not in place.");
            const paragraphAgain: A11yNode = { id: paragraph, role: "paragraph", text: `Replaced in round ${round}` };
            times[size]?.push(apply([{ kind: "replace", node: paragraphAgain }]));
          } else {
            const owner: A11yNode = { id: 6_000_000, role: "paragraph", text: "Owner", children: [] };
            for (let i = 0; i < n; i += 1)
              owner.children?.push({ id: 7_000_000 + i, role: "paragraph", text: `Line ${i}` });
            apply([{ kind: "replace", node: chainDownTo(owner, 63) }]);
            const step = Math.floor(n / 400);
            const changes = Array.from(
              { length: 400 },
              (_, i): A11yChange => ({
                kind: "replace",
                node: { id: 7_000_000 + i * step, role: "paragraph", text: `Changed ${i * step} in round ${round}` },
              }),
            );
            times[size]?.push(apply(changes));
          }
        }
      }
      return times;
    },
    { paragraph, kind, sizes, rounds },
  );
}

test("updates take time in proportion to what they change, not to the tree around it", async ({ page }) => {
  // Most of this test's time goes into building, untimed, the trees that each timed round forgets or changes. Five interleaved rounds are
  // what keep each side's fastest round reliable, and a slow runner needs most of the default time limit for them, so this test gets three
  // times its project's limit.
  test.slow();
  const problems = await collectProblems(page);
  await keepWorker(page);
  await page.goto("/");
  await waitForDocument(page);
  const mirror = page.getByTestId("a11y-mirror");
  const id = Number(await mirror.getByText("This is the end of the mock document.").getAttribute("data-node-id"));
  expect(id).toBeGreaterThan(0);
  // Only ratios are compared, never times, so that a slow machine slows both sides alike. Each side is its fastest round, so that a pause
  // for garbage collection or for another program in a round does not count. And the smaller side counts as at least 2 ms: a busy machine
  // can leave a task of a millisecond untouched while it slows a longer one, so a smaller side of a fraction of a millisecond would make
  // the ratio depend on how busy the machine is.
  const ratio = (larger: number[] = [], smaller: number[] = []) =>
    Math.min(...larger) / Math.max(Math.min(...smaller), 2);
  // Replacing the ancestor of many nodes forgets them all, and the nodes below them. Twenty times as many nodes take about twenty times as
  // long, and the ratio must stay below 80; forgetting each node by searching the others would put it in the hundreds.
  const [small = [], large = []] = await timeUpdates(page, id, "forget", [1_000, 20_000], 5);
  await expect(mirror.locator(`[data-node-id="${id}"]`)).toHaveText("Replaced in round 5");
  await expect(mirror.locator('[data-node-id="4000000"]')).toHaveCount(0);
  expect(
    ratio(large, small),
    `forgetting 1,000 nodes took ${small.join(" / ")} ms, 20,000 took ${large.join(" / ")} ms`,
  ).toBeLessThan(80);
  // 400 changes of nodes among 20,000 siblings take about as long as 400 among 400: a change finds its node's place among its siblings by
  // binary search, never by looking at all of them, which would make the first side fifty times slower.
  const [few = [], many = []] = await timeUpdates(page, id, "change", [400, 20_000], 3);
  expect(ratio(many, few), `among 400: ${few.join(" / ")} ms, among 20,000: ${many.join(" / ")} ms`).toBeLessThan(8);
  // And the changes are there, each in its place among the lines.
  const owner = mirror.locator('[data-node-id="6000000"]');
  await expect(owner.locator("> p").nth(0)).toHaveText("Changed 0 in round 3");
  await expect(owner.locator("> p").nth(50)).toHaveText("Changed 50 in round 3");
  await expect(owner.locator("> p").nth(51)).toHaveText("Line 51");
  await expect(owner.locator("> p")).toHaveCount(20_000);
  expect(await problems()).toEqual([]);
});
