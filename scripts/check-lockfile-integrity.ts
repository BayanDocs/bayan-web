// Checks that every package in pnpm-lock.yaml comes from the npm registry with a SHA-512 integrity hash, and from nowhere else
// (ADR-0017, pnpm row: "a lockfile-integrity script in place of lockfile-lint", which does not read pnpm's lockfile; work package X-003).
// `pnpm verify` runs it right after the policy check, and it needs nothing but Node.js.
//
// It fails when:
//   - a package's resolution is anything but `{integrity: sha512-…}`: a tarball address, a Git repository, a local folder or file, or a weaker hash;
//   - a package, snapshot or importer entry has a version that is not a registry version (`file:`, `link:`, `git+…`, `https://…`, …);
//   - an override points somewhere other than a registry version;
//   - .npmrc or pnpm-workspace.yaml names a registry other than https://registry.npmjs.org/;
//   - the lockfile has a format or a section this check does not know, so that a new kind of entry cannot slip past unread.
// pnpm-lock.yaml holds two YAML documents (pnpm itself in the first, the project's packages in the second); both are checked.
//
// Usage: node scripts/check-lockfile-integrity.ts   (run from the repository root)

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The only registry packages may come from. */
export const npmRegistry = "https://registry.npmjs.org/";

/** The lockfile format this check understands. */
const lockfileVersion = "'9.0'";

/** The sections a pnpm 9.0 lockfile document may have. Packages are read from `packages`, `snapshots` and `importers`. */
const knownSections = new Set([
  "lockfileVersion",
  "settings",
  "importers",
  "packages",
  "snapshots",
  "overrides",
  "catalogs",
  "patchedDependencies",
  "pnpmfileChecksum",
  "packageExtensionsChecksum",
  "ignoredOptionalDependencies",
  "time",
]);

/** A registry version: major.minor.patch, with an optional pre-release and build part. */
const registryVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** A SHA-512 integrity hash: 64 bytes in base64. */
const sha512Integrity = /^sha512-[A-Za-z0-9+/]{86}==$/;

export interface LockfileInput {
  lockfile: string;
  npmrc: string;
  workspaceYaml: string;
}

/** The version part of a lockfile key such as `'@scope/name@1.2.3'` or `name@1.2.3(peer@4.5.6)`, or the whole text after the name if it is not one. */
function keyVersion(key: string): { name: string; version: string } {
  const withoutPeers = key.split("(", 1)[0] ?? key;
  const at = withoutPeers.lastIndexOf("@");
  if (at <= 0) return { name: withoutPeers, version: "" };
  return { name: withoutPeers.slice(0, at), version: withoutPeers.slice(at + 1) };
}

/** The key of a mapping line such as `  'name@1.0.0':` or `  name@1.0.0: {}`, without its quotes, and what follows the colon. */
function mappingKey(line: string): { key: string; rest: string } | undefined {
  const text = line.trim();
  const quoted = /^(['"])(.*?)\1:(.*)$/.exec(text);
  if (quoted) return { key: quoted[2] ?? "", rest: (quoted[3] ?? "").trim() };
  const plain = /^([^\s'"{][^\s]*?):(?:\s+(.*))?$/.exec(text);
  if (plain) return { key: plain[1] ?? "", rest: (plain[2] ?? "").trim() };
  return undefined;
}

/** The fields of a one-line YAML flow mapping such as `{integrity: sha512-…}`, or undefined if the text is not one. */
function flowMapping(text: string): Map<string, string> | undefined {
  const inner = /^\{(.*)\}$/.exec(text.trim())?.[1];
  if (inner === undefined || /[{}[\]]/.test(inner)) return undefined;
  const fields = new Map<string, string>();
  for (const part of inner.split(",")) {
    if (part.trim() === "") continue;
    const colon = part.indexOf(":");
    if (colon < 0) return undefined;
    fields.set(
      part.slice(0, colon).trim(),
      part
        .slice(colon + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/, "$2"),
    );
  }
  return fields;
}

/** How far a line is indented, in spaces. */
function indentation(line: string): number {
  return line.length - line.trimStart().length;
}

/** A version value as pnpm writes it in importers and dependency lists: a registry version, optionally followed by peer suffixes. */
function isRegistryReference(value: string): boolean {
  const unquoted = value.replace(/^(['"])(.*)\1$/, "$2");
  return registryVersion.test(unquoted.split("(", 1)[0] ?? "");
}

function checkDocument(lines: string[], firstLine: number, problems: string[]): void {
  let section = "";
  let currentPackage: { key: string; line: number; resolutions: number } | undefined;
  const finishPackage = () => {
    if (currentPackage && currentPackage.resolutions !== 1) {
      problems.push(
        `pnpm-lock.yaml line ${currentPackage.line}: ${currentPackage.key} has ${currentPackage.resolutions} resolutions, not exactly one.`,
      );
    }
    currentPackage = undefined;
  };
  let sawVersion = false;
  lines.forEach((line, index) => {
    const number = firstLine + index;
    if (line.trim() === "") return;
    if (/^\s*#/.test(line)) {
      problems.push(
        `pnpm-lock.yaml line ${number}: comments are not part of the lockfile format; regenerate the file with pnpm.`,
      );
      return;
    }
    const depth = indentation(line);
    if (depth === 0) {
      finishPackage();
      const top = /^([A-Za-z][\w-]*):(.*)$/.exec(line);
      if (!top) {
        problems.push(`pnpm-lock.yaml line ${number}: cannot read ${JSON.stringify(line)}.`);
        return;
      }
      section = top[1] ?? "";
      if (!knownSections.has(section)) {
        problems.push(
          `pnpm-lock.yaml line ${number}: unknown section "${section}"; review what it means before teaching scripts/check-lockfile-integrity.ts about it.`,
        );
      }
      if (section === "lockfileVersion") {
        sawVersion = true;
        if ((top[2] ?? "").trim() !== lockfileVersion) {
          problems.push(
            `pnpm-lock.yaml line ${number}: lockfile version ${(top[2] ?? "").trim()} is not ${lockfileVersion}, the format this check reads.`,
          );
        }
      }
      return;
    }
    if (section === "packages" || section === "snapshots") {
      if (depth === 2) {
        finishPackage();
        const entry = mappingKey(line);
        if (!entry) {
          problems.push(
            `pnpm-lock.yaml line ${number}: cannot read the ${section} entry ${JSON.stringify(line.trim())}.`,
          );
          return;
        }
        const { name, version } = keyVersion(entry.key);
        if (!registryVersion.test(version)) {
          problems.push(
            `pnpm-lock.yaml line ${number}: ${entry.key} does not come from the registry (version ${JSON.stringify(version)}); only registry versions are allowed, no tarball, Git or file sources.`,
          );
        } else if (name === "") {
          problems.push(`pnpm-lock.yaml line ${number}: ${entry.key} has no package name.`);
        }
        if (section === "packages") {
          currentPackage = { key: entry.key, line: number, resolutions: 0 };
        }
        return;
      }
      if (section === "packages" && depth === 4 && currentPackage) {
        const field = mappingKey(line);
        if (field?.key !== "resolution") return;
        currentPackage.resolutions += 1;
        const resolution = flowMapping(field.rest);
        const integrity = resolution?.get("integrity");
        if (!resolution) {
          problems.push(
            `pnpm-lock.yaml line ${number}: cannot read the resolution of ${currentPackage.key}: ${field.rest}`,
          );
        } else if ([...resolution.keys()].some((key) => key !== "integrity")) {
          problems.push(
            `pnpm-lock.yaml line ${number}: ${currentPackage.key} resolves through ${[...resolution.keys()].filter((key) => key !== "integrity").join(", ")}; packages must come from the npm registry with only an integrity hash (no tarball, Git or file sources).`,
          );
        } else if (integrity === undefined || !sha512Integrity.test(integrity)) {
          problems.push(
            `pnpm-lock.yaml line ${number}: ${currentPackage.key} has no SHA-512 integrity hash (found ${JSON.stringify(integrity ?? "nothing")}).`,
          );
        }
        return;
      }
      if (section === "snapshots" && depth >= 6) {
        // A dependency of a snapshot: `name: version`, where the version must be a registry version.
        const dependency = mappingKey(line);
        if (dependency && dependency.rest !== "" && !isRegistryReference(dependency.rest)) {
          problems.push(
            `pnpm-lock.yaml line ${number}: ${dependency.key} is locked to ${JSON.stringify(dependency.rest)}, which is not a registry version.`,
          );
        }
      }
      return;
    }
    if (section === "importers") {
      const field = mappingKey(line);
      if (field?.key === "version" && !isRegistryReference(field.rest)) {
        problems.push(
          `pnpm-lock.yaml line ${number}: a dependency of the project is locked to ${JSON.stringify(field.rest)}, which is not a registry version (no link:, file:, Git or tarball dependencies).`,
        );
      }
      return;
    }
    if (section === "overrides") {
      const override = mappingKey(line);
      if (override && override.rest !== "" && !isRegistryReference(override.rest)) {
        problems.push(
          `pnpm-lock.yaml line ${number}: the override of ${override.key} points to ${JSON.stringify(override.rest)}, which is not a registry version.`,
        );
      }
    }
  });
  finishPackage();
  if (!sawVersion) {
    problems.push(`pnpm-lock.yaml: a YAML document starting at line ${firstLine} has no lockfileVersion.`);
  }
}

/** Registries named in .npmrc (`registry=…`, `@scope:registry=…`) and pnpm-workspace.yaml (`registry:`, `registries:`), other than the npm registry. */
function checkRegistries(input: LockfileInput, problems: string[]): void {
  for (const line of input.npmrc.split(/\r?\n/)) {
    const setting = /^\s*((?:@[^:\s]+:)?registry)\s*=\s*(.*?)\s*$/i.exec(line);
    if (setting && setting[2] !== npmRegistry) {
      problems.push(
        `.npmrc sets ${setting[1]} to ${JSON.stringify(setting[2])}; packages come only from ${npmRegistry}.`,
      );
    }
  }
  for (const line of input.workspaceYaml.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const setting = /^(registry|registries)\s*:\s*(.*?)\s*$/.exec(line);
    if (setting && !(setting[1] === "registry" && setting[2]?.replace(/^(['"])(.*)\1$/, "$2") === npmRegistry)) {
      problems.push(
        `pnpm-workspace.yaml sets ${setting[1]}${setting[2] ? ` to ${JSON.stringify(setting[2])}` : ""}; packages come only from ${npmRegistry}.`,
      );
    }
  }
}

/** Returns every problem found; an empty list means every package comes from the npm registry with a SHA-512 hash. */
export function checkLockfileIntegrity(input: LockfileInput): string[] {
  const problems: string[] = [];
  const lines = input.lockfile.split(/\r?\n/);
  let start = 0;
  let documents = 0;
  for (let index = 0; index <= lines.length; index += 1) {
    if (index === lines.length || lines[index]?.trimEnd() === "---") {
      const document = lines.slice(start, index);
      if (document.some((line) => line.trim() !== "")) {
        documents += 1;
        checkDocument(document, start + 1, problems);
      }
      start = index + 1;
    }
  }
  if (documents === 0) {
    problems.push("pnpm-lock.yaml is empty.");
  }
  checkRegistries(input, problems);
  return problems;
}

/** How many entries of each kind the lockfile has, for the success message. */
export function countPackages(lockfile: string): number {
  return (lockfile.match(/^ {4}resolution: /gm) ?? []).length;
}

function main(): void {
  const read = (file: string) => readFileSync(resolve(file), "utf8");
  const lockfile = read("pnpm-lock.yaml");
  const problems = checkLockfileIntegrity({
    lockfile,
    npmrc: read(".npmrc"),
    workspaceYaml: read("pnpm-workspace.yaml"),
  });
  if (problems.length > 0) {
    console.error(`Lockfile integrity check failed (ADR-0017):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(
    `Lockfile integrity check passed: all ${countPackages(lockfile)} packages in pnpm-lock.yaml come from ${npmRegistry} with a SHA-512 integrity hash.`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
