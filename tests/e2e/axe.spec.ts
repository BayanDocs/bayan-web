import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { collectProblems } from "./collect-problems.ts";
import { waitForDocument } from "./document.ts";
import { breakEngineRestarts, enablePanics, panic, traffic } from "./engine-failures.ts";

// Automated accessibility rules (WEB-003; ADR-0020 decision 6, ADR-0014 decision 3): axe-core's rules for the success criteria of WCAG 2.0,
// 2.1 and 2.2 at levels A and AA (A11Y-01 asks for WCAG 2.2 AA) run on every state the app has, in Chromium, Firefox and WebKit and in the
// light and the dark theme, and fail on any violation, naming the rule, the element and axe's help text. axe inspects the page's structure,
// names, roles, states and colours. It reads no pixels, so it checks the shell's controls and the accessibility mirror, not the canvas,
// which is hidden from assistive technology on purpose (a11y.spec.ts). It cannot judge all that WCAG asks, such as whether a name makes
// sense or how a screen reader really reads the page: the manual passes with screen readers stay (docs/spikes/WEB-002-report.md).
//
// axe runs on the production build, under the production Content Security Policy and Trusted Types, with nothing bypassed (no bypassCSP).
// @axe-core/playwright hands axe's script to the page through Playwright's own channel to the browser, which the page's policy does not
// govern, and finishes each run, merging the results, in a blank page of its own. axe's code runs inside the app's page, so a write of it
// to a sink that Trusted Types guards, or an eval, would be a violation that collectProblems reports: every test here checks that it
// reports nothing, except the browsers' own reports of the engine file that the integrity test changes. No rule is disabled, and no element
// is excluded.
//
// The states: the app as it loads, while the engine starts; the document open, with its mirror built; typing in it; zoomed out and in as
// far as it goes, where one zoom button is disabled; the engine restarted after a failure, with the offer to reopen the document; stopped
// at the fourth failure; the offer to open the document after a failure before it was ever open; stopped because the engine's worker
// failed; the engine's files refused by their integrity check; and, in Chromium, typing through the hidden text area, the input bridge of
// Firefox and WebKit. The other states the end-to-end tests reach look the same to axe as one of these (blocked site storage, a
// device-pixel ratio of 2, a scrolled document, an input method's composition, which the engine draws while the bridge stays the same text
// box). The licence notices the title bar links to are plain-text files, which the browser shows in a viewer of its own: not pages of the app.

/**
 * axe's tags for the success criteria of WCAG 2.0, 2.1 and 2.2 at levels A and AA. axe has no tag wcag22a, because none of its rules tests
 * a level-A criterion that WCAG 2.2 added; the last test fails when axe gains a WCAG 2 tag of these levels that this list lacks. As always
 * with tags, axe leaves out the rules it marks experimental or deprecated (in axe-core 4.14.1, 6 of the 70 rules with these tags).
 */
const wcagTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Runs axe's WCAG rules on the page as it is now and describes each element that violates one: the rule, the element and axe's help. */
async function violations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
  // A run that checked nothing would pass without meaning anything.
  expect(results.passes.length, "rules that axe checked and found met").toBeGreaterThan(0);
  return results.violations.flatMap((violation) =>
    violation.nodes.map((node) =>
      [
        `${violation.id} (${violation.impact ?? "impact not given"}): ${violation.help}, ${violation.helpUrl}`,
        `  element: ${node.target.join(" ")}`,
        `  ${node.html}`,
        ...(node.failureSummary ?? "").split("\n").map((line) => `  ${line}`),
      ].join("\n"),
    ),
  );
}

/** Fails, listing every violation, unless the page as it is now meets all of axe's WCAG rules. */
async function expectNoViolations(page: Page, state: string): Promise<void> {
  const found = await violations(page);
  expect(found.length, `axe's WCAG rules, ${state}:\n\n${found.join("\n\n")}\n`).toBe(0);
}

/** Puts keyboard focus in the editable line by a click on it, types into it, and waits until the input bridge holds the engine's text. */
async function typeInTheDocument(page: Page): Promise<void> {
  const editable = page.getByRole("textbox", { name: "Editable line" });
  const box = await page.getByTestId("document-scroller").boundingBox();
  await page.getByTestId("document-scroller").click({ position: { x: (box?.width ?? 800) / 2, y: 80 } });
  await expect(editable).toBeFocused();
  await page.keyboard.type("word");
  await expect
    .poll(() =>
      editable.evaluate((element) =>
        element instanceof HTMLTextAreaElement ? element.value : (element.textContent ?? ""),
      ),
    )
    .toBe("word");
}

/** Presses a zoom button until it is disabled, waiting for each new zoom level, and checks that the zoom ends at `limit`. */
async function zoomAllTheWay(page: Page, name: "Zoom in" | "Zoom out", limit: string): Promise<void> {
  const button = page.getByRole("button", { name });
  const level = page.locator(".zoom-level");
  for (let presses = 0; presses < 20 && !(await button.isDisabled()); presses += 1) {
    const before = (await level.textContent()) ?? "";
    await button.click();
    await expect(level).not.toHaveText(before);
  }
  await expect(level).toHaveText(limit);
  await expect(button).toBeDisabled();
}

/** Waits until the engine has answered `count` handshakes in all: the restart after a failure is then complete. */
async function waitForWelcomes(page: Page, count: number): Promise<void> {
  await expect.poll(async () => (await traffic(page)).welcomes, { timeout: 30_000 }).toBe(count);
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      // The theme as the user's remembered choice (src/theme.ts), so that the app starts in it.
      await page.addInitScript((chosen) => localStorage.setItem("bayandocs.theme", chosen), theme);
    });

    test("the app as it loads, with the document open, while typing in it, and zoomed out and in as far as it goes", async ({
      page,
    }) => {
      // Five runs of axe and every zoom level from 25% to 500%: 5 to 14 s here, and CI's macOS 26 Intel runner is several times slower
      // (see tests/e2e/document.ts), so this test gets three times its project's time limit.
      test.slow();
      const problems = await collectProblems(page);
      // The engine's WebAssembly module is held back until axe has checked the app as it loads, so that the engine is still starting then.
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/assets/engine-*/bayan_wasm_bg.wasm", async (route) => {
        await held;
        await route.continue();
      });
      await page.goto("/");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator(".document-view")).toHaveAttribute("data-engine-state", "starting");
      await expect(page.locator(".document-status")).toHaveText("Starting the engine…");
      await expectNoViolations(page, "the app as it loads, while the engine starts");
      release();
      await waitForDocument(page);
      await expectNoViolations(page, "the document open, with its accessibility mirror built");
      await typeInTheDocument(page);
      await expectNoViolations(page, "typing in the document");
      await zoomAllTheWay(page, "Zoom out", "25%");
      await expectNoViolations(page, "zoomed out as far as it goes, where Zoom out is disabled");
      await zoomAllTheWay(page, "Zoom in", "500%");
      await expectNoViolations(page, "zoomed in as far as it goes, where Zoom in is disabled");
      expect(await problems()).toEqual([]);
    });

    test("after the engine failed: restarted, with the offer to reopen the document, and stopped at the fourth failure", async ({
      page,
    }) => {
      const problems = await collectProblems(page);
      await enablePanics(page);
      await page.goto("/");
      await waitForDocument(page);
      await panic(page);
      await expect(page.getByRole("button", { name: "Reopen the document" })).toBeVisible();
      await waitForWelcomes(page, 2);
      await expectNoViolations(page, "the engine restarted after a failure, with the offer to reopen the document");
      for (const failure of [2, 3, 4]) {
        await waitForWelcomes(page, failure);
        await panic(page);
      }
      await expect(page.locator(".document-view")).toHaveAttribute("data-engine-state", "failed");
      await expect(page.getByRole("button", { name: "Reopen the document" })).toHaveCount(0);
      await expectNoViolations(page, "stopped at the fourth failure");
      expect(await problems()).toEqual([]);
    });

    test("after the engine failed before the document was ever open: the offer to open it", async ({ page }) => {
      const problems = await collectProblems(page);
      // The engine fails on the app's first ui.manifest, which comes after hello and before doc.open.
      await enablePanics(page, { type: "ui.manifest", times: 1 });
      await page.goto("/");
      await expect(page.getByRole("button", { name: "Open the document" })).toBeVisible({ timeout: 30_000 });
      await waitForWelcomes(page, 2);
      await expectNoViolations(
        page,
        "the engine restarted before the document was ever open, with the offer to open it",
      );
      expect(await problems()).toEqual([]);
    });

    test("after the engine's worker failed: stopped", async ({ page }) => {
      const problems = await collectProblems(page);
      await enablePanics(page);
      await page.goto("/");
      await waitForDocument(page);
      await panic(page);
      await waitForWelcomes(page, 2);
      // The worker host cannot replace the engine after the next failure, reports it, and the app stops (spec §12.1, point 1).
      await breakEngineRestarts(page);
      await panic(page);
      await expect(page.locator(".document-view")).toHaveAttribute("data-engine-state", "failed");
      await expect(page.locator(".document-status")).toHaveText(
        "The engine stopped. Reload the page to start it again.",
      );
      await expectNoViolations(page, "stopped because the engine's worker failed");
      expect(await problems()).toEqual([]);
    });

    test("after the engine's files failed their integrity check: the engine never started", async ({ page }) => {
      const problems = await collectProblems(page);
      // One byte more in the engine's glue code, as engine.spec.ts does: the app refuses the file and never starts the engine's worker.
      await page.route("**/assets/engine-*/bayan_wasm.js", async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, body: Buffer.concat([await response.body(), Buffer.from([10])]) });
      });
      await page.goto("/");
      await expect(page.locator(".document-view")).toHaveAttribute("data-engine-state", "failed");
      await expect(page.locator(".document-status")).toContainText("integrity check");
      await expectNoViolations(page, "the engine's files refused by their integrity check");
      // The browsers report the refused file themselves, as console errors (WebKit also as an exception). Those reports are all there may
      // be: nothing else, and no violation of the policy.
      const unexpected = (await problems()).filter(
        (problem) => problem.startsWith("CSP violation") || !problem.includes("/bayan_wasm.js"),
      );
      expect(unexpected).toEqual([]);
    });

    test("typing through the hidden text area, the input bridge of Firefox and WebKit, in Chromium", async ({
      page,
      browserName,
    }) => {
      test.skip(
        browserName !== "chromium",
        "Firefox and WebKit always use the hidden text area, which the first test checks in them",
      );
      const problems = await collectProblems(page);
      // Without EditContext, Chromium uses the bridge that Firefox and Safari use (as input.spec.ts does).
      await page.addInitScript(() => Reflect.deleteProperty(globalThis, "EditContext"));
      await page.goto("/");
      await waitForDocument(page);
      await expect(page.locator(".document-view")).toHaveAttribute("data-input-bridge", "hidden-element");
      await typeInTheDocument(page);
      await expectNoViolations(page, "typing in the document through the hidden text area");
      expect(await problems()).toEqual([]);
    });
  });
}

test("control: a button without an accessible name is a violation, listed with the rule, the element and axe's help", async ({
  page,
}) => {
  const problems = await collectProblems(page);
  await page.goto("/");
  await waitForDocument(page);
  await expectNoViolations(page, "before the button is added");
  // Added with DOM methods only, as the app builds its elements: no HTML from strings.
  await page.getByTestId("ribbon").evaluate((ribbon) => {
    const button = document.createElement("button");
    button.id = "button-without-a-name";
    ribbon.append(button);
  });
  const found = await violations(page);
  expect(found).toHaveLength(1);
  expect(found[0]).toMatch(
    /^button-name \(critical\): Buttons must have discernible text, https:\/\/dequeuniversity\.com\//,
  );
  expect(found[0]).toContain("element: #button-without-a-name");
  expect(found[0]).toContain('<button id="button-without-a-name"></button>');
  expect(found[0]).toContain("Element does not have inner text that is visible to screen readers");
  expect(await problems()).toEqual([]);
});

test("the checks select every rule that axe has for WCAG 2.0, 2.1 and 2.2 at levels A and AA", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "axe's rules and their tags are the same in every browser");
  await page.goto("/");
  await violations(page);
  const tags = await page.evaluate(() =>
    (window as unknown as { axe: { getRules(): { tags: string[] }[] } }).axe.getRules().flatMap((rule) => rule.tags),
  );
  // wcag2a, wcag2aa, wcag21a, …: a WCAG 2 version and a level of A or AA; wcag2aaa is level AAA, wcag111 a single success criterion.
  const levelAOrAA = [...new Set(tags.filter((tag) => /^wcag2\d*a{1,2}$/.test(tag)))].sort();
  expect(levelAOrAA).toEqual([...wcagTags].sort());
});
