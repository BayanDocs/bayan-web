import { expect, type Page, test } from "@playwright/test";
import { collectProblems } from "./collect-problems.ts";

test("the application frame loads with no CSP violations or errors", async ({ page }) => {
  const problems = await collectProblems(page);
  await page.goto("/");

  await expect(page).toHaveTitle("BayanDocs");
  await expect(page.getByRole("region", { name: "Ribbon" })).toBeVisible();
  await expect(page.getByRole("main", { name: "Document" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Dark theme" })).toBeVisible();

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

test("the page is cross-origin isolated", async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
});

/**
 * Opens the app with the system colour scheme set to light or dark.
 * Playwright's colour-scheme emulation is lost when Firefox moves a cross-origin-isolated page into its own process,
 * so the scheme is applied to the loaded page and the page is then reloaded (the reload stays in that process).
 */
async function openWithSystemScheme(page: Page, colorScheme: "light" | "dark"): Promise<void> {
  await page.goto("/");
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

test("the dark-theme switch works from the keyboard and is remembered", async ({ page }) => {
  await openWithSystemScheme(page, "light");
  const darkTheme = page.getByRole("switch", { name: "Dark theme" });
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const lightBackground = await background();

  await darkTheme.focus();
  await page.keyboard.press("Space");
  await expect(darkTheme).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await background()).not.toBe(lightBackground);

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("switch", { name: "Dark theme" })).toBeChecked();
});
