import { createHash } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { collectProblems } from "./collect-problems.ts";
import { waitForDocument } from "./document.ts";

// WEB-002 AC-5: the engine's worker starts through the one Trusted Types policy, bayan-script-url, which refuses every other address;
// and the integrity plan: a changed engine file stops the engine before its worker starts. WEB-004 AC-7 (engine protocol §14.8): the worker
// host fetches the engine module with the hash that the app gives it, wasm_integrity, so that the browser refuses a module whose bytes do
// not match before any of it runs.

/** Records the init message that the app sends the worker host; with `integrity`, replaces its wasm_integrity on the way. */
async function watchInit(page: Page, integrity?: string): Promise<void> {
  await page.addInitScript((replacement) => {
    const post = Worker.prototype.postMessage;
    // The first message that each worker receives, as the app sent it.
    const started = new WeakSet<Worker>();
    const firstMessages: unknown[] = [];
    Object.assign(globalThis, { __firstMessages: firstMessages });
    Worker.prototype.postMessage = function (this: Worker, message: unknown, transfer?: Transferable[]) {
      if (!started.has(this)) {
        started.add(this);
        firstMessages.push(message);
      }
      const envelope = message as { worker?: unknown } | null;
      if (envelope?.worker === "init") {
        Object.assign(globalThis, { __init: message });
        if (replacement !== null)
          return Reflect.apply(post, this, [{ ...envelope, wasm_integrity: replacement }, transfer]);
      }
      return Reflect.apply(post, this, [message, transfer]);
    } as typeof Worker.prototype.postMessage;
  }, integrity ?? null);
}

async function initMessage(page: Page): Promise<{ wasm_url: string; wasm_integrity: string }> {
  return page.evaluate(
    () => (globalThis as unknown as { __init: { wasm_url: string; wasm_integrity: string } }).__init,
  );
}

/** Records every policy the page creates and every worker it starts, before the app's scripts run. */
async function watchPoliciesAndWorkers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const policies: { name: string; rules: string[]; policy: unknown }[] = [];
    const workers: string[] = [];
    const factory = globalThis.TrustedTypePolicyFactory.prototype;
    const createPolicy = factory.createPolicy;
    factory.createPolicy = function (name: string, rules?: TrustedTypePolicyOptions) {
      const policy = createPolicy.call(this, name, rules);
      policies.push({ name, rules: Object.keys(rules ?? {}), policy });
      return policy;
    };
    const NativeWorker = globalThis.Worker;
    globalThis.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        workers.push(String(url));
      }
    };
    Object.assign(globalThis, { __policies: policies, __workers: workers });
  });
}

const workerPath = /^\/assets\/engine-[0-9a-f]{16}\/bayan-worker\.js$/;

test("the engine's worker starts through the bayan-script-url policy, the only policy", async ({ page }) => {
  const problems = await collectProblems(page);
  await watchPoliciesAndWorkers(page);
  await page.goto("/");
  await waitForDocument(page);
  const seen = await page.evaluate(() => {
    const { __policies, __workers } = globalThis as unknown as {
      __policies: { name: string; rules: string[] }[];
      __workers: string[];
    };
    return { policies: __policies.map(({ name, rules }) => ({ name, rules })), workers: __workers };
  });
  expect(seen.policies).toEqual([{ name: "bayan-script-url", rules: ["createScriptURL"] }]);
  expect(seen.workers).toHaveLength(1);
  expect(seen.workers[0]).toMatch(workerPath);
  expect(await problems()).toEqual([]);
});

test("the policy refuses every other address and creates neither HTML nor scripts", async ({ page }) => {
  await watchPoliciesAndWorkers(page);
  await page.goto("/");
  await waitForDocument(page);
  const outcomes = await page.evaluate(() => {
    const [{ policy }] = (globalThis as unknown as { __policies: { policy: TrustedTypePolicy }[] }).__policies as [
      { policy: TrustedTypePolicy },
    ];
    const worker = String((globalThis as unknown as { __workers: string[] }).__workers[0]);
    const attempts: Record<string, () => unknown> = {
      "another origin": () => policy.createScriptURL(`https://evil.example${worker}`),
      "the same origin written out": () => policy.createScriptURL(`${location.origin}${worker}`),
      "a protocol-relative address": () => policy.createScriptURL(`//evil.example${worker}`),
      "a blob: URL": () => policy.createScriptURL(URL.createObjectURL(new Blob(["postMessage(1)"]))),
      "a data: URL": () => policy.createScriptURL("data:text/javascript,postMessage(1)"),
      "a query string": () => policy.createScriptURL(`${worker}?v=1`),
      "a fragment": () => policy.createScriptURL(`${worker}#x`),
      "a path that walks up": () => policy.createScriptURL(worker.replace("/assets/", "/assets/../assets/")),
      "another built script": () => policy.createScriptURL(worker.replace("bayan-worker.js", "bayan_wasm.js")),
      "HTML text": () => policy.createHTML("<img src=x>"),
      "script text": () => policy.createScript("postMessage(1)"),
    };
    const results: Record<string, string> = {};
    for (const [what, attempt] of Object.entries(attempts)) {
      try {
        attempt();
        results[what] = "accepted";
      } catch (error) {
        results[what] = error instanceof Error ? error.name : String(error);
      }
    }
    results["the worker itself"] = String(policy.createScriptURL(worker)) === worker ? "accepted" : "changed";
    return results;
  });
  const expected = Object.fromEntries(Object.keys(outcomes).map((what) => [what, "TypeError"]));
  expected["the worker itself"] = "accepted";
  expect(outcomes).toEqual(expected);
});

test("no second policy can be created, and no worker can start from a plain string", async ({ page }) => {
  await page.goto("/");
  await waitForDocument(page);
  const outcomes = await page.evaluate(() => {
    const attempt = (run: () => unknown) => {
      try {
        run();
        return "allowed";
      } catch (error) {
        return error instanceof Error ? error.name : String(error);
      }
    };
    return {
      // Without 'allow-duplicates', the name is taken once the app has created its policy.
      sameName: attempt(() => trustedTypes.createPolicy("bayan-script-url", { createScriptURL: (url: string) => url })),
      otherName: attempt(() => trustedTypes.createPolicy("other", { createScriptURL: (url: string) => url })),
      stringWorker: attempt(() => new Worker("/third-party-licenses.txt", { type: "module" })),
    };
  });
  expect(outcomes).toEqual({ sameName: "TypeError", otherName: "TypeError", stringWorker: "TypeError" });
});

for (const file of ["bayan-worker.js", "bayan_wasm.js", "bayan_wasm_bg.wasm"]) {
  test(`a changed ${file} stops the engine before its worker starts`, async ({ page }) => {
    await watchPoliciesAndWorkers(page);
    await page.route(`**/assets/engine-*/${file}`, async (route) => {
      const response = await route.fetch();
      const body = Buffer.concat([await response.body(), Buffer.from(file.endsWith(".wasm") ? [0] : [10, 47, 47])]);
      await route.fulfill({ response, body });
    });
    await page.goto("/");
    await expect(page.locator(".document-view")).toHaveAttribute("data-engine-state", "failed");
    await expect(page.locator(".document-status")).toContainText("integrity check");
    expect(await page.evaluate(() => (globalThis as unknown as { __workers: string[] }).__workers)).toEqual([]);
  });
}

test("the worker's first message is init, with the engine module's SHA-384, which matches the module served (spec §14.8)", async ({
  page,
}) => {
  await watchInit(page);
  await page.goto("/");
  await waitForDocument(page);
  const init = await initMessage(page);
  // It is the first message the worker receives, and the only worker is the engine's: given any other message first, the worker host
  // would start without a hash and fetch the module unchecked.
  expect(await page.evaluate(() => (globalThis as unknown as { __firstMessages: unknown[] }).__firstMessages)).toEqual([
    { worker: "init", wasm_url: init.wasm_url, wasm_integrity: init.wasm_integrity },
  ]);
  expect(init.wasm_url).toMatch(/^\/assets\/engine-[0-9a-f]{16}\/bayan_wasm_bg\.wasm$/);
  const module = await page.request.get(init.wasm_url);
  expect(module.ok()).toBe(true);
  expect(init.wasm_integrity).toBe(
    `sha384-${createHash("sha384")
      .update(await module.body())
      .digest("base64")}`,
  );
});

for (const [what, integrity] of [
  ["a hash that the module does not match", `sha384-${createHash("sha384").update("another module").digest("base64")}`],
  ["metadata that names no hash the browser checks", "md5-q2Rv6NEtk7qX9kiv7GbH3A=="],
] as const) {
  test(`with ${what}, the engine module never runs: the engine does not start, and the user is told`, async ({
    page,
  }) => {
    await watchInit(page, integrity);
    await page.goto("/");
    await expect(page.locator(".document-view")).toHaveAttribute("data-engine-state", "failed", { timeout: 30_000 });
    // The worker host reported load_failed instead of ready; the app terminated its worker and says so in its live region.
    await expect(page.locator(".document-status")).toHaveText(
      "The engine could not be started. Reload the page to try again.",
    );
    await expect.poll(() => page.workers().length).toBe(0);
    await expect(page.getByTestId("a11y-mirror").getByRole("heading")).toHaveCount(0);
  });
}
