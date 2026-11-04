import { expect, type Page, test } from "@playwright/test";
import { collectProblems } from "./collect-problems.ts";

// The recovery policy of engine protocol §12.1, against the real engine: after an unrecoverable engine.error the app starts a new session at
// most three times in ten minutes (src/engine/recovery.ts; tests/unit/recovery.test.ts checks the ten minutes), says so each time in its
// status live region, which screen readers announce, never reopens the document unless the user asks, keeps keyboard focus in the
// document area, also when the offer to reopen goes while its button has focus, and at the fourth failure stops.
//
// The engine panics on diag.panic only when its configuration's test switch test.allow_panic is on (spec §3.3, §6.7), which the app never
// turns on. Before the app starts, these tests wrap Worker.prototype.postMessage: the wrapper adds the switch to the worker host's init
// message, records the type of every message the app sends, keeps the worker so that a test can send diag.panic itself, and can turn the
// app's own requests of one type (from the start, or from a point the test chooses) into diag.panic with the same id, so that the engine
// fails while handling them and answers the app's request with the error panic, as a document that makes the engine panic when it opens
// would.

interface Traffic {
  /** The type of every protocol message sent to the worker, in order, as the app sent it, and the test's own diag.panic. */
  readonly sent: string[];
  /** How many welcome replies (successful handshakes) and unrecoverable engine.error events arrived. */
  readonly welcomes: number;
  readonly failures: number;
  /** Every text the status line has shown, in order, also those that lasted only a moment. */
  readonly statuses: string[];
}

/** Which of the app's requests the engine fails on: the first `times` of type `type`, or every one if `times` is null. */
interface Failing {
  readonly type: string;
  readonly times: number | null;
}

async function enablePanics(page: Page, failing: Failing | null = null): Promise<void> {
  await page.addInitScript((fail) => {
    const traffic = { sent: [] as string[], welcomes: 0, failures: 0, statuses: [] as string[] };
    let engineWorker: Worker | undefined;
    let failed = 0;
    /** The type of the app's next request that the engine is to fail on, set by failNext(). */
    let failNext: string | null = null;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, transfer?: Transferable[]) {
      const envelope = message as { worker?: unknown; type?: unknown; id?: unknown } | null;
      if (envelope?.worker === "init") {
        engineWorker = this;
        this.addEventListener("message", (event: MessageEvent<unknown>) => {
          const data = event.data as { type?: unknown; payload?: { recoverable?: unknown } } | null;
          if (data?.type === "welcome") traffic.welcomes += 1;
          if (data?.type === "engine.error" && data.payload?.recoverable === false) traffic.failures += 1;
        });
        return Reflect.apply(post, this, [{ ...envelope, config: { test: { allow_panic: true } } }, transfer]);
      }
      if (typeof envelope?.type === "string") traffic.sent.push(envelope.type);
      const next = failNext !== null && envelope?.type === failNext;
      if (next) failNext = null;
      if (next || (fail !== null && envelope?.type === fail.type && (fail.times === null || failed < fail.times))) {
        if (!next) failed += 1;
        // The same id, so that the engine's error panic answers the app's own request; the transfer list still moves any blob.
        return Reflect.apply(post, this, [{ v: 0, id: envelope.id, type: "diag.panic" }, transfer]);
      }
      return Reflect.apply(post, this, [message, transfer]);
    } as typeof Worker.prototype.postMessage;
    new MutationObserver(() => {
      const text = document.querySelector(".document-status")?.textContent ?? null;
      if (text !== null && text !== "" && traffic.statuses.at(-1) !== text) traffic.statuses.push(text);
    }).observe(document, { subtree: true, childList: true, characterData: true });
    Object.assign(globalThis, {
      __traffic: traffic,
      // Without an id, so the app's requests and their identifiers are untouched; the engine answers with engine.error only.
      __panic: () => engineWorker?.postMessage({ v: 0, type: "diag.panic" }),
      __failNext: (type: string) => {
        failNext = type;
      },
    });
  }, failing);
}

async function traffic(page: Page): Promise<Traffic> {
  return page.evaluate(() => {
    const { sent, welcomes, failures, statuses } = (globalThis as unknown as { __traffic: Traffic }).__traffic;
    return { sent: sent.slice(), welcomes, failures, statuses: statuses.slice() };
  });
}

/** Makes the real engine panic, and returns how many messages had been sent before. */
async function panic(page: Page): Promise<number> {
  const before = (await traffic(page)).sent.length;
  await page.evaluate(() => (globalThis as unknown as { __panic: () => void }).__panic());
  return before;
}

/**
 * Makes the engine fail on the app's next request of type `type`, which goes to the engine as diag.panic with the same id (see
 * enablePanics): the engine fails while it handles exactly that request, whatever the timing.
 */
async function failNext(page: Page, type: string): Promise<void> {
  await page.evaluate(
    (next) => (globalThis as unknown as { __failNext: (type: string) => void }).__failNext(next),
    type,
  );
}

/**
 * Makes the worker host unable to replace the engine after its next panic, so that the host itself reports
 * { worker: "failed", reason: "restart_failed" } (spec §3.2) and the app stops (§12.1, point 1). The host's restart() creates the new
 * instance through the glue's __wbg_reset_state(), which calls new WebAssembly.Instance(); the test replaces that constructor, inside the
 * engine's worker only, with one that throws. The engine package's files are served unchanged.
 */
async function breakEngineRestarts(page: Page): Promise<void> {
  const engine = page.workers().find((worker) => worker.url().includes("bayan-worker.js"));
  if (engine === undefined) throw new Error("The engine's worker is not running.");
  await engine.evaluate(() => {
    WebAssembly.Instance = class {
      constructor() {
        throw new Error("A test made the engine's replacement fail.");
      }
    } as unknown as typeof WebAssembly.Instance;
  });
}

/** The types of the messages sent since `before` messages had been sent. */
async function sentSince(page: Page, before: number): Promise<string[]> {
  return (await traffic(page)).sent.slice(before);
}

/** Long enough for the app to have sent anything it was going to send after the last answer: it has no timer of its own but view.set's. */
const quietMs = 1_000;

const restarted = (restart: number, document: string) =>
  `The engine stopped working and was restarted (${restart} of 3). ${document}`;
const closed = "The document was closed and can be reopened.";
const stillClosed = "The document is still closed and can be reopened.";
const notOpened = "The document can be opened now.";
const stopped = "The engine stopped working again, so it was not restarted. Reload the page to start it again.";
const workerStopped = "The engine stopped. Reload the page to start it again.";
const couldNotOpen = "The document could not be opened.";

/** The elements the tests look at. */
function view(page: Page) {
  return {
    state: page.locator(".document-view"),
    status: page.locator(".document-status"),
    reopen: page.getByRole("button", { name: "Reopen the document" }),
    open: page.getByRole("button", { name: "Open the document" }),
    heading: page.getByTestId("a11y-mirror").getByRole("heading", { level: 1 }),
    pages: page.getByRole("region", { name: "Pages" }),
    editable: page.getByRole("textbox", { name: "Editable line" }),
    bridge: page.locator(".input-bridge"),
  };
}

/** Puts keyboard focus in the editable line, by a click on it, as a user typing in the document has it. */
async function focusTheDocument(page: Page): Promise<void> {
  const scroller = page.getByTestId("document-scroller");
  const box = await scroller.boundingBox();
  await scroller.click({ position: { x: (box?.width ?? 800) / 2, y: 80 } });
  await expect(view(page).editable).toBeFocused();
}

/**
 * Moves keyboard focus from the "Pages" region to the offer, the control just before it, as a keyboard user would: with Shift+Tab, or in
 * WebKit, which like Safari skips buttons on plain Tab unless Full Keyboard Access is on, with Alt+Shift+Tab (see tests/e2e/smoke.spec.ts).
 */
async function focusTheOffer(page: Page, browserName: string): Promise<void> {
  const { pages, reopen } = view(page);
  await expect(pages).toBeFocused();
  await page.keyboard.press(browserName === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab");
  await expect(reopen).toBeFocused();
  // Focus that came from the keyboard is shown (ADR-0020 decision 5).
  await expect(reopen).toHaveAttribute("data-focus-visible", "true");
}

/**
 * Checks that the "Pages" region has keyboard focus and shows it: its focus ring is drawn (a style other than none, a width above 0, a colour
 * that is not transparent) and lies inside its own box, inward of its edge by at least its width, where the stage's overflow: hidden cannot
 * cut it off (src/styles.css). The browsers' default ring lies outside the box, and Firefox and WebKit then show none.
 */
async function expectVisibleFocusOnThePages(page: Page): Promise<void> {
  const { pages } = view(page);
  await expect(pages).toBeFocused();
  const ring = await pages.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      focusVisible: element.matches(":focus-visible"),
      style: style.outlineStyle,
      width: Number.parseFloat(style.outlineWidth),
      offset: Number.parseFloat(style.outlineOffset),
      color: style.outlineColor,
    };
  });
  expect(ring.focusVisible).toBe(true);
  expect(ring.style).not.toBe("none");
  expect(ring.width).toBeGreaterThan(0);
  expect(ring.offset).toBeLessThanOrEqual(-ring.width);
  expect(ring.color).not.toMatch(/^transparent$|^rgba\(.*,\s*0\)$/);
}

/**
 * While no document is open, the bridge's element is inert, so the browser leaves it out of the tab order and the accessibility tree: no
 * text box without a name. Playwright's role queries do not look at inert, so the test checks that the element refuses focus.
 */
async function expectNoTextBox(page: Page): Promise<void> {
  const bridge = view(page).bridge;
  await expect(bridge).toHaveJSProperty("inert", true);
  const focusable = await bridge.evaluate((element) => {
    const before = document.activeElement;
    (element as HTMLElement).focus();
    const focused = document.activeElement === element;
    if (before instanceof HTMLElement) before.focus();
    return focused;
  });
  expect(focusable).toBe(false);
}

test("the app restarts the engine three times after failures, says so each time, reopens only when asked, then stops", async ({
  page,
}) => {
  const problems = await collectProblems(page);
  await enablePanics(page);
  await page.goto("/");
  const { state, status, reopen, heading, pages, editable } = view(page);
  await expect(state).toHaveAttribute("data-engine-state", "ready", { timeout: 30_000 });
  await expect(heading).toBeAttached({ timeout: 30_000 });
  // The messages are in a live region, which screen readers announce wherever focus is.
  await expect(status).toHaveAttribute("role", "status");
  await expect(reopen).toHaveCount(0);
  expect((await traffic(page)).welcomes).toBe(1);
  await focusTheDocument(page);

  for (const restart of [1, 2, 3]) {
    const before = await panic(page);
    await expect(status).toHaveText(restarted(restart, closed));
    // Keyboard focus stays in the document area, not on the page and not on the offer, and the closed document leaves no text box.
    await expect(pages).toBeFocused();
    await expectNoTextBox(page);
    // A new session (hello, answered with welcome), without the document: the mirror is empty and no doc.open was sent, not even after
    // keys the user meant for the document.
    await expect.poll(async () => (await traffic(page)).welcomes).toBe(restart + 1);
    await expect(heading).toHaveCount(0);
    await expect(page.getByTestId("a11y-mirror")).not.toContainText("BayanDocs");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    await page.waitForTimeout(quietMs);
    const restartedSession = await sentSince(page, before);
    expect(restartedSession).toContain("hello");
    expect(restartedSession).not.toContain("doc.open");
    await expect(reopen).toBeVisible();
    expect((await traffic(page)).failures).toBe(restart);
    // Only when the user asks.
    await reopen.click();
    await expect(heading).toBeAttached({ timeout: 30_000 });
    await expect(status).toHaveText("The document was reopened.");
    await expect(reopen).toHaveCount(0);
    // The pressed button is gone; keyboard focus is in the document, not lost.
    await expect(editable).toBeFocused();
    expect(await sentSince(page, before)).toContain("doc.open");
  }

  // The fourth failure within ten minutes: no new session, and the app says so; the offer goes, and focus stays in the document area.
  const before = await panic(page);
  await expect(status).toHaveText(stopped);
  await expect(state).toHaveAttribute("data-engine-state", "failed");
  await expect(heading).toHaveCount(0);
  await expect(reopen).toHaveCount(0);
  await expect(pages).toBeFocused();
  await expectNoTextBox(page);
  // Tiles of the reopened document may have been requested before the failure arrived; nothing at all is sent after it.
  const stoppedSession = await sentSince(page, before);
  expect(stoppedSession).not.toContain("hello");
  expect(stoppedSession).not.toContain("doc.open");
  await page.waitForTimeout(quietMs);
  expect(await sentSince(page, before)).toEqual(stoppedSession);
  const last = await traffic(page);
  expect(last.failures).toBe(4);
  expect(last.welcomes).toBe(4);
  expect(last.statuses).not.toContain(couldNotOpen);
  expect(await problems()).toEqual([]);
});

test("a failure while the document opens restarts without reopening it", async ({ page }) => {
  const problems = await collectProblems(page);
  await enablePanics(page);
  await page.goto("/");
  const { status, reopen, heading } = view(page);
  await expect(heading).toBeAttached({ timeout: 30_000 });
  // diag.panic queued right behind the app's doc.open: the engine fails while the reopened document is still on its way in.
  await panic(page);
  await reopen.click();
  const before = await panic(page);
  await expect(status).toHaveText(restarted(2, closed));
  await expect(reopen).toBeVisible();
  await page.waitForTimeout(quietMs);
  await expect(heading).toHaveCount(0);
  expect(await sentSince(page, before)).not.toContain("doc.open");
  expect(await problems()).toEqual([]);
});

test("the offer to reopen stays through further failures and goes at the stop", async ({ page }) => {
  const problems = await collectProblems(page);
  await enablePanics(page);
  await page.goto("/");
  const { state, status, reopen, heading } = view(page);
  await expect(heading).toBeAttached({ timeout: 30_000 });
  const before = await panic(page);
  await expect(status).toHaveText(restarted(1, closed));
  // Failures while the document is closed: it is still closed, and the offer stays.
  for (const restart of [2, 3]) {
    await expect.poll(async () => (await traffic(page)).welcomes).toBe(restart);
    await panic(page);
    await expect(status).toHaveText(restarted(restart, stillClosed));
    await expect(reopen).toBeVisible();
  }
  await panic(page);
  await expect(status).toHaveText(stopped);
  await expect(state).toHaveAttribute("data-engine-state", "failed");
  await expect(reopen).toHaveCount(0);
  await expectNoTextBox(page);
  expect(await sentSince(page, before)).not.toContain("doc.open");
  expect(await problems()).toEqual([]);
});

test("a failure before the document was ever open offers to open it, and says so", async ({ page }) => {
  const problems = await collectProblems(page);
  // The engine fails on the app's first ui.manifest, which comes after hello and before doc.open.
  await enablePanics(page, { type: "ui.manifest", times: 1 });
  await page.goto("/");
  const { status, reopen, open, heading, editable } = view(page);
  await expect(status).toHaveText(restarted(1, notOpened), { timeout: 30_000 });
  await expect(open).toBeVisible();
  await expect(reopen).toHaveCount(0);
  await expectNoTextBox(page);
  await page.waitForTimeout(quietMs);
  expect((await traffic(page)).sent).not.toContain("doc.open");
  await open.click();
  await expect(heading).toBeAttached({ timeout: 30_000 });
  await expect(status).toHaveText("The document was opened.");
  await expect(editable).toBeFocused();
  expect((await traffic(page)).statuses).not.toContain(couldNotOpen);
  expect(await problems()).toEqual([]);
});

test("a document that makes the engine fail whenever it opens is opened once and reopened three times, then the app stops", async ({
  page,
}) => {
  const problems = await collectProblems(page);
  // M6's own case: the engine fails on every doc.open, and the app's own request is answered with the error panic.
  await enablePanics(page, { type: "doc.open", times: null });
  await page.goto("/");
  const { state, status, reopen, heading } = view(page);
  for (const restart of [1, 2, 3]) {
    await expect(status).toHaveText(restarted(restart, closed), { timeout: 30_000 });
    await expect(reopen).toBeVisible();
    // Each reopening is the user's, and counts as one more restart when it fails too.
    await reopen.click();
  }
  await expect(status).toHaveText(stopped);
  await expect(state).toHaveAttribute("data-engine-state", "failed");
  await expect(reopen).toHaveCount(0);
  await expect(heading).toHaveCount(0);
  await page.waitForTimeout(quietMs);
  const { sent, welcomes, failures, statuses } = await traffic(page);
  // The first open and three reopenings, one session for each, and four failures; nothing after the stop.
  expect(sent.filter((type) => type === "doc.open")).toHaveLength(4);
  expect(sent.filter((type) => type === "hello")).toHaveLength(4);
  expect(welcomes).toBe(4);
  expect(failures).toBe(4);
  expect(sent.at(-1)).toBe("doc.open");
  // Every failure was announced as a restart or the stop, in order, and never as a document that could not be opened.
  expect(statuses).not.toContain(couldNotOpen);
  const announced = statuses.filter((text) => text.startsWith("The engine stopped working"));
  expect(announced).toEqual([restarted(1, closed), restarted(2, closed), restarted(3, closed), stopped]);
  expect(await problems()).toEqual([]);
});

// The offer's button disappears with the offer. If it had keyboard focus, the browser would move focus to the page itself (<body>), which
// leaves a keyboard user nowhere; the app moves it to the document area, the "Pages" region, first, and the region shows it (ADR-0020
// decision 5). The next three tests cover each way the offer goes while its button has focus: the stop, the worker's failure, and the user
// taking the offer; the fourth checks that focus anywhere else stays where it is.

test('keyboard focus on the offer goes to the "Pages" region, not to the page, when the offer goes at the stop', async ({
  page,
  browserName,
}) => {
  const problems = await collectProblems(page);
  await enablePanics(page);
  await page.goto("/");
  const { state, status, reopen, heading } = view(page);
  await expect(heading).toBeAttached({ timeout: 30_000 });
  await focusTheDocument(page);
  await panic(page);
  await expect(status).toHaveText(restarted(1, closed));
  await focusTheOffer(page, browserName);
  // Failures while the offer has keyboard focus: the offer stays, and so does focus.
  for (const restart of [2, 3]) {
    await expect.poll(async () => (await traffic(page)).welcomes).toBe(restart);
    await panic(page);
    await expect(status).toHaveText(restarted(restart, stillClosed));
    await expect(reopen).toBeFocused();
  }
  // The fourth failure stops the app, and the offer goes.
  await expect.poll(async () => (await traffic(page)).welcomes).toBe(4);
  await panic(page);
  await expect(status).toHaveText(stopped);
  await expect(state).toHaveAttribute("data-engine-state", "failed");
  await expect(reopen).toHaveCount(0);
  await expectVisibleFocusOnThePages(page);
  expect(await problems()).toEqual([]);
});

test('keyboard focus on the offer goes to the "Pages" region, not to the page, when the worker fails', async ({
  page,
  browserName,
}) => {
  const problems = await collectProblems(page);
  await enablePanics(page);
  await page.goto("/");
  const { state, status, reopen, heading } = view(page);
  await expect(heading).toBeAttached({ timeout: 30_000 });
  await focusTheDocument(page);
  await panic(page);
  await expect(status).toHaveText(restarted(1, closed));
  await expect.poll(async () => (await traffic(page)).welcomes).toBe(2);
  await focusTheOffer(page, browserName);
  // The next panic makes the worker host fail to replace the engine, and the host reports restart_failed. Nothing can restart a worker
  // that failed (spec §12.1, point 1): the app stops, and the offer goes.
  await breakEngineRestarts(page);
  await panic(page);
  await expect(status).toHaveText(workerStopped);
  await expect(state).toHaveAttribute("data-engine-state", "failed");
  await expect(reopen).toHaveCount(0);
  await expectVisibleFocusOnThePages(page);
  await expectNoTextBox(page);
  expect(await problems()).toEqual([]);
});

test('taking the offer from the keyboard keeps focus in the "Pages" region until the document is open, also if it fails again', async ({
  page,
  browserName,
}) => {
  const problems = await collectProblems(page);
  await enablePanics(page);
  await page.goto("/");
  const { status, reopen, heading, editable } = view(page);
  await expect(heading).toBeAttached({ timeout: 30_000 });
  await focusTheDocument(page);
  await panic(page);
  await expect(status).toHaveText(restarted(1, closed));
  await expect.poll(async () => (await traffic(page)).welcomes).toBe(2);
  await focusTheOffer(page, browserName);
  // Enter takes the offer, which goes, and the engine fails on the app's doc.open, so the offer comes back while the document is still
  // being reopened. Keyboard focus waited in the document area, and is still there.
  await failNext(page, "doc.open");
  await page.keyboard.press("Enter");
  await expect(status).toHaveText(restarted(2, closed));
  await expect(reopen).toBeVisible();
  await expect(heading).toHaveCount(0);
  await expectVisibleFocusOnThePages(page);
  // Taken again, the document opens this time, and keyboard focus goes into it.
  await expect.poll(async () => (await traffic(page)).welcomes).toBe(3);
  await focusTheOffer(page, browserName);
  await page.keyboard.press("Enter");
  await expect(heading).toBeAttached({ timeout: 30_000 });
  await expect(status).toHaveText("The document was reopened.");
  await expect(reopen).toHaveCount(0);
  await expect(editable).toBeFocused();
  expect((await traffic(page)).statuses).not.toContain(couldNotOpen);
  expect(await problems()).toEqual([]);
});

test("keyboard focus on another control stays where it is when the offer goes", async ({ page, browserName }) => {
  const problems = await collectProblems(page);
  await enablePanics(page);
  await page.goto("/");
  const { state, status, reopen, heading } = view(page);
  const zoomIn = page.getByRole("button", { name: "Zoom in" });
  await expect(heading).toBeAttached({ timeout: 30_000 });
  await focusTheDocument(page);
  await panic(page);
  await expect(status).toHaveText(restarted(1, closed));
  await focusTheOffer(page, browserName);
  // One control further back is "Zoom in": the user chose it, and the offer's going is no reason to move focus away from it.
  await page.keyboard.press(browserName === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab");
  await expect(zoomIn).toBeFocused();
  for (const restart of [2, 3]) {
    await expect.poll(async () => (await traffic(page)).welcomes).toBe(restart);
    await panic(page);
    await expect(status).toHaveText(restarted(restart, stillClosed));
  }
  await expect.poll(async () => (await traffic(page)).welcomes).toBe(4);
  await panic(page);
  await expect(status).toHaveText(stopped);
  await expect(state).toHaveAttribute("data-engine-state", "failed");
  await expect(reopen).toHaveCount(0);
  await expect(zoomIn).toBeFocused();
  expect(await problems()).toEqual([]);
});
