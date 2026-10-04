// Checks the third-party licence notices that `vite build` writes (build.license in vite.config.ts) before a build is accepted.
// MIT, Apache-2.0 and similar licences require their notices whenever the code is redistributed, and every page load redistributes
// the bundle. Vite copies each bundled package's licence text into the file, but it does not include Apache-2.0 NOTICE files,
// which section 4(d) of that licence requires us to reproduce. So this check fails when any bundled package has no licence text
// or ships a NOTICE file; if that happens, add the notice deliberately before changing this check.
//
// Usage: node scripts/check-licenses.ts <dist-directory>   (run from the repository root)

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const licenseFileName = "third-party-licenses.txt";

export interface BundledPackage {
  name: string;
  version: string;
  /** The SPDX identifier from the package's package.json, when it has one. */
  identifier: string | undefined;
  /** The full licence text Vite copied from the package; empty when the package has no licence file. */
  text: string;
}

// Vite writes one "## <name> - <version> (<identifier>)" heading per package. Licence texts can contain Markdown headings of their
// own (for example "## MIT License"), so only a heading with this exact shape starts a new package.
const packageHeading =
  /^## (@?[a-z0-9][a-z0-9._~-]*(?:\/[a-z0-9][a-z0-9._~-]*)?) - (\d+\.\d+\.\d+[0-9A-Za-z.+-]*)(?: \((.+)\))?$/;

/** Parses the licence file Vite writes for a build. */
export function parseLicenseFile(content: string): BundledPackage[] {
  const packages: BundledPackage[] = [];
  let lines: string[] = [];
  const finish = () => {
    const last = packages.at(-1);
    if (last !== undefined) last.text = lines.join("\n").trim();
    lines = [];
  };
  for (const line of content.split(/\r?\n/)) {
    const heading = packageHeading.exec(line);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      finish();
      packages.push({ name: heading[1], version: heading[2], identifier: heading[3], text: "" });
    } else {
      lines.push(line);
    }
  }
  finish();
  return packages;
}

/**
 * The installed directories of a package in pnpm's store (node_modules/.pnpm). Store directories are named
 * "<name>@<version>", with "/" in scoped names written as "+", and may carry peer-dependency suffixes after "_".
 */
export function packageDirectories(storeDir: string, name: string, version: string): string[] {
  const prefix = `${name.replace("/", "+")}@${version}`;
  return readdirSync(storeDir)
    .filter((entry) => entry === prefix || entry.startsWith(`${prefix}_`))
    .map((entry) => join(storeDir, entry, "node_modules", name))
    .filter((directory) => existsSync(join(directory, "package.json")));
}

/** NOTICE files at the top of a package directory (NOTICE, NOTICE.txt, Notice.md, NOTICES and so on). */
export function noticeFiles(packageDir: string): string[] {
  return readdirSync(packageDir).filter((file) => /^notices?(\.[A-Za-z0-9]+)?$/i.test(file));
}

/** Returns the problems with a build's licence notices; an empty list means they are complete. */
export function checkLicenses(packages: readonly BundledPackage[], storeDir: string): string[] {
  if (packages.length === 0) {
    return [
      `${licenseFileName} lists no bundled packages, but the app bundles React; the file may be missing or malformed.`,
    ];
  }
  const problems: string[] = [];
  for (const { name, version, text } of packages) {
    const id = `${name}@${version}`;
    if (text === "") {
      problems.push(`${id} has no licence text in ${licenseFileName}.`);
    }
    const directories = packageDirectories(storeDir, name, version);
    if (directories.length === 0) {
      problems.push(`${id} is not installed in ${storeDir}, so its NOTICE files cannot be checked.`);
    }
    for (const directory of directories) {
      for (const notice of noticeFiles(directory)) {
        problems.push(
          `${id} ships ${notice}, which must be reproduced with the app (Apache-2.0 section 4(d)); Vite does not include it.`,
        );
      }
    }
  }
  return problems;
}

function main(distArg: string | undefined): void {
  if (distArg === undefined) {
    throw new Error("usage: node scripts/check-licenses.ts <dist-directory>");
  }
  const file = join(resolve(distArg), licenseFileName);
  if (!existsSync(file)) {
    throw new Error(`${file} is missing; vite.config.ts must set build.license.`);
  }
  const packages = parseLicenseFile(readFileSync(file, "utf8"));
  const problems = checkLicenses(packages, resolve("node_modules/.pnpm"));
  if (problems.length > 0) {
    throw new Error(`licence notices are incomplete:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  console.log(
    `Licences: ${packages.length} bundled packages, each with its licence text in ${licenseFileName}; no NOTICE files.`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv[2]);
  } catch (error) {
    console.error(`Licence check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
