// Checks that every package in pnpm-lock.yaml comes from the npm registry with a SHA-512 integrity hash, and from nowhere else
// (ADR-0017, pnpm row: "a lockfile-integrity script in place of lockfile-lint", which does not read pnpm's lockfile; work package X-003).
// `pnpm verify` runs it right after the policy check, and it needs nothing but Node.js.
//
// It works in two steps. First the strict reader of scripts/strict-yaml.ts turns each YAML document of the lockfile into mappings, lists
// and text, accepting only the layout pnpm writes and refusing anything else as unreadable, so that the lockfile cannot mean one thing to
// pnpm and another to this check (the reader explains why). Then it checks what it read, and fails when:
//   - a package's resolution is anything but `{integrity: sha512-…}`: a tarball address, a Git repository, a local folder or file, or a weaker hash;
//   - a package, snapshot, importer, catalog or dependency entry has a version that is not a registry version (`file:`, `link:`, `git+…`, `https://…`, …);
//   - an override points somewhere other than a registry version;
//   - the lockfile has a format, a section or a field this check does not know, so that a new kind of entry cannot slip past unread;
//   - pnpm ran a pnpmfile (`pnpmfileChecksum`) or installed configuration dependencies (`configDependencies`), or the repository has a
//     pnpmfile: their hooks can change pnpm's registry and the packages it installs, which neither `pnpm config list` nor this check sees;
//   - .npmrc has a registry setting other than `registry=https://registry.npmjs.org/`, or pnpm-workspace.yaml does not pass the strict
//     reading of its settings in scripts/pnpm-settings.ts (which allows no registry but npm's).
// pnpm-lock.yaml holds two YAML documents (pnpm itself in the first, the project's packages in the second); both are checked.
//
// Usage: node scripts/check-lockfile-integrity.ts   (run from the repository root)

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkWorkspaceSettings, npmRegistry, packageName, registryVersion } from "./pnpm-settings.ts";
import { describe, type Mapping, type Node, type NumberedLine, readDocument, Unreadable } from "./strict-yaml.ts";

export { npmRegistry };

/** The lockfile format this check understands. */
const lockfileVersion = "9.0";

/** The sections a pnpm 9.0 lockfile document may have. */
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

/** The fields of an importer (the project, or pnpm itself in the first document) that list its dependencies. */
const importerFields = new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "packageManagerDependencies",
]);

/** The fields a `packages` entry may have. Others, such as `tarball`, `id`, `name` or `version`, appear only for packages that do not come from the registry. */
const packageFields = new Set([
  "resolution",
  "engines",
  "cpu",
  "os",
  "libc",
  "hasBin",
  "deprecated",
  "peerDependencies",
  "peerDependenciesMeta",
  "bundledDependencies",
]);

/** The fields a `snapshots` entry may have. */
const snapshotFields = new Set(["dependencies", "optionalDependencies", "transitivePeerDependencies", "optional"]);

/** A SHA-512 integrity hash: 64 bytes in base64. */
const sha512Integrity = /^sha512-[A-Za-z0-9+/]{86}==$/;

/** Why a pnpmfile or configuration dependencies are refused; a reviewed work package may change this. */
const hookWarning =
  "their hooks can change pnpm's settings (its registry, for one) and the packages it installs, and neither `pnpm config list` nor this check sees what they do. This repository uses none; adding one needs an approved work package that teaches this check about it";

export interface LockfileInput {
  lockfile: string;
  npmrc: string;
  workspaceYaml: string;
  /** The names of the files and folders in the repository's top folder. */
  rootFiles: readonly string[];
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Reading

/** Splits the lockfile into its YAML documents and reads each; a document that cannot be read becomes a problem instead. */
function readDocuments(lockfile: string, problems: string[]): Mapping[] {
  const lines = lockfile.split(/\r?\n/);
  const documents: Mapping[] = [];
  let current: NumberedLine[] = [];
  const finish = () => {
    if (current.some((line) => line.text !== "")) {
      try {
        documents.push(readDocument(current, { commentLines: false }));
      } catch (error) {
        if (!(error instanceof Unreadable)) throw error;
        problems.push(
          `pnpm-lock.yaml line ${error.line}: cannot read the lockfile with certainty (${error.message}). This check reads only the layout pnpm writes; regenerate the file with pnpm, or, if pnpm itself wrote it, teach scripts/check-lockfile-integrity.ts the new layout, with a test.`,
        );
      }
    }
    current = [];
  };
  lines.forEach((text, index) => {
    if (text === "---") finish();
    else current.push({ number: index + 1, text });
  });
  finish();
  return documents;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The checks

/** Reads a registry reference such as `1.2.3` or `1.2.3(peer@4.5.6(other@7.8.9))(more@1.0.0)` at `start`; returns the index after it, or -1. */
function readReference(text: string, start: number): number {
  let index = start;
  while (index < text.length && /[0-9A-Za-z.+-]/.test(text[index] ?? "")) index += 1;
  if (!registryVersion.test(text.slice(start, index))) return -1;
  while (text[index] === "(") {
    const end = readPackageReference(text, index + 1);
    if (end < 0 || text[end] !== ")") return -1;
    index = end + 1;
  }
  return index;
}

/** Reads `name@reference` at `start` (a scoped name starts with `@`, so the separator is the first `@` after it); returns the index after it, or -1. */
function readPackageReference(text: string, start: number): number {
  const at = text.indexOf("@", start + 1);
  if (at < 0 || !packageName.test(text.slice(start, at))) return -1;
  return readReference(text, at + 1);
}

/** A version as pnpm writes it for a dependency: a registry version with optional peer suffixes, or `name@version` for an npm alias. */
function isRegistryReference(version: string): boolean {
  return readReference(version, 0) === version.length || readPackageReference(version, 0) === version.length;
}

class Checker {
  readonly problems: string[];
  constructor(problems: string[]) {
    this.problems = problems;
  }

  problem(line: number, message: string): void {
    this.problems.push(`pnpm-lock.yaml line ${line}: ${message}`);
  }

  /** The entries of a mapping, or none (and a problem) if the node is something else. */
  mapping(node: Node | undefined, what: string, line: number): [string, Node][] {
    if (node?.kind === "mapping") return [...node.entries];
    this.problem(node?.line ?? line, `${what} should be a mapping, not ${describe(node)}.`);
    return [];
  }

  text(node: Node | undefined, what: string, line: number): string | undefined {
    if (node?.kind === "text") return node.value;
    this.problem(node?.line ?? line, `${what} should be text, not ${describe(node)}.`);
    return undefined;
  }

  texts(node: Node | undefined, what: string, line: number): void {
    if (node?.kind !== "list") {
      this.problem(node?.line ?? line, `${what} should be a list, not ${describe(node)}.`);
      return;
    }
    for (const item of node.items) this.text(item, `an item of ${what}`, node.line);
  }

  /** A mapping from package names to registry versions, as in a snapshot's dependencies. */
  dependencyVersions(node: Node | undefined, what: string, line: number): void {
    for (const [name, version] of this.mapping(node, what, line)) {
      const text = this.text(version, `the version of ${name} in ${what}`, line);
      if (!packageName.test(name))
        this.problem(version.line, `${JSON.stringify(name)} in ${what} is not a package name.`);
      if (text !== undefined && !isRegistryReference(text)) {
        this.problem(
          version.line,
          `${name} is locked to ${JSON.stringify(text)}, which is not a registry version (no link:, file:, Git or tarball sources).`,
        );
      }
    }
  }

  /** Dependencies as importers and catalogs list them: `name: {specifier: …, version: …}`. */
  specifiedDependencies(node: Node | undefined, what: string, line: number): void {
    for (const [name, dependency] of this.mapping(node, what, line)) {
      if (!packageName.test(name))
        this.problem(dependency.line, `${JSON.stringify(name)} in ${what} is not a package name.`);
      const fields = this.mapping(dependency, `${name} in ${what}`, line);
      const keys = fields.map(([key]) => key).sort();
      if (keys.join(",") !== "specifier,version") {
        this.problem(
          dependency.line,
          `${name} in ${what} has the fields ${keys.join(", ") || "none"}, not exactly specifier and version.`,
        );
      }
      const entry = new Map(fields);
      this.text(entry.get("specifier"), `the specifier of ${name}`, dependency.line);
      const version = this.text(entry.get("version"), `the version of ${name}`, dependency.line);
      if (version !== undefined && !isRegistryReference(version)) {
        this.problem(
          entry.get("version")?.line ?? dependency.line,
          `a dependency of the project, ${name}, is locked to ${JSON.stringify(version)}, which is not a registry version (no link:, file:, Git or tarball dependencies).`,
        );
      }
    }
  }

  importers(node: Node, line: number): void {
    for (const [path, importer] of this.mapping(node, "importers", line)) {
      for (const [field, dependencies] of this.mapping(importer, `the importer ${path}`, line)) {
        if (field === "configDependencies") {
          // pnpm 12.9.0 writes `configDependencies: {}` in its own document; any entry is refused.
          if (dependencies.kind !== "mapping" || dependencies.entries.size > 0) {
            this.problem(
              dependencies.line,
              `the importer ${path} has configDependencies, which pnpm installs before everything else and which can bring pnpmfile hooks: ${hookWarning}.`,
            );
          }
          continue;
        }
        if (!importerFields.has(field)) {
          this.problem(
            dependencies.line,
            `the importer ${path} has the field "${field}", which this check does not know; review what it means before teaching scripts/check-lockfile-integrity.ts about it.`,
          );
          continue;
        }
        this.specifiedDependencies(dependencies, `the ${field} of ${path}`, line);
      }
    }
  }

  packages(node: Node, line: number): number {
    const entries = this.mapping(node, "packages", line);
    for (const [key, entry] of entries) {
      const at = key.indexOf("@", 1);
      if (at < 0 || !packageName.test(key.slice(0, at)) || !registryVersion.test(key.slice(at + 1))) {
        this.problem(
          entry.line,
          `${key} does not come from the registry; only registry versions (name@1.2.3) are allowed, no tarball, Git or file sources.`,
        );
      }
      const fields = new Map(this.mapping(entry, key, entry.line));
      for (const [field, fieldValue] of fields) {
        if (!packageFields.has(field)) {
          this.problem(
            fieldValue.line,
            `${key} has the field "${field}", which this check does not know (packages from the registry have none); review what it means before teaching scripts/check-lockfile-integrity.ts about it.`,
          );
        }
      }
      for (const [field, fieldValue] of fields) {
        const what = `${field} of ${key}`;
        if (field === "cpu" || field === "os" || field === "libc" || field === "bundledDependencies") {
          this.texts(fieldValue, what, entry.line);
        } else if (field === "engines" || field === "peerDependencies") {
          for (const [name, text] of this.mapping(fieldValue, what, entry.line))
            this.text(text, `${name} in ${what}`, entry.line);
        } else if (field === "peerDependenciesMeta") {
          for (const [name, meta] of this.mapping(fieldValue, what, entry.line)) {
            for (const [flag, text] of this.mapping(meta, `${name} in ${what}`, entry.line)) {
              this.text(text, `${flag} of ${name} in ${what}`, entry.line);
            }
          }
        } else if (field === "hasBin" || field === "deprecated") {
          this.text(fieldValue, what, entry.line);
        }
      }
      const resolution = fields.get("resolution");
      if (resolution === undefined) {
        this.problem(entry.line, `${key} has no resolution.`);
        continue;
      }
      const resolutionFields = this.mapping(resolution, `the resolution of ${key}`, entry.line);
      const others = resolutionFields.map(([field]) => field).filter((field) => field !== "integrity");
      const integrity = resolutionFields.find(([field]) => field === "integrity")?.[1];
      if (others.length > 0) {
        this.problem(
          resolution.line,
          `${key} resolves through ${others.join(", ")}; packages must come from the npm registry with only an integrity hash (no tarball, Git or file sources).`,
        );
      } else if (integrity?.kind !== "text" || !sha512Integrity.test(integrity.value)) {
        this.problem(resolution.line, `${key} has no SHA-512 integrity hash (found ${describe(integrity)}).`);
      }
    }
    return entries.length;
  }

  snapshots(node: Node, line: number): void {
    for (const [key, entry] of this.mapping(node, "snapshots", line)) {
      if (readPackageReference(key, 0) !== key.length) {
        this.problem(
          entry.line,
          `${key} does not come from the registry; only registry versions (name@1.2.3, with peer suffixes) are allowed, no tarball, Git or file sources.`,
        );
      }
      for (const [field, fieldValue] of this.mapping(entry, key, entry.line)) {
        if (!snapshotFields.has(field)) {
          this.problem(
            fieldValue.line,
            `${key} has the field "${field}", which this check does not know; review what it means before teaching scripts/check-lockfile-integrity.ts about it.`,
          );
        } else if (field === "dependencies" || field === "optionalDependencies") {
          this.dependencyVersions(fieldValue, `the ${field} of ${key}`, entry.line);
        } else if (field === "transitivePeerDependencies") {
          this.texts(fieldValue, `${field} of ${key}`, entry.line);
        } else {
          this.text(fieldValue, `${field} of ${key}`, entry.line);
        }
      }
    }
  }

  overrides(node: Node, line: number): void {
    for (const [selector, override] of this.mapping(node, "overrides", line)) {
      const text = this.text(override, `the override of ${selector}`, line);
      if (text !== undefined && !registryVersion.test(text)) {
        this.problem(
          override.line,
          `the override of ${selector} points to ${JSON.stringify(text)}, which is not a registry version.`,
        );
      }
    }
  }

  /** Checks one document; returns how many packages it lists. */
  document(document: Mapping): number {
    let packages = 0;
    for (const [section, node] of document.entries) {
      if (!knownSections.has(section)) {
        this.problem(
          node.line,
          `unknown section "${section}"; review what it means before teaching scripts/check-lockfile-integrity.ts about it.`,
        );
        continue;
      }
      switch (section) {
        case "lockfileVersion":
          if (node.kind !== "text" || !node.quoted || node.value !== lockfileVersion) {
            this.problem(
              node.line,
              `lockfile version ${describe(node)} is not '${lockfileVersion}', the format this check reads.`,
            );
          }
          break;
        case "settings":
          for (const [name, setting] of this.mapping(node, "settings", node.line)) {
            this.text(setting, `the setting ${name}`, node.line);
          }
          break;
        case "importers":
          this.importers(node, node.line);
          break;
        case "packages":
          packages += this.packages(node, node.line);
          break;
        case "snapshots":
          this.snapshots(node, node.line);
          break;
        case "overrides":
          this.overrides(node, node.line);
          break;
        case "catalogs":
          for (const [catalog, entries] of this.mapping(node, "catalogs", node.line)) {
            this.specifiedDependencies(entries, `the catalog ${catalog}`, node.line);
          }
          break;
        case "time":
          for (const [key, time] of this.mapping(node, "time", node.line))
            this.text(time, `the time of ${key}`, node.line);
          break;
        case "ignoredOptionalDependencies":
          this.texts(node, section, node.line);
          break;
        case "pnpmfileChecksum":
          this.problem(
            node.line,
            `pnpm ran a pnpmfile when it wrote this lockfile (pnpmfileChecksum): ${hookWarning}.`,
          );
          break;
        case "packageExtensionsChecksum":
          this.text(node, section, node.line);
          break;
        default:
          // patchedDependencies: patch files are part of the repository and reviewed there; they do not change where a package comes from.
          this.mapping(node, section, node.line);
      }
    }
    if (!document.entries.has("lockfileVersion")) {
      this.problem(document.line, "a YAML document of the lockfile has no lockfileVersion.");
    }
    return packages;
  }
}

/**
 * The settings that decide where packages come from, besides the lockfile: any registry setting in .npmrc other than `registry` set to npm's
 * registry (pnpm 12 reads registry and authentication settings there), and pnpm-workspace.yaml, read strictly by scripts/pnpm-settings.ts,
 * which allows no registry but npm's and no setting it does not know.
 */
function checkSettings(input: LockfileInput, problems: string[]): void {
  input.npmrc.split(/\r?\n/).forEach((line, index) => {
    const text = line.trim();
    if (text === "" || text.startsWith("#") || text.startsWith(";") || !/registr/i.test(text)) return;
    if (/^registry\s*=\s*https:\/\/registry\.npmjs\.org\/$/.test(text)) return;
    problems.push(
      `.npmrc line ${index + 1} has the registry setting ${JSON.stringify(text)}; packages come only from ${npmRegistry}, so the only registry setting allowed is registry=${npmRegistry}.`,
    );
  });
  problems.push(...checkWorkspaceSettings(input.workspaceYaml).problems);
}

/** A pnpmfile in the repository's top folder, where pnpm 12 loads `.pnpmfile.cjs` and `.pnpmfile.mjs` from (any name with "pnpmfile" fails). */
function checkPnpmfiles(input: LockfileInput, problems: string[]): void {
  for (const name of input.rootFiles) {
    if (/pnpmfile/i.test(name))
      problems.push(`${name}: pnpm loads a pnpmfile from the repository's top folder, and ${hookWarning}.`);
  }
}

/** Returns every problem found; an empty list means every package comes from the npm registry with a SHA-512 hash. */
export function checkLockfileIntegrity(input: LockfileInput): string[] {
  const problems: string[] = [];
  const documents = readDocuments(input.lockfile, problems);
  if (documents.length === 0 && problems.length === 0) problems.push("pnpm-lock.yaml is empty.");
  const checker = new Checker(problems);
  for (const document of documents) checker.document(document);
  checkSettings(input, problems);
  checkPnpmfiles(input, problems);
  return problems;
}

/** How many packages the lockfile lists, in all its documents, for the success message. */
export function countPackages(lockfile: string): number {
  const ignored: string[] = [];
  const checker = new Checker(ignored);
  return readDocuments(lockfile, ignored).reduce((sum, document) => sum + checker.document(document), 0);
}

function main(): void {
  const read = (file: string) => readFileSync(resolve(file), "utf8");
  const lockfile = read("pnpm-lock.yaml");
  const problems = checkLockfileIntegrity({
    lockfile,
    npmrc: read(".npmrc"),
    workspaceYaml: read("pnpm-workspace.yaml"),
    rootFiles: readdirSync(resolve(".")),
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
