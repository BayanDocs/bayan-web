// Reports the size of the production build, raw and compressed (gzip and Brotli, as a web server would send it), and fails if a
// compressed total exceeds its budget. Three budgets, in compressed bytes:
// - the app itself (everything but the engine): 300 KB, the budget WEB-001 set for the skeleton, unchanged;
// - the engine's WebAssembly package with its licence notices (WEB-002, config/engine-files.ts): 300 KB, about a quarter above the
//   mock engine of CORE-007, so that growth is noticed; the work package that brings the real engine sets its own;
// - everything together: 5 MB, the cap PERF-06 sets for the web app's download (fonts excluded; there are none yet).
// Every file in the build counts, licence notices included, although the browser downloads those only when someone opens them.
//
// Usage: node scripts/size-report.ts <dist-directory>

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

/** Compressed-size budget of the app itself, in bytes (1 KB = 1000 bytes, as in the requirements): WEB-001's skeleton budget. */
export const budgetBytes = 300_000;

/** Compressed-size budget of the engine's WebAssembly package and its licence notices (WEB-002). */
export const engineBudgetBytes = 300_000;

/** Compressed-size cap of the whole build: PERF-06's 5 MB for the web app's initial download, fonts excluded. */
export const totalBudgetBytes = 5_000_000;

/** Whether a build-relative path belongs to the engine package: its runtime folder or its licence notices (config/engine-files.ts). */
export function isEngineFile(path: string): boolean {
  return /^assets\/engine-[0-9a-f]{16}\//.test(path) || path.startsWith("engine-licenses/");
}

export interface FileSize {
  path: string;
  raw: number;
  gzip: number;
  brotli: number;
}

export function measure(path: string, content: Uint8Array): FileSize {
  return {
    path,
    raw: content.byteLength,
    gzip: gzipSync(content, { level: 9 }).byteLength,
    brotli: brotliCompressSync(content, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength,
  };
}

/** The total a browser downloads with gzip, the most widely supported (and larger) of the two encodings. */
export function compressedTotal(sizes: readonly FileSize[]): number {
  return sizes.reduce((sum, size) => sum + size.gzip, 0);
}

function kb(bytes: number): string {
  return `${(bytes / 1000).toFixed(1)} KB`.padStart(10);
}

function main(distArg: string | undefined): void {
  if (distArg === undefined) {
    throw new Error("Usage: node scripts/size-report.ts <dist-directory>");
  }
  const dist = resolve(distArg);
  const sizes = readdirSync(dist, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
    .map((file) => measure(relative(dist, file).split(sep).join("/"), readFileSync(file)));

  console.log(`${"file".padEnd(40)}${"raw".padStart(10)}${"gzip".padStart(10)}${"brotli".padStart(10)}`);
  for (const size of sizes) {
    console.log(`${size.path.padEnd(40)}${kb(size.raw)}${kb(size.gzip)}${kb(size.brotli)}`);
  }
  const groups = [
    {
      name: "App (without the engine)",
      total: compressedTotal(sizes.filter((size) => !isEngineFile(size.path))),
      budget: budgetBytes,
    },
    {
      name: "Engine package",
      total: compressedTotal(sizes.filter((size) => isEngineFile(size.path))),
      budget: engineBudgetBytes,
    },
    { name: "Everything", total: compressedTotal(sizes), budget: totalBudgetBytes },
  ];
  for (const group of groups) {
    console.log(
      `${group.name}, compressed (gzip): ${(group.total / 1000).toFixed(1)} KB; budget ${(group.budget / 1000).toFixed(0)} KB.`,
    );
  }
  const over = groups.filter((group) => group.total > group.budget).map((group) => group.name);
  if (over.length > 0) {
    throw new Error(`the production build exceeds its size budget: ${over.join(", ")}.`);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv[2]);
  } catch (error) {
    console.error(`Size report failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
