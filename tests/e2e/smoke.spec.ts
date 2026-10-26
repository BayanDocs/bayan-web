import { expect, type Locator, type Page, test } from "@playwright/test";
import { collectProblems } from "./collect-problems.ts";
import { waitForDocument } from "./document.ts";

test("the application frame loads with no CSP violations or errors", async ({ page }) => {
  const problems = await collectProblems(page);
  await page.goto("/");

  await expect(page).toHaveTitle("BayanDocs");
  await expect(page.getByRole("region", { name: "Ribbon" })).toBeVisible();
  await expect(page.getByRole("main", { name: "Document" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Dark theme" })).toBeVisible();
  // The engine starts, opens its mock document and draws its first tiles without a violation either.
  await waitForDocument(page);

  expect(await problems()).toEqual([]);
});

// Regression test: merely reading window.localStorage throws a SecurityError when the user blocks sites from saving data,
// and the app used to render a blank page.
test("the app works when the browser blocks site storage", async ({ page }) => {
  const problems = await collectProblems(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
  });
  await page.goto("/");

  await expect(page.getByRole("region", { name: "Ribbon" })).toBeVisible();
  await expect(page.getByRole("main", { name: "Document" })).toBeVisible();
  const darkTheme = page.getByRole("switch", { name: "Dark theme" });
  await expect(darkTheme).toBeVisible();
  // The switch still works; the choice just is not remembered.
  const before = await page.locator("html").getAttribute("data-theme");
  await page.getByText("Dark theme").click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", before ?? "");

  expect(await problems()).toEqual([]);
});

test("the title bar links to the third-party licence notices", async ({ page }) => {
  await page.goto("/");
  const link = page.getByRole("banner").getByRole("link", { name: "Licenses", exact: true });
  await expect(link).toHaveAttribute("href", "/third-party-licenses.txt");
  await link.click();
  await expect(page).toHaveURL(/\/third-party-licenses\.txt$/);
  await expect(page.locator("body")).toContainText("The app bundles dependencies which contain the following licenses");
});

// The engine's WebAssembly package contains code from Rust crates and the Rust standard library, whose licences require their notices
// to accompany every copy (WEB-002; config/engine-files.ts publishes them from the package).
test("the title bar links to the engine's licence notices", async ({ page, request }) => {
  await page.goto("/");
  const link = page.getByRole("banner").getByRole("link", { name: "Engine licenses", exact: true });
  await expect(link).toHaveAttribute("href", "/engine-licenses/THIRD-PARTY-LICENSES.txt");
  await link.click();
  await expect(page).toHaveURL(/\/engine-licenses\/THIRD-PARTY-LICENSES\.txt$/);
  await expect(page.locator("body")).toContainText("Third-party software in the BayanDocs engine WebAssembly package");
  for (const path of [
    "RUST-STANDARD-LIBRARY-COPYRIGHT.html",
    "LICENSES/GPL-3.0-or-later.txt",
    "LICENSES/LicenseRef-BayanDocs-App-Store-Permission.txt",
  ]) {
    expect((await request.get(`/engine-licenses/${path}`)).ok(), path).toBe(true);
  }
});

test("the page is cross-origin isolated", async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
});

/**
 * Opens the app with the system colour scheme set to light or dark.
 * Playwright's colour-scheme emulation is lost when Firefox moves a cross-origin-isolated page into its own process,
 * so the scheme is applied to the loaded page and the page is then reloaded (the reload stays in that process).
 * The reload waits until the app has started: a reload while the engine's worker is still downloading its files now and
 * then makes WebKit fail the reload itself or the reloaded page's own scripts ("WebKit encountered an internal error").
 */
async function openWithSystemScheme(page: Page, colorScheme: "light" | "dark"): Promise<void> {
  await page.goto("/");
  await waitForDocument(page);
  await page.emulateMedia({ colorScheme });
  await page.reload();
  expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(colorScheme === "dark");
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`the theme follows the system preference (${colorScheme})`, async ({ page }) => {
    await openWithSystemScheme(page, colorScheme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
    const darkTheme = page.getByRole("switch", { name: "Dark theme" });
    await (colorScheme === "dark" ? expect(darkTheme).toBeChecked() : expect(darkTheme).not.toBeChecked());
  });
}

/**
 * Moves keyboard focus forward from wherever it is (the top of a freshly loaded page) until `target` has it, the way a keyboard
 * user would. WebKit, like Safari on macOS, skips links and form controls on plain Tab unless Full Keyboard Access is turned on,
 * so it needs Alt+Tab (Option+Tab); Chromium and Firefox use Tab.
 */
async function tabTo(page: Page, browserName: string, target: Locator, maxPresses = 5): Promise<void> {
  const key = browserName === "webkit" ? "Alt+Tab" : "Tab";
  for (let presses = 0; presses < maxPresses; presses += 1) {
    await page.keyboard.press(key);
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error(`${maxPresses} presses of ${key} never reached the target`);
}

test("the dark-theme switch works from the keyboard and is remembered", async ({ page, browserName }) => {
  await openWithSystemScheme(page, "light");
  const darkTheme = page.getByRole("switch", { name: "Dark theme" });
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const lightBackground = await background();

  await tabTo(page, browserName, darkTheme);
  await expect(darkTheme).toBeFocused();
  await page.keyboard.press("Space");
  await expect(darkTheme).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await background()).not.toBe(lightBackground);

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("switch", { name: "Dark theme" })).toBeChecked();
});
