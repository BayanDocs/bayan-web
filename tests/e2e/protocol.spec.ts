import { expect, type Page, test } from "@playwright/test";
import { collectProblems } from "./collect-problems.ts";
import { keepWorker, waitForDocument } from "./document.ts";
import { rewriteHello, sentTypes } from "./engine-failures.ts";

// Engine protocol v1 against the real engine (WEB-004, spec §14.1): the session's version on every message, a refused hello, and messages
// that break the protocol. Each ends the app's use of the engine for good: the worker is terminated, no new session starts, and the status
// line, a live region that screen readers announce, says what happened in the app's own words; after unsupported_protocol_version it is the
// update prompt, with a button that reloads the page. The unit tests check every kind of violation (tests/unit/engine-client.test.ts);
// these show the app's answer in each browser engine.

const stopped = "The engine stopped. Reload the page to start it again.";
const update = "The app was updated while this page was open. Reload the page to finish the update.";
/** Long enough for the app to have sent anything it was going to send after the last answer. */
const quietMs = 1_000;

/** Waits until the engine's worker is gone: the app terminated it. */
async function expectWorkerTerminated(page: Page): Promise<void> {
  await expect.poll(() => page.workers().length).toBe(0);
}

test("hello offers protocol version 1, names the system the browser runs on, and says that the shell runs in a browser", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, transfer?: Transferable[]) {
      if ((message as { type?: unknown } | null)?.type === "hello") Object.assign(globalThis, { __hello: message });
      return Reflect.apply(post, this, [message, transfer]);
    } as typeof Worker.prototype.postMessage;
  });
  await page.goto("/");
  await waitForDocument(page);
  const { hello, expected } = await page.evaluate(() => {
    // What the browser tells (src/engine/platform.ts): userAgentData where Chromium has it, navigator.platform elsewhere.
    const hint = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform;
    const platform = navigator.platform;
    const expected =
      hint === "macOS" || (hint === undefined && platform.startsWith("Mac"))
        ? "macos"
        : hint === "Windows" || (hint === undefined && platform.startsWith("Win"))
          ? "windows"
          : hint === "Linux" || (hint === undefined && platform.startsWith("Linux"))
            ? "linux"
            : "unexpected";
    return { hello: (globalThis as unknown as { __hello: unknown }).__hello, expected };
  });
  // Playwright's browsers run on the CI's Linux and Mac machines only.
  expect(expected).not.toBe("unexpected");
  expect(hello).toMatchObject({
    v: 1,
    type: "hello",
    payload: { protocol_versions: [1], shell: { name: "bayan-web", platform: expected, runtime: "browser" } },
  });
});

test("after unsupported_protocol_version the app shows the update prompt, announced, with a button that reloads the page", async ({
  page,
}) => {
  const problems = await collectProblems(page);
  // An app that offers only protocol version 0, as an old deployment's would: the v1 engine refuses its hello (spec §14.1 item 3).
  await rewriteHello(page, { protocol_versions: [0] });
  await page.goto("/");
  const status = page.locator(".document-status");
  await expect(page.locator(".document-view")).toHaveAttribute("data-engine-state", "failed", { timeout: 30_000 });
  // In the live region, which screen readers announce wherever focus is.
  await expect(status).toHaveAttribute("role", "status");
  await expect(status).toHaveText(update);
  const reload = page.getByRole("button", { name: "Reload the page" });
  await expect(reload).toBeVisible();
  // The engine's use ended: the worker is terminated, and the app sent no new hello and nothing else.
  await expectWorkerTerminated(page);
  await page.waitForTimeout(quietMs);
  expect(await sentTypes(page)).toEqual(["hello"]);
  // The button reloads the page, which is how a browser that holds files of two deployments gets the new ones.
  await page.evaluate(() => Object.assign(globalThis, { __beforeReload: true }));
  await Promise.all([page.waitForEvent("load"), reload.click()]);
  expect(await page.evaluate(() => "__beforeReload" in globalThis)).toBe(false);
  expect(await problems()).toEqual([]);
});

test("after any other refusal of hello the app stops with the stop message, without a new hello or the update prompt", async ({
  page,
}) => {
  const problems = await collectProblems(page);
  // A malformed hello, which the engine refuses with invalid_request: a bug, not something an update or a new session repairs.
  await rewriteHello(page, { protocol_versions: "1" });
  await page.goto("/");
  await expect(page.locator(".document-view")).toHaveAttribute("data-engine-state", "failed", { timeout: 30_000 });
  await expect(page.locator(".document-status")).toHaveText(stopped);
  await expect(page.getByRole("button", { name: "Reload the page" })).toHaveCount(0);
  await expectWorkerTerminated(page);
  await page.waitForTimeout(quietMs);
  expect(await sentTypes(page)).toEqual(["hello"]);
  expect(await problems()).toEqual([]);
});

/**
 * Messages from the engine that break the protocol (spec §14.1 item 5), each handed to the app as the engine's worker would send it. Large
 * parts are left out here and built in the page (`childrenBuiltInPage`): handing hundreds of thousands of objects from the test to the
 * page takes Playwright longer than a test may run on a slow machine, while the app itself refuses such a tree before it walks it.
 */
const violations: Record<string, (docId: number) => unknown> = {
  "a message of protocol version 0": (docId) => ({
    v: 0,
    type: "render.invalidate",
    seq: 1_000_000,
    payload: { doc_id: docId, revision: 1_000, regions: [] },
  }),
  "an event without seq": (docId) => ({
    v: 1,
    type: "render.invalidate",
    payload: { doc_id: docId, revision: 1_000, regions: [] },
  }),
  "a message that is not an object": () => "render.invalidate",
  "an overlay without its revision": (docId) => ({
    v: 1,
    type: "overlay.update",
    seq: 1_000_000,
    payload: { doc_id: docId, caret: null, selection: [], remote: [], highlights: [] },
  }),
  "an engine.error that does not say what follows": () => ({
    v: 1,
    type: "engine.error",
    seq: 1_000_000,
    payload: { code: "panic", message_id: "engine-error-panic", recoverable: false, args: {} },
  }),
  "an accessibility tree with a node of 200,001 children": (docId) => ({
    v: 1,
    type: "a11y.update",
    seq: 1_000_000,
    payload: {
      doc_id: docId,
      changes: [{ kind: "replace", node: { id: 1, role: "document", children: [] } }],
      caret: null,
    },
  }),
};

/** For these messages, the page gives the node of the first change this many paragraphs as its children before it hands them over. */
const childrenBuiltInPage: Record<string, number> = {
  "an accessibility tree with a node of 200,001 children": 200_001,
};

for (const [what, message] of Object.entries(violations)) {
  test(`${what} ends the engine's use: the stop message, and the worker terminated`, async ({ page }) => {
    await keepWorker(page);
    await page.goto("/");
    await waitForDocument(page);
    const mirror = page.getByTestId("a11y-mirror");
    const docId = await page.evaluate(() => (globalThis as unknown as { __docId: number }).__docId);
    // Playwright hands the message to the page as the page's own objects, as a worker's message would arrive.
    await page.evaluate(
      ({ data, children }) => {
        const change = (data as { payload?: { changes?: { node: { children: unknown[] } }[] } } | null)?.payload
          ?.changes?.[0];
        if (children > 0 && change !== undefined) {
          change.node.children = Array.from({ length: children }, (_, index) => ({
            id: 2_000_000 + index,
            role: "paragraph",
          }));
        }
        (globalThis as unknown as { __engineWorker: Worker }).__engineWorker.dispatchEvent(
          new MessageEvent("message", { data }),
        );
      },
      { data: message(docId), children: childrenBuiltInPage[what] ?? 0 },
    );
    await expect(page.locator(".document-view")).toHaveAttribute("data-engine-state", "failed");
    await expect(page.locator(".document-status")).toHaveText(stopped);
    await expectWorkerTerminated(page);
    // The session is over: the document is gone from the mirror, and nothing offers to reopen it.
    await expect(mirror.getByRole("heading")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reopen the document" })).toHaveCount(0);
  });
}
