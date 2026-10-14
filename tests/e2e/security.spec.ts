import { expect, type Page, test } from "@playwright/test";
import { productionHeaders } from "../../config/security-headers.ts";

/**
 * Every same-origin resource of the build: the page itself, each script, stylesheet and icon it references, and the licence
 * notices the title bar links to.
 */
async function builtResources(html: string): Promise<string[]> {
  const urls = [...html.matchAll(/\s(?:src|href)="(\/[^"]*)"/g)].map((match) => match[1] ?? "");
  return ["/", "/third-party-licenses.txt", ...new Set(urls)];
}

test("the preview server sends every security header on every resource", async ({ request }) => {
  const page = await request.get("/");
  expect(page.ok()).toBe(true);
  const resources = await builtResources(await page.text());
  expect(resources.length).toBeGreaterThanOrEqual(5); // the page, the licence notices, its script, its stylesheet and its icon

  for (const path of resources) {
    const response = await request.get(path);
    expect(response.ok(), path).toBe(true);
    const headers = response.headers(); // Playwright lower-cases header names
    for (const [name, value] of Object.entries(productionHeaders)) {
      expect(headers[name.toLowerCase()], `${name} on ${path}`).toBe(value);
    }
  }
});

test("the engine's files are served with every security header and the types browsers need", async ({
  page,
  request,
}) => {
  const engineFiles: string[] = [];
  page.on("request", (sent) => {
    const path = new URL(sent.url()).pathname;
    if (path.startsWith("/assets/engine-")) engineFiles.push(path);
  });
  await page.goto("/");
  await expect(page.locator(".document-view")).toHaveAttribute("data-engine-state", "ready");
  const paths = [...new Set(engineFiles)].sort();
  expect(paths.map((path) => path.replace(/^\/assets\/engine-[0-9a-f]{16}\//, ""))).toEqual([
    "bayan-worker.js",
    "bayan_wasm.js",
    "bayan_wasm_bg.wasm",
  ]);
  for (const path of paths) {
    const response = await request.get(path);
    const headers = response.headers();
    for (const [name, value] of Object.entries(productionHeaders)) {
      expect(headers[name.toLowerCase()], `${name} on ${path}`).toBe(value);
    }
    // WebAssembly streaming compilation needs application/wasm; module scripts need a JavaScript type (nosniff is on).
    expect(headers["content-type"], path).toMatch(path.endsWith(".wasm") ? /^application\/wasm/ : /^text\/javascript/);
  }
});

test("the built page has no inline scripts and every script carries an integrity hash", async ({ request }) => {
  const html = await (await request.get("/")).text();
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
  expect(scripts.length).toBeGreaterThan(0);
  for (const tag of scripts) {
    expect(tag).toMatch(/\ssrc="\/assets\/[^"]+\.js"/);
    expect(tag).toMatch(/\sintegrity="sha384-[A-Za-z0-9+/]+={0,2}"/);
  }
  for (const tag of html.match(/<link\b[^>]*rel="stylesheet"[^>]*>/g) ?? []) {
    expect(tag).toMatch(/\sintegrity="sha384-/);
  }
});

test("a script changed after the build is refused (Subresource Integrity)", async ({ page }) => {
  await page.route("**/assets/*.js", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n// tampered` });
  });
  await page.goto("/");
  await expect(page.locator("#root")).toBeEmpty();
});

/** Serves the built page with every integrity attribute removed, optionally also without the Integrity-Policy header. */
async function serveWithoutIntegrity(page: Page, keepIntegrityPolicy: boolean): Promise<void> {
  await page.route("**/", async (route) => {
    const response = await route.fetch();
    const headers = { ...response.headers() };
    if (!keepIntegrityPolicy) delete headers["integrity-policy"];
    const html = (await response.text()).replace(/\sintegrity="[^"]*"/g, "");
    await route.fulfill({ response, headers, body: html });
  });
}

test("a script without an integrity hash is refused (Integrity-Policy)", async ({ page }) => {
  await serveWithoutIntegrity(page, true);
  await page.goto("/");
  await expect(page.locator("#root")).toBeEmpty();
});

test("control: the same page without Integrity-Policy runs, so the header is what blocks it", async ({ page }) => {
  await serveWithoutIntegrity(page, false);
  await page.goto("/");
  await expect(page.getByRole("switch", { name: "Dark theme" })).toBeVisible();
});
