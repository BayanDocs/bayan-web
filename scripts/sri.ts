// Adds Subresource Integrity (SRI) hashes to the built index.html: every <script src> and every stylesheet or preload <link> gets
// integrity="sha384-…" and crossorigin, so the browser refuses a file whose content changed after the build. Vite cannot do this itself.
// Production servers send `Integrity-Policy: blocked-destinations=(script)`, which blocks any script without such a hash; so this step
// also fails the build if the output contains an inline script or a JavaScript file that index.html does not load with a hash
// (for example a lazily imported chunk, which cannot carry integrity without an inline import map that our CSP forbids).
//
// Usage: node scripts/sri.ts <dist-directory>
// The input is our own build output, not untrusted data, so a careful regular-expression scan of the tags Vite emits is sufficient.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function sriHash(content: Uint8Array): string {
  return `sha384-${createHash("sha384").update(content).digest("base64")}`;
}

const integrityLinkRels = new Set(["stylesheet", "modulepreload", "preload"]);

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag);
  return match?.[1];
}

/** Turns a URL path from index.html into a path inside the build directory, refusing anything that is not a same-origin file. */
function localAssetPath(url: string): string {
  if (!url.startsWith("/") || url.startsWith("//") || url.includes("..") || /[?#]/.test(url)) {
    throw new Error(`Refusing to hash ${JSON.stringify(url)}: only same-origin absolute paths are allowed.`);
  }
  return url.slice(1);
}

export interface SriResult {
  html: string;
  /** Build-relative paths of the files that received an integrity hash, with "/" separators. */
  hashed: string[];
}

/**
 * Adds integrity and crossorigin attributes to index.html.
 * `readAsset` returns the bytes of a file given its build-relative path.
 */
export function addIntegrity(html: string, readAsset: (path: string) => Uint8Array): SriResult {
  const hashed: string[] = [];

  const withScripts = html.replace(/<script\b[^>]*>/gi, (tag) => {
    const src = attribute(tag, "src");
    if (src === undefined) {
      throw new Error("index.html contains an inline <script>; the Content Security Policy forbids inline scripts.");
    }
    return hashTag(tag, src);
  });

  const withLinks = withScripts.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = attribute(tag, "rel")?.toLowerCase();
    const href = attribute(tag, "href");
    if (rel === undefined || href === undefined || !integrityLinkRels.has(rel)) {
      return tag;
    }
    return hashTag(tag, href);
  });

  function hashTag(tag: string, url: string): string {
    if (attribute(tag, "integrity") !== undefined) {
      throw new Error(`${url} already has an integrity attribute; run this step exactly once per build.`);
    }
    const path = localAssetPath(url);
    hashed.push(path);
    const crossorigin = /\scrossorigin\b/i.test(tag) ? "" : " crossorigin";
    const close = tag.endsWith("/>") ? "/>" : ">";
    return `${tag.slice(0, -close.length).trimEnd()} integrity="${sriHash(readAsset(path))}"${crossorigin}${close}`;
  }

  return { html: withLinks, hashed };
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"));
}

/** JavaScript files in the build that index.html does not load with an integrity hash; Integrity-Policy would block them. */
export function unhashedScripts(files: readonly string[], hashed: readonly string[]): string[] {
  const covered = new Set(hashed);
  return files.filter((file) => /\.m?js$/.test(file) && !covered.has(file));
}

function main(distArg: string | undefined): void {
  if (distArg === undefined) {
    throw new Error("Usage: node scripts/sri.ts <dist-directory>");
  }
  const dist = resolve(distArg);
  const indexPath = join(dist, "index.html");
  const result = addIntegrity(readFileSync(indexPath, "utf8"), (path) => readFileSync(join(dist, path)));
  const missing = unhashedScripts(listFiles(dist), result.hashed);
  if (missing.length > 0) {
    throw new Error(
      `These scripts would be blocked by Integrity-Policy because index.html does not load them with a hash: ${missing.join(", ")}`,
    );
  }
  writeFileSync(indexPath, result.html);
  console.log(`SRI: added sha384 integrity to ${result.hashed.length} file(s): ${result.hashed.join(", ")}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv[2]);
  } catch (error) {
    console.error(`SRI step failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
