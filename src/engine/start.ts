// Starts the engine's worker after checking the integrity of every file it will run (WEB-002's integrity plan).
//
// Browsers check Subresource Integrity only where a page asks for it, and nothing lets a page ask for it on a worker: new Worker() takes
// no integrity, and Integrity-Policy covers only the "script" and "style" request destinations, not "worker"; Chromium, Firefox and
// WebKit load the worker, the glue it imports and the module without any check under our headers (the WEB-002 report shows the
// experiment). So the app checks the engine's three files itself before it starts the worker: it fetches each with the
// SHA-384 hash that the build wrote into the app's own bundle (virtual:bayan-engine), which index.html loads with an integrity hash, so
// the trust runs index.html → bundle → engine files. fetch() rejects a file whose bytes differ, and the worker is then never started.
// The files live in a content-addressed folder that is cached immutably, so the worker's own requests are normally answered from the
// cache entries these checks just filled; that the browser does not bind the two is the remaining gap (docs/spikes/WEB-002-report.md).

import { engineFiles } from "virtual:bayan-engine";
import { workerScriptUrl } from "../security/script-url-policy.ts";
import type { EngineFileEntry } from "./engine-manifest.ts";
import type { WorkerInit } from "./protocol.ts";

/** The engine's files did not pass their integrity check, or could not be fetched; the worker was not started. */
export class EngineIntegrityError extends Error {
  override readonly name = "EngineIntegrityError";
}

/** Fetches every file with its integrity hash and reads it completely; rejects with EngineIntegrityError if any does not match. */
export async function verifyEngineFiles(
  files: readonly EngineFileEntry[] = [engineFiles.worker, engineFiles.glue, engineFiles.wasm],
  fetcher: typeof fetch = fetch,
): Promise<void> {
  await Promise.all(
    files.map(async (file) => {
      try {
        const response = await fetcher(file.url, {
          integrity: file.integrity,
          mode: "same-origin",
          credentials: "same-origin",
          // The cache's copy is what the worker will load next, so that is the copy to check.
          cache: "default",
        });
        if (!response.ok) throw new Error(String(response.status));
        await response.arrayBuffer();
      } catch {
        throw new EngineIntegrityError("An engine file failed its integrity check or could not be loaded.");
      }
    }),
  );
}

/** Checks the engine's files, then starts the worker through the bayan-script-url policy and tells it where the module is. */
export async function startEngineWorker(): Promise<Worker> {
  await verifyEngineFiles();
  // new Worker() accepts a TrustedScriptURL under Trusted Types; TypeScript's DOM types know only strings and URLs.
  const worker = new Worker(workerScriptUrl(engineFiles.worker.url) as string, {
    type: "module",
    name: "bayan-engine",
  });
  const init: WorkerInit = { worker: "init", wasm_url: engineFiles.wasm.url };
  worker.postMessage(init);
  return worker;
}
