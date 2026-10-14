import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run against the production build served by `vite preview`, which sends the production security headers.
// Build first (`pnpm build`); `pnpm verify` does both in the right order.
if (!existsSync("dist/index.html")) {
  throw new Error("No production build found: run `pnpm build` before `pnpm test:e2e`.");
}

const port = 4173;
const isCI = process.env["CI"] !== undefined;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  // A failure is a bug to fix, never something to retry until it passes.
  retries: 0,
  reporter: isCI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    // WebKit's frames sometimes take seconds on CI's macOS 26 Intel runner, and in containers without a graphics processor, where it
    // draws in software at the device-pixel ratio of 2 of Playwright's Desktop Safari profile. A page fills at about one tile per frame
    // (tests/e2e/document.ts), so WebKit's tests get three times Playwright's default time limit.
    { name: "webkit", use: { ...devices["Desktop Safari"] }, timeout: 90_000 },
  ],
  webServer: {
    command: `pnpm exec vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !isCI,
  },
});
