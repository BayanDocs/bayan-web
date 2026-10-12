import { expect, type Page, test } from "@playwright/test";
import { collectProblems } from "./collect-problems.ts";
import { mockColours, pageBox, waitForDocument, waitForTiles } from "./document.ts";

// WEB-002 AC-2 and the input bridge: typing, keys, shortcuts and the clipboard reach the engine through both bridge implementations,
// and Japanese, Chinese and Korean composition reaches it through EditContext and through the hidden element.
//
// Evidence of three kinds: the input messages the app sent to the worker (recorded by wrapping Worker.prototype.postMessage before the
// app starts), the engine's answer (the editable text it sends back, which the bridge's element shows), and the engine's pixels (the
// mock document draws composition text as blue boxes and committed text as dark boxes in its editable line).

interface SentInput {
  type: string;
  phase?: string;
  text?: string;
  key?: string;
  ctrl?: boolean;
  meta?: boolean;
}

/** Records the input messages the app sends to the engine's worker. */
async function recordInput(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const sent: SentInput[] = [];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, transfer?: Transferable[]) {
      const envelope = message as { type?: unknown; payload?: Record<string, unknown> };
      if (
        typeof envelope.type === "string" &&
        envelope.type.startsWith("input.") &&
        envelope.type !== "input.pointer"
      ) {
        const payload = envelope.payload ?? {};
        const modifiers = payload["modifiers"] as { ctrl?: boolean; meta?: boolean } | undefined;
        sent.push({
          type: envelope.type,
          ...(typeof payload["phase"] === "string" ? { phase: payload["phase"] } : {}),
          ...(typeof payload["text"] === "string" ? { text: payload["text"] } : {}),
          ...(typeof payload["key"] === "string" ? { key: payload["key"] } : {}),
          ...(modifiers?.ctrl ? { ctrl: true } : {}),
          ...(modifiers?.meta ? { meta: true } : {}),
        });
      }
      return Reflect.apply(post, this, [message, transfer]);
    } as typeof Worker.prototype.postMessage;
    Object.assign(globalThis, { __sentInput: sent });
  });
}

async function sentInput(page: Page): Promise<SentInput[]> {
  return page.evaluate(() => (globalThis as unknown as { __sentInput: SentInput[] }).__sentInput.slice());
}

const bridge = (page: Page) => page.locator(".input-bridge");

/** The engine's editable text as the input bridge shows it (the text area's value, or the EditContext element's text). */
async function engineText(page: Page): Promise<string> {
  return bridge(page).evaluate((element) =>
    element instanceof HTMLTextAreaElement ? element.value : (element.textContent ?? ""),
  );
}

/** The caret as the bridge holds it, for screen readers: the text area's selection, or the DOM selection in the EditContext element. */
async function bridgeCaret(page: Page): Promise<number | null> {
  return bridge(page).evaluate((element) => {
    if (element instanceof HTMLTextAreaElement) return element.selectionStart;
    const selection = document.getSelection();
    return selection !== null && element.contains(selection.anchorNode) ? selection.anchorOffset : null;
  });
}

/** Opens the app, waits for the document, and gives the document keyboard focus by clicking its first page. */
async function openAndFocus(page: Page): Promise<void> {
  await page.goto("/");
  await waitForDocument(page);
  const first = await pageBox(page, 0);
  await page.getByTestId("document-scroller").click({ position: { x: first.x + first.width / 2, y: first.y + 60 } });
  await expect(bridge(page)).toBeFocused();
}

/**
 * How many device pixels of a colour the middle row of the mock document's editable line has on the tile canvas. The line is found by
 * its background colour, in a column just inside its left edge (the page's left margin is one inch, 96 CSS pixels). One evaluation, so
 * that nothing changes while it looks.
 */
async function pixelsOf(page: Page, colour: readonly number[]): Promise<number> {
  const first = await pageBox(page, 0);
  return page.getByTestId("document-tiles").evaluate(
    (canvas: HTMLCanvasElement, [pageX, pageY, r, g, b, fillR, fillG, fillB]) => {
      const context = canvas.getContext("2d");
      const ratio = window.devicePixelRatio;
      if (context === null) return -1;
      const x = Math.round(((pageX ?? 0) + 100) * ratio);
      const top = Math.max(0, Math.round((pageY ?? 0) * ratio));
      const column = context.getImageData(x, top, 1, Math.round(600 * ratio)).data;
      const rows: number[] = [];
      for (let y = 0; y * 4 < column.length; y += 1) {
        if (column[y * 4] === fillR && column[y * 4 + 1] === fillG && column[y * 4 + 2] === fillB) rows.push(top + y);
      }
      const middle = rows.length === 0 ? -1 : Math.round(((rows[0] ?? 0) + (rows.at(-1) ?? 0)) / 2);
      if (middle < 0) return -1;
      const row = context.getImageData(x, middle, Math.round(600 * ratio), 1).data;
      let count = 0;
      for (let index = 0; index < row.length; index += 4) {
        if (row[index] === r && row[index + 1] === g && row[index + 2] === b && row[index + 3] === 255) count += 1;
      }
      return count;
    },
    [first.x, first.y, colour[0] ?? 0, colour[1] ?? 0, colour[2] ?? 0, ...mockColours.editableFill.slice(0, 3)],
  );
}

test("typing, deleting and moving the caret reach the engine, and the bridge follows its caret", async ({ page }) => {
  const problems = await collectProblems(page);
  await recordInput(page);
  await openAndFocus(page);
  // The engine does proofing (ADR-0022): the browser's spell checker, which can send text to a web service, stays off.
  await expect(bridge(page)).toHaveAttribute("spellcheck", "false");
  await page.keyboard.type("abc");
  await expect.poll(() => engineText(page)).toBe("abc");
  await page.keyboard.press("Backspace");
  await expect.poll(() => engineText(page)).toBe("ab");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => bridgeCaret(page)).toBe(1);
  await page.keyboard.type("X");
  await expect.poll(() => engineText(page)).toBe("aXb");
  await page.keyboard.press("Home");
  await page.keyboard.type("Y");
  await expect.poll(() => engineText(page)).toBe("YaXb");
  await expect.poll(() => bridgeCaret(page)).toBe(1);
  const sent = await sentInput(page);
  expect(sent.filter((message) => message.type === "input.text").map((message) => message.text)).toEqual([
    "a",
    "b",
    "c",
    "X",
    "Y",
  ]);
  expect(sent.filter((message) => message.type === "input.key").map((message) => message.key)).toEqual([
    "Backspace",
    "ArrowLeft",
    "Home",
  ]);
  // The engine drew the four committed characters as dark boxes in its editable line.
  await waitForTiles(page);
  expect(await pixelsOf(page, mockColours.ink)).toBeGreaterThan(0);
  expect(await problems()).toEqual([]);
});

test("the UI manifest's shortcuts go to the engine; clipboard shortcuts and Tab stay with the browser", async ({
  page,
  browserName,
}) => {
  await recordInput(page);
  await openAndFocus(page);
  // The manifest's "Ctrl" is the platform's primary modifier, Command on Apple systems (src/input/keys.ts); the engine receives the
  // modifiers as pressed.
  const apple = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform));
  const primary = apple ? "Meta" : "Control";
  await page.keyboard.press(`${primary}+b`);
  await page.keyboard.press(`${primary}+c`);
  await expect
    .poll(() => sentInput(page))
    .toEqual([{ type: "input.key", key: "b", ...(apple ? { meta: true } : { ctrl: true }) }]);
  // Shift+Tab moves keyboard focus out of the editable text, to the scrollable pages around it: no keyboard trap (WCAG 2.1.2). WebKit,
  // like Safari, moves focus with Option (Alt) unless Full Keyboard Access is on.
  await page.keyboard.press(browserName === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab");
  await expect(page.getByRole("region", { name: "Pages" })).toBeFocused();
});

test("a double click reaches the engine as two presses, the second with a click count of 2", async ({ page }) => {
  // PointerEvent.detail is 0 in Chromium and Firefox, so the click count must come from the mouse events.
  await page.addInitScript(() => {
    const presses: string[] = [];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, transfer?: Transferable[]) {
      const envelope = message as {
        type?: unknown;
        payload?: { kind?: string; clicks?: number; pointer_type?: string };
      };
      if (envelope.type === "input.pointer") {
        presses.push(`${envelope.payload?.kind} ${envelope.payload?.clicks} ${envelope.payload?.pointer_type}`);
      }
      return Reflect.apply(post, this, [message, transfer]);
    } as typeof Worker.prototype.postMessage;
    Object.assign(globalThis, { __presses: presses });
  });
  await page.goto("/");
  await waitForDocument(page);
  const first = await pageBox(page, 0);
  await page.getByTestId("document-scroller").dblclick({ position: { x: first.x + first.width / 2, y: first.y + 60 } });
  await expect
    .poll(() => page.evaluate(() => (globalThis as unknown as { __presses: string[] }).__presses))
    .toEqual(["down 1 mouse", "up 1 mouse", "down 2 mouse", "up 2 mouse"]);
});

test("pasting sends the clipboard's plain text to the engine", async ({ page }) => {
  await recordInput(page);
  await openAndFocus(page);
  await bridge(page).evaluate((element) => {
    const data = new DataTransfer();
    data.setData("text/plain", "pasted");
    data.setData("text/html", "<b>never decoded by the shell</b>");
    // Firefox drops clipboardData from a ClipboardEvent a page creates, so the data is attached to the event directly.
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    element.dispatchEvent(event);
  });
  await expect.poll(() => engineText(page)).toBe("pasted");
  expect(await sentInput(page)).toEqual([{ type: "input.text", text: "pasted" }]);
});

/** Japanese (romaji to kana, then conversion), Chinese (pinyin) and Korean (two-set hangul) compositions, as input methods send them. */
const compositions = [
  { language: "Japanese", steps: ["に", "にほ", "にほん", "にほんご", "日本語"], commit: "日本語" },
  { language: "Chinese", steps: ["z", "zh", "zhong", "zhong'w", "zhong'wen"], commit: "中文" },
  { language: "Korean", steps: ["ㅎ", "하", "한"], commit: "한" },
  { language: "Korean", steps: ["ㄱ", "구", "국"], commit: "국" },
] as const;

/** Replays the events a browser fires on the hidden text area while an input method composes, for engines Playwright cannot drive. */
async function composeWithEvents(page: Page, steps: readonly string[], commit: string): Promise<void> {
  await bridge(page).evaluate(
    (element, [stepsJson, committed]) => {
      const area = element as HTMLTextAreaElement;
      const start = area.selectionStart;
      let length = 0;
      area.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }));
      for (const step of JSON.parse(stepsJson ?? "[]") as string[]) {
        area.dispatchEvent(new CompositionEvent("compositionupdate", { data: step, bubbles: true }));
        area.setRangeText(step, start, start + length, "end");
        length = step.length;
        area.dispatchEvent(
          new InputEvent("input", { inputType: "insertCompositionText", data: step, isComposing: true, bubbles: true }),
        );
      }
      // Committing replaces the composition with the committed text, as one last update, before the composition ends.
      area.dispatchEvent(new CompositionEvent("compositionupdate", { data: committed ?? "", bubbles: true }));
      area.setRangeText(committed ?? "", start, start + length, "end");
      area.dispatchEvent(
        new InputEvent("input", {
          inputType: "insertCompositionText",
          data: committed ?? "",
          isComposing: true,
          bubbles: true,
        }),
      );
      area.dispatchEvent(new CompositionEvent("compositionend", { data: committed ?? "", bubbles: true }));
    },
    [JSON.stringify(steps), commit],
  );
}

function expectedMessages(): SentInput[] {
  return compositions.flatMap(({ steps, commit }) => [
    { type: "input.composition", phase: "start", text: "" },
    ...steps.map((text) => ({ type: "input.composition", phase: "update", text })),
    // Browsers replace the composition with the committed text, as a last update, before it ends.
    { type: "input.composition", phase: "update", text: commit },
    { type: "input.composition", phase: "end", text: "" },
    { type: "input.text", text: commit },
  ]);
}

const committedText = compositions.map(({ commit }) => commit).join("");

for (const bridgeKind of ["edit-context", "hidden-element"] as const) {
  test(`Japanese, Chinese and Korean composition reach the engine through ${bridgeKind === "edit-context" ? "EditContext" : "the hidden element"} (Chromium input-method emulation)`, async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "only Chromium's DevTools protocol can emulate an input method");
    if (bridgeKind === "hidden-element") {
      // Without EditContext, the app chooses the bridge that Firefox and Safari use.
      await page.addInitScript(() => Reflect.deleteProperty(globalThis, "EditContext"));
    }
    await recordInput(page);
    await openAndFocus(page);
    await expect(page.locator(".document-view")).toHaveAttribute("data-input-bridge", bridgeKind);
    const session = await page.context().newCDPSession(page);
    for (const [index, { steps, commit }] of compositions.entries()) {
      for (const text of steps) {
        await session.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
      }
      if (index === 0) {
        // While the composition is open, the engine draws it: blue boxes in the editable line.
        await waitForTiles(page);
        await expect.poll(() => pixelsOf(page, mockColours.accent)).toBeGreaterThan(0);
      }
      await session.send("Input.insertText", { text: commit });
      await expect
        .poll(() => engineText(page))
        .toBe(
          compositions
            .slice(0, index + 1)
            .map((step) => step.commit)
            .join(""),
        );
    }
    await waitForTiles(page);
    expect(await pixelsOf(page, mockColours.accent)).toBe(0);
    expect(await pixelsOf(page, mockColours.ink)).toBeGreaterThan(0);
    expect(await sentInput(page)).toEqual(expectedMessages());
    expect(await bridgeCaret(page)).toBe(committedText.length);
  });
}

test("composition events reach the engine through the hidden element (the event sequence of Firefox and Safari)", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === "chromium",
    "Chromium uses EditContext; its hidden-element path is tested with real input-method emulation above",
  );
  await recordInput(page);
  await openAndFocus(page);
  await expect(page.locator(".document-view")).toHaveAttribute("data-input-bridge", "hidden-element");
  for (const [index, { steps, commit }] of compositions.entries()) {
    await composeWithEvents(page, steps, commit);
    await expect
      .poll(() => engineText(page))
      .toBe(
        compositions
          .slice(0, index + 1)
          .map((step) => step.commit)
          .join(""),
      );
  }
  expect(await sentInput(page)).toEqual(expectedMessages());
  await waitForTiles(page);
  expect(await pixelsOf(page, mockColours.ink)).toBeGreaterThan(0);
});
