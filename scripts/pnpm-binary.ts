// Finds and checks pnpm's native binary for scripts/dev-setup.sh, using only the pins already in the repository.
//
// package.json "packageManager" pins the pnpm version (pnpm@x.y.z+sha512.<hex>). pnpm-lock.yaml records the same version under
// packageManagerDependencies and, in its first YAML document, the sha512 integrity of each platform's @pnpm/exe.<target> package,
// whose tarball contains the native pnpm executable. Corepack is not used: Node.js 25 and later no longer ship it, and it only
// checks pnpm's small JavaScript wrapper, while the 60 MB native binary that does the work was downloaded on first use and checked
// only against the npm registry's signature.
//
// Usage (from the repository root):
//   node scripts/pnpm-binary.ts plan <target>               prints "<version> <tarball-url> <integrity>"
//   node scripts/pnpm-binary.ts verify <file> <integrity>   exits 0 only when the file's sha512 equals the integrity
// where <target> is linux-x64, darwin-arm64 or darwin-x64.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const supportedTargets: readonly string[] = ["linux-x64", "darwin-arm64", "darwin-x64"];

export interface PnpmBinaryPin {
  version: string;
  url: string;
  integrity: string;
}

/** The lockfile's first YAML document; pnpm 12 records the package manager itself there. */
function firstYamlDocument(lockfile: string): string {
  return lockfile.split(/^---[ \t]*$/m).find((document) => document.trim() !== "") ?? "";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Reads which pnpm binary this machine needs and the sha512 the lockfile pins for it. Throws when anything is missing or inconsistent. */
export function pnpmBinaryPin(packageManager: unknown, lockfile: string, target: string): PnpmBinaryPin {
  if (!supportedTargets.includes(target)) {
    throw new Error(`no pinned pnpm build for ${JSON.stringify(target)}; supported: ${supportedTargets.join(", ")}.`);
  }
  const pinned =
    typeof packageManager === "string" ? /^pnpm@(\d+\.\d+\.\d+)\+sha512\.[0-9a-f]{128}$/.exec(packageManager) : null;
  const version = pinned?.[1];
  if (version === undefined) {
    throw new Error('package.json "packageManager" must pin pnpm as pnpm@x.y.z+sha512.<hex>.');
  }

  const document = firstYamlDocument(lockfile);
  const locked =
    /^ {4}packageManagerDependencies:\r?\n {6}pnpm:\r?\n {8}specifier: (\S+)\r?\n {8}version: (\S+)$/m.exec(document);
  if (locked === null) {
    throw new Error("pnpm-lock.yaml does not record pnpm under packageManagerDependencies.");
  }
  if (locked[1] !== version || locked[2] !== version) {
    throw new Error(`pnpm-lock.yaml pins pnpm ${locked[2]}, but package.json "packageManager" pins ${version}.`);
  }

  const name = `@pnpm/exe.${target}`;
  const entry = new RegExp(
    `^ {2}'${escapeRegExp(`${name}@${version}`)}':\\r?\\n {4}resolution: \\{integrity: (sha512-[A-Za-z0-9+/]{86}==)\\}$`,
    "m",
  ).exec(document);
  const integrity = entry?.[1];
  if (integrity === undefined) {
    throw new Error(`pnpm-lock.yaml has no sha512 integrity for ${name}@${version}.`);
  }
  return { version, url: `https://registry.npmjs.org/${name}/-/exe.${target}-${version}.tgz`, integrity };
}

/** The integrity string npm and pnpm use for a file: "sha512-" followed by its SHA-512 in base64. */
export function sha512Integrity(data: Uint8Array): string {
  return `sha512-${createHash("sha512").update(data).digest("base64")}`;
}

function main(args: readonly string[]): void {
  const [command, first, second] = args;
  if (command === "plan" && first !== undefined && second === undefined) {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { packageManager?: unknown };
    const pin = pnpmBinaryPin(packageJson.packageManager, readFileSync(resolve("pnpm-lock.yaml"), "utf8"), first);
    console.log(`${pin.version} ${pin.url} ${pin.integrity}`);
    return;
  }
  if (command === "verify" && first !== undefined && second !== undefined) {
    const actual = sha512Integrity(readFileSync(first));
    if (actual !== second) {
      throw new Error(`checksum mismatch: expected ${second}, got ${actual}.`);
    }
    return;
  }
  throw new Error("usage: node scripts/pnpm-binary.ts plan <target> | verify <file> <integrity>");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`pnpm-binary: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
