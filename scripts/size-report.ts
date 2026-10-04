// Reports the size of the production build, raw and compressed (gzip and Brotli, as a web server would send it),
// and fails if the compressed total exceeds the budget. WEB-001 sets 300 KB for the skeleton; PERF-06 caps the full app at 5 MB.
//
// Usage: node scripts/size-report.ts <dist-directory>

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

/** Compressed-size budget in bytes (1 KB = 1000 bytes, as in the requirements). */
export const budgetBytes = 300_000;

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
  const total = compressedTotal(sizes);
  console.log(
    `Total compressed (gzip): ${(total / 1000).toFixed(1)} KB; budget ${(budgetBytes / 1000).toFixed(0)} KB.`,
  );
  if (total > budgetBytes) {
    throw new Error("the production bundle exceeds its size budget.");
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
