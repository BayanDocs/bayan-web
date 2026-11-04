import { expect, type Page, test } from "@playwright/test";
import { collectProblems } from "./collect-problems.ts";

// The recovery policy of engine protocol §12.1, against the real engine: after an unrecoverable engine.error the app starts a new session at
// most three times in ten minutes (src/engine/recovery.ts; tests/unit/recovery.test.ts checks the ten minutes), says so each time in its
// status live region, which screen readers announce, never reopens the document unless the user asks, and at the fourth failure stops.
//
// The engine panics on diag.panic only when its configuration's test switch test.allow_panic is on (spec §3.3, §6.7), which the app never
// turns on. Before the app starts, this test wraps Worker.prototype.postMessage: it adds the switch to the worker host's init message,
// records the type of every message the app sends, and keeps the worker, so that the test can send diag.panic to the real engine.

interface Traffic {
  /** The type of every protocol message sent to the worker, in order, including the test's diag.panic. */
  readonly sent: string[];
  /** How many welcome replies (successful handshakes) and unrecoverable engine.error events arrived. */
  readonly welcomes: number;
  readonly failures: number;
}

async function enablePanics(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const traffic = { sent: [] as string[], welcomes: 0, failures: 0 };
    let engineWorker: Worker | undefined;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, transfer?: Transferable[]) {
      const envelope = message as { worker?: unknown; type?: unknown } | null;
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
      return Reflect.apply(post, this, [message, transfer]);
    } as typeof Worker.prototype.postMessage;
    Object.assign(globalThis, {
      __traffic: traffic,
      // Without an id, so the app's requests and their identifiers are untouched; the engine answers with engine.error only.
      __panic: () => engineWorker?.postMessage({ v: 0, type: "diag.panic" }),
    });
  });
}

async function traffic(page: Page): Promise<Traffic> {
  return page.evaluate(() => {
    const { sent, welcomes, failures } = (globalThis as unknown as { __traffic: Traffic }).__traffic;
    return { sent: sent.slice(), welcomes, failures };
  });
}

/** Makes the real engine panic, and returns how many messages had been sent before. */
async function panic(page: Page): Promise<number> {
  const before = (await traffic(page)).sent.length;
  await page.evaluate(() => (globalThis as unknown as { __panic: () => void }).__panic());
  return before;
}

/** The types of the messages sent since `before` messages had been sent. */
async function sentSince(page: Page, before: number): Promise<string[]> {
  return (await traffic(page)).sent.slice(before);
}

/** Long enough for the app to have sent anything it was going to send after the last answer: it has no timer of its own but view.set's. */
const quietMs = 1_000;

test("the app restarts the engine three times after failures, says so each time, reopens only when asked, then stops", async ({
  page,
}) => {
  const problems = await collectProblems(page);
  await enablePanics(page);
  await page.goto("/");
  const view = page.locator(".document-view");
  const status = page.locator(".document-status");
  const reopen = page.getByRole("button", { name: "Reopen the document" });
  const heading = page.getByTestId("a11y-mirror").getByRole("heading", { level: 1 });
  await expect(view).toHaveAttribute("data-engine-state", "ready", { timeout: 30_000 });
  await expect(heading).toBeAttached({ timeout: 30_000 });
  // The messages are in a live region, which screen readers announce wherever focus is.
  await expect(status).toHaveAttribute("role", "status");
  await expect(reopen).toHaveCount(0);
  expect((await traffic(page)).welcomes).toBe(1);

  for (const restart of [1, 2, 3]) {
    const before = await panic(page);
    await expect(status).toHaveText(
      `The engine stopped working and was restarted (${restart} of 3). The document was closed and can be reopened.`,
    );
    // A new session (hello, answered with welcome), without the document: the mirror is empty and no doc.open was sent.
    await expect.poll(async () => (await traffic(page)).welcomes).toBe(restart + 1);
    await expect(heading).toHaveCount(0);
    await expect(page.getByTestId("a11y-mirror")).not.toContainText("BayanDocs");
    await page.waitForTimeout(quietMs);
    const restarted = await sentSince(page, before);
    expect(restarted).toContain("hello");
    expect(restarted).not.toContain("doc.open");
    expect((await traffic(page)).failures).toBe(restart);
    // Only when the user asks.
    await reopen.click();
    await expect(heading).toBeAttached({ timeout: 30_000 });
    await expect(status).toHaveText("The document was reopened.");
    await expect(reopen).toHaveCount(0);
    // The pressed button is gone; keyboard focus is in the document, not lost.
    await expect(page.getByRole("textbox", { name: "Editable line" })).toBeFocused();
    expect(await sentSince(page, before)).toContain("doc.open");
  }

  // The fourth failure within ten minutes: no new session, and the app says so.
  const before = await panic(page);
  await expect(status).toHaveText(
    "The engine stopped working again, so it was not restarted. Reload the page to start it again.",
  );
  await expect(view).toHaveAttribute("data-engine-state", "failed");
  await expect(heading).toHaveCount(0);
  await expect(reopen).toHaveCount(0);
  // Tiles of the reopened document may have been requested before the failure arrived; nothing at all is sent after it.
  const stopped = await sentSince(page, before);
  expect(stopped).not.toContain("hello");
  expect(stopped).not.toContain("doc.open");
  await page.waitForTimeout(quietMs);
  expect(await sentSince(page, before)).toEqual(stopped);
  const last = await traffic(page);
  expect(last.failures).toBe(4);
  expect(last.welcomes).toBe(4);
  expect(await problems()).toEqual([]);
});

test("a failure while the document opens restarts without reopening it", async ({ page }) => {
  const problems = await collectProblems(page);
  await enablePanics(page);
  await page.goto("/");
  const status = page.locator(".document-status");
  const heading = page.getByTestId("a11y-mirror").getByRole("heading", { level: 1 });
  await expect(heading).toBeAttached({ timeout: 30_000 });
  // diag.panic queued right behind the app's doc.open: the engine fails while the reopened document is still on its way in.
  await panic(page);
  await page.getByRole("button", { name: "Reopen the document" }).click();
  const before = await panic(page);
  await expect(status).toHaveText(
    "The engine stopped working and was restarted (2 of 3). The document was closed and can be reopened.",
  );
  await expect(page.getByRole("button", { name: "Reopen the document" })).toBeVisible();
  await page.waitForTimeout(quietMs);
  await expect(heading).toHaveCount(0);
  expect(await sentSince(page, before)).not.toContain("doc.open");
  expect(await problems()).toEqual([]);
});
