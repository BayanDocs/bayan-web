// Checks that every package in pnpm-lock.yaml comes from the npm registry with a SHA-512 integrity hash, and from nowhere else
// (ADR-0017, pnpm row: "a lockfile-integrity script in place of lockfile-lint", which does not read pnpm's lockfile; work package X-003).
// `pnpm verify` runs it right after the policy check, and it needs nothing but Node.js.
//
// It works in two steps. First a strict reader turns each YAML document of the lockfile into mappings, lists and text. YAML can write
// the same data in many layouts, and pnpm reads them all, so a check that understood only the usual layout could be handed a lockfile
// that pnpm reads differently (a tarball address written in `{…}` style, a key indented by four spaces, `version : link:…`). The reader
// therefore accepts only the layout pnpm itself writes: two spaces per level, plain or single-quoted text, `{…}` and `[…]` on one line
// without nesting, `- item` lists, printable ASCII. Anything else (comments, anchors, aliases, tags, double quotes, multi-line text,
// explicit keys, duplicate keys, other indentation, tabs) makes the check fail as unreadable instead of being guessed at.
// Then it checks what it read, and fails when:
//   - a package's resolution is anything but `{integrity: sha512-…}`: a tarball address, a Git repository, a local folder or file, or a weaker hash;
//   - a package, snapshot, importer, catalog or dependency entry has a version that is not a registry version (`file:`, `link:`, `git+…`, `https://…`, …);
//   - an override points somewhere other than a registry version;
//   - .npmrc or pnpm-workspace.yaml has any registry setting other than `registry` set to https://registry.npmjs.org/;
//   - the lockfile has a format, a section or a field this check does not know, so that a new kind of entry cannot slip past unread.
// pnpm-lock.yaml holds two YAML documents (pnpm itself in the first, the project's packages in the second); both are checked.
//
// Usage: node scripts/check-lockfile-integrity.ts   (run from the repository root)

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The only registry packages may come from. */
export const npmRegistry = "https://registry.npmjs.org/";

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
  "configDependencies",
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

/** A registry version: major.minor.patch, with an optional pre-release and build part. */
const registryVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** An npm package name, with or without a scope. */
const packageName = /^(?:@[A-Za-z0-9~-][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~-][A-Za-z0-9._~-]*$/;

/** A SHA-512 integrity hash: 64 bytes in base64. */
const sha512Integrity = /^sha512-[A-Za-z0-9+/]{86}==$/;

export interface LockfileInput {
  lockfile: string;
  npmrc: string;
  workspaceYaml: string;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The strict reader

interface Text {
  kind: "text";
  value: string;
  quoted: boolean;
  line: number;
}
interface Mapping {
  kind: "mapping";
  entries: Map<string, Node>;
  line: number;
}
interface List {
  kind: "list";
  items: Node[];
  line: number;
}
type Node = Text | Mapping | List;

/** A line the reader does not accept. */
class Unreadable extends Error {
  readonly line: number;
  constructor(line: number, message: string) {
    super(message);
    this.line = line;
  }
}

/** A plain (unquoted) key as pnpm writes it: `.`, a field name, a package name, or a package key such as `name@1.2.3(peer@4.5.6)`. */
const plainKey = /^(?:\.|[A-Za-z0-9_][A-Za-z0-9._~()@/+-]*)$/;

/** Plain text that YAML reads as something other than text (null, a boolean, a number or a date); pnpm quotes such keys. */
const yamlNonText = [
  /^(?:null|Null|NULL|~|true|True|TRUE|false|False|FALSE)$/,
  /^[-+]?(?:0|[1-9][0-9_]*)$/,
  /^[-+]?0(?:b[01_]+|o?[0-7_]+|x[0-9a-fA-F_]+)$/,
  /^[-+]?(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9_]+)(?:[eE][-+]?[0-9]+)?$/,
  /^[-+]?\.(?:inf|Inf|INF)$|^\.(?:nan|NaN|NAN)$/,
  /^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}/,
];

/** Characters that may not start plain text, because YAML gives them a meaning there. */
const indicators = new Set([..."-?:,[]{}#&*!|>'\"%@`"]);

function quotedText(text: string, start: number, line: number): { value: string; end: number } {
  let value = "";
  let index = start + 1;
  for (;;) {
    const quote = text.indexOf("'", index);
    if (quote < 0) throw new Unreadable(line, "text in single quotes does not end on its line");
    value += text.slice(index, quote);
    if (text[quote + 1] !== "'") return { value, end: quote + 1 };
    value += "'";
    index = quote + 2;
  }
}

function checkPlainKey(key: string, line: number): void {
  if (!plainKey.test(key) || yamlNonText.some((pattern) => pattern.test(key))) {
    throw new Unreadable(line, `${JSON.stringify(key)} is not a key as pnpm writes one`);
  }
}

function checkPlainText(text: string, line: number, inFlow: boolean): void {
  if (
    text === "" ||
    indicators.has(text[0] ?? "") ||
    text.includes(": ") ||
    text.includes(" #") ||
    text.endsWith(":") ||
    text.endsWith(" ") ||
    /[{}[\]]/.test(text) ||
    (inFlow && text.includes(","))
  ) {
    throw new Unreadable(line, `${JSON.stringify(text)} is not plain text as pnpm writes it`);
  }
}

/** One `{key: value, …}` or `[value, …]` on one line, without nesting. */
function flowCollection(text: string, line: number): Mapping | List {
  const mapping = text[0] === "{";
  const close = mapping ? "}" : "]";
  const entries = new Map<string, Node>();
  const items: Node[] = [];
  const done = (end: number): Mapping | List => {
    if (end !== text.length) throw new Unreadable(line, `unexpected text after ${close}`);
    return mapping ? { kind: "mapping", entries, line } : { kind: "list", items, line };
  };
  let index = 1;
  if (text[index] === close) return done(index + 1);
  const scalar = (): Text => {
    if (text[index] === "'") {
      const quoted = quotedText(text, index, line);
      index = quoted.end;
      return { kind: "text", value: quoted.value, quoted: true, line };
    }
    let end = index;
    while (end < text.length && text[end] !== "," && text[end] !== close) end += 1;
    const plain = text.slice(index, end);
    checkPlainText(plain, line, true);
    index = end;
    return { kind: "text", value: plain, quoted: false, line };
  };
  for (;;) {
    if (mapping) {
      let key: string;
      if (text[index] === "'") {
        const quoted = quotedText(text, index, line);
        key = quoted.value;
        index = quoted.end;
      } else {
        const colon = text.indexOf(":", index);
        if (colon < 0) throw new Unreadable(line, "a {…} entry has no key");
        key = text.slice(index, colon);
        checkPlainKey(key, line);
        index = colon;
      }
      if (text.slice(index, index + 2) !== ": ") throw new Unreadable(line, "a {…} key is not followed by ': '");
      index += 2;
      if (entries.has(key)) throw new Unreadable(line, `${JSON.stringify(key)} appears twice`);
      entries.set(key, scalar());
    } else {
      items.push(scalar());
    }
    if (text[index] === close) return done(index + 1);
    if (text.slice(index, index + 2) !== ", ") throw new Unreadable(line, `expected ', ' or ${close}`);
    index += 2;
  }
}

/** The value after `key: ` or `- `. */
function value(text: string, line: number): Node {
  if (text[0] === "{" || text[0] === "[") return flowCollection(text, line);
  if (text[0] === "'") {
    const quoted = quotedText(text, 0, line);
    if (quoted.end !== text.length) throw new Unreadable(line, "unexpected text after the closing quote");
    return { kind: "text", value: quoted.value, quoted: true, line };
  }
  checkPlainText(text, line, false);
  return { kind: "text", value: text, quoted: false, line };
}

/** Reads one YAML document, given as numbered lines. */
function readDocument(lines: { number: number; text: string }[]): Mapping {
  const root: Mapping = { kind: "mapping", entries: new Map(), line: lines[0]?.number ?? 1 };
  // A block whose children are written `indent` spaces in; `node` stays undefined until its first child shows whether it is a mapping or a list.
  interface Block {
    indent: number;
    node: Mapping | List | undefined;
    owner?: { mapping: Mapping; key: string; line: number };
  }
  const blocks: Block[] = [{ indent: 0, node: root }];
  const close = (block: Block) => {
    if (block.node === undefined && block.owner) {
      throw new Unreadable(block.owner.line, `${JSON.stringify(block.owner.key)} has no value`);
    }
  };
  for (const { number, text } of lines) {
    if (text === "") continue;
    if (/[^\x20-\x7e]/.test(text))
      throw new Unreadable(number, "the line has a tab or a character outside printable ASCII");
    if (text.endsWith(" ")) throw new Unreadable(number, "the line ends with a space");
    const content = text.trimStart();
    const indent = text.length - content.length;
    let block = blocks[blocks.length - 1];
    while (block !== undefined && indent < block.indent) {
      close(block);
      blocks.pop();
      block = blocks[blocks.length - 1];
    }
    if (block === undefined || indent !== block.indent) {
      throw new Unreadable(number, "the indentation is not two spaces deeper than the line it belongs to");
    }
    if (content.startsWith("#")) throw new Unreadable(number, "comments are not part of the lockfile format");
    const listItem = content.startsWith("- ");
    if (block.node === undefined && block.owner) {
      block.node = listItem
        ? { kind: "list", items: [], line: number }
        : { kind: "mapping", entries: new Map(), line: number };
      block.owner.mapping.entries.set(block.owner.key, block.node);
    }
    const node = block.node;
    if (node === undefined) throw new Unreadable(number, "unexpected line");
    if (node.kind === "list") {
      if (!listItem) throw new Unreadable(number, "a mapping entry where the list continues");
      node.items.push(value(content.slice(2), number));
      continue;
    }
    if (listItem) throw new Unreadable(number, "a list item where a mapping entry belongs");
    let key: string;
    let index: number;
    if (content[0] === "'") {
      const quoted = quotedText(content, 0, number);
      key = quoted.value;
      index = quoted.end;
    } else {
      index = content.indexOf(":");
      if (index < 0) throw new Unreadable(number, "the line is not `key: value`");
      key = content.slice(0, index);
      checkPlainKey(key, number);
    }
    if (content[index] !== ":") throw new Unreadable(number, "the key is not followed by ':'");
    if (node.entries.has(key)) throw new Unreadable(number, `${JSON.stringify(key)} appears twice`);
    if (index + 1 === content.length) {
      blocks.push({ indent: indent + 2, node: undefined, owner: { mapping: node, key, line: number } });
      continue;
    }
    if (content[index + 1] !== " " || content[index + 2] === " ") {
      throw new Unreadable(number, "the key is not followed by ': ' and a value");
    }
    node.entries.set(key, value(content.slice(index + 2), number));
  }
  for (const block of blocks.reverse()) close(block);
  return root;
}

/** Splits the lockfile into its YAML documents and reads each; a document that cannot be read becomes a problem instead. */
function readDocuments(lockfile: string, problems: string[]): Mapping[] {
  const lines = lockfile.split(/\r?\n/);
  const documents: Mapping[] = [];
  let current: { number: number; text: string }[] = [];
  const finish = () => {
    if (current.some((line) => line.text !== "")) {
      try {
        documents.push(readDocument(current));
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

function describe(node: Node | undefined): string {
  if (node === undefined) return "nothing";
  if (node.kind === "text") return JSON.stringify(node.value);
  return node.kind === "mapping" ? "a mapping" : "a list";
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

/** Any registry setting in .npmrc or pnpm-workspace.yaml other than `registry` set to the npm registry, in whatever form it is written. */
function checkRegistries(input: LockfileInput, problems: string[]): void {
  input.npmrc.split(/\r?\n/).forEach((line, index) => {
    const text = line.trim();
    if (text === "" || text.startsWith("#") || text.startsWith(";") || !/registr/i.test(text)) return;
    if (/^registry\s*=\s*https:\/\/registry\.npmjs\.org\/$/.test(text)) return;
    problems.push(
      `.npmrc line ${index + 1} has the registry setting ${JSON.stringify(text)}; packages come only from ${npmRegistry}, so the only registry setting allowed is registry=${npmRegistry}.`,
    );
  });
  input.workspaceYaml.split(/\r?\n/).forEach((line, index) => {
    const text = line.trim();
    if (text === "" || text.startsWith("#") || !/registr/i.test(text)) return;
    if (/^registry: (['"]?)https:\/\/registry\.npmjs\.org\/\1$/.test(line)) return;
    problems.push(
      `pnpm-workspace.yaml line ${index + 1} has the registry setting ${JSON.stringify(text)}; packages come only from ${npmRegistry}, so the only registry setting allowed is "registry: ${npmRegistry}" (move a comment that mentions registries to a line of its own).`,
    );
  });
}

/** Returns every problem found; an empty list means every package comes from the npm registry with a SHA-512 hash. */
export function checkLockfileIntegrity(input: LockfileInput): string[] {
  const problems: string[] = [];
  const documents = readDocuments(input.lockfile, problems);
  if (documents.length === 0 && problems.length === 0) problems.push("pnpm-lock.yaml is empty.");
  const checker = new Checker(problems);
  for (const document of documents) checker.document(document);
  checkRegistries(input, problems);
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
