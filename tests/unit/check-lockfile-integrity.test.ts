import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkLockfileIntegrity, countPackages, type LockfileInput } from "../../scripts/check-lockfile-integrity.ts";

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

function repositoryInput(): LockfileInput {
  return { lockfile: read("pnpm-lock.yaml"), npmrc: read(".npmrc"), workspaceYaml: read("pnpm-workspace.yaml") };
}

/** This repository's lockfile with one change, which must be the only text it replaces. */
function withLockfile(search: string | RegExp, replacement: string | ((match: string) => string)): LockfileInput {
  const input = repositoryInput();
  const changed =
    typeof replacement === "string"
      ? input.lockfile.replace(search, replacement)
      : input.lockfile.replace(search, replacement);
  expect(changed).not.toEqual(input.lockfile);
  return { ...input, lockfile: changed };
}

/** A real entry of the lockfile: React's resolution line. */
const reactResolution = /( {2}react@19\.3\.0:\n {4}resolution: )\{integrity: sha512-[^}]+\}/;

/** The project's dependency on React in the importers section, in the block layout pnpm writes. */
const reactImporter = / {6}react:\n {8}specifier: 19\.3\.0\n {8}version: 19\.3\.0\n/;

/** The line that locks the project's React version. */
const reactVersion = /( {6}react:\n {8}specifier: 19\.3\.0\n)( {8}version: 19\.3\.0)\n/;

const unreadable = "cannot read the lockfile with certainty";

describe("lockfile integrity check", () => {
  it("accepts this repository's lockfile", () => {
    const input = repositoryInput();
    expect(checkLockfileIntegrity(input)).toEqual([]);
    expect(countPackages(input.lockfile)).toBeGreaterThan(100);
  });

  it("rejects a tarball source", () => {
    const input = withLockfile(
      reactResolution,
      "$1{integrity: sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==, tarball: https://example.org/react-19.3.0.tgz}",
    );
    expect(checkLockfileIntegrity(input)).toEqual([expect.stringContaining("react@19.3.0 resolves through tarball")]);
  });

  it("rejects a Git source", () => {
    const input = withLockfile(
      reactResolution,
      "$1{commit: 0123456789abcdef0123456789abcdef01234567, repo: https://github.com/facebook/react.git, type: git}",
    );
    expect(checkLockfileIntegrity(input)).toEqual([expect.stringContaining("resolves through commit, repo, type")]);
  });

  it("rejects a local folder or file", () => {
    const input = withLockfile(reactResolution, "$1{directory: ../react, type: directory}");
    expect(checkLockfileIntegrity(input)).toEqual([expect.stringContaining("resolves through directory, type")]);
    const key = withLockfile(/^ {2}react@19\.3\.0:$/m, "  'react@file:../react':");
    expect(checkLockfileIntegrity(key)).toEqual([
      expect.stringContaining("react@file:../react does not come from the registry"),
    ]);
    const plainKey = withLockfile(/^ {2}react@19\.3\.0:$/m, "  react@file:../react:");
    expect(checkLockfileIntegrity(plainKey)).not.toEqual([]);
  });

  it("rejects a weaker or missing hash", () => {
    const sha1 = withLockfile(reactResolution, "$1{integrity: sha1-2jmooF3LEcbAqrQZjBnKvKCN1+M=}");
    expect(checkLockfileIntegrity(sha1)).toEqual([expect.stringContaining("has no SHA-512 integrity hash")]);
    const none = withLockfile(reactResolution, "$1{}");
    expect(checkLockfileIntegrity(none)).toEqual([expect.stringContaining("has no SHA-512 integrity hash")]);
    const missing = withLockfile(/( {2}react@19\.3\.0:\n) {4}resolution: \{[^}]+\}\n/, "$1");
    expect(checkLockfileIntegrity(missing)).toEqual([expect.stringContaining("react@19.3.0 has no resolution")]);
  });

  it("rejects fields that only packages from elsewhere have", () => {
    for (const field of [
      "tarball: https://example.org/react.tgz",
      "id: react@https://example.org/react.tgz",
      "name: react",
    ]) {
      const input = withLockfile(reactResolution, `$&\n    ${field}`);
      expect(checkLockfileIntegrity(input)).toEqual([
        expect.stringContaining(`react@19.3.0 has the field "${field.split(":")[0]}"`),
      ]);
    }
  });

  it("rejects dependencies of the project that are not registry versions", () => {
    const link = withLockfile(reactVersion, "$1        version: link:../react\n");
    expect(checkLockfileIntegrity(link)).toEqual([expect.stringContaining('locked to "link:../react"')]);
    const git = withLockfile(
      reactVersion,
      "$1        version: https://codeload.github.com/facebook/react/tar.gz/0123456\n",
    );
    expect(checkLockfileIntegrity(git)).toEqual([expect.stringContaining("which is not a registry version")]);
    const peer = withLockfile(
      / {8}version: 1\.21\.1\(react-dom@19\.3\.0\(react@19\.3\.0\)\)\(react@19\.3\.0\)\n/,
      "        version: 1.21.1(react-dom@file:../react-dom)(react@19.3.0)\n",
    );
    expect(checkLockfileIntegrity(peer)).toEqual([expect.stringContaining("which is not a registry version")]);
  });

  it("accepts an npm alias of a registry version", () => {
    const input = withLockfile(reactVersion, "$1        version: react@19.3.0\n");
    expect(checkLockfileIntegrity(input)).toEqual([]);
  });

  it("rejects snapshot dependencies and overrides that are not registry versions", () => {
    const snapshot = withLockfile(/( {6}'@swc\/helpers': )0\.5\.23/, "$1file:../helpers");
    expect(checkLockfileIntegrity(snapshot)).toEqual([
      expect.stringContaining('@swc/helpers is locked to "file:../helpers"'),
    ]);
    const input = repositoryInput();
    const override = {
      ...input,
      lockfile: input.lockfile.replace("\nimporters:\n", "\noverrides:\n  react: link:../react\n\nimporters:\n"),
    };
    expect(checkLockfileIntegrity(override)).toEqual([expect.stringContaining("the override of react points to")]);
  });

  // pnpm reads every YAML layout, so these spellings of a dependency from elsewhere must fail as well. Each one passed the first
  // version of this check, which read the lockfile line by line, while pnpm installed what it pointed to.
  it("rejects a dependency from elsewhere in the {…} layout", () => {
    for (const version of ["'http://127.0.0.1:8765/react-19.3.0.tgz'", "'link:evil'", "'file:evil'"]) {
      const input = withLockfile(reactImporter, `      react: {specifier: 19.3.0, version: ${version}}\n`);
      expect(checkLockfileIntegrity(input)).toEqual([
        expect.stringContaining(`locked to ${JSON.stringify(version.slice(1, -1))}`),
      ]);
    }
    const sameAsBlock = withLockfile(reactImporter, "      react: {specifier: 19.3.0, version: 19.3.0}\n");
    expect(checkLockfileIntegrity(sameAsBlock)).toEqual([]);
  });

  it("refuses a section, an entry or a key in a layout pnpm does not write", () => {
    const flowSection = withLockfile(
      "\nsnapshots:\n",
      "\noverrides: {react: {specifier: 19.3.0, version: 'http://127.0.0.1:8765/react.tgz'}}\n\nsnapshots:\n",
    );
    expect(checkLockfileIntegrity(flowSection)).toEqual([expect.stringContaining(unreadable)]);
    const deeper = withLockfile(reactResolution, (entry) => entry.replace("    resolution:", "      resolution:"));
    expect(checkLockfileIntegrity(deeper)).toEqual([expect.stringContaining("indentation")]);
    const fourSpaces = withLockfile(/^ {2}react@19\.3\.0:\n {4}resolution:/m, "    react@19.3.0:\n        resolution:");
    expect(checkLockfileIntegrity(fourSpaces)).toEqual([expect.stringContaining("indentation")]);
    const spaceBeforeColon = withLockfile(reactVersion, "$1        version : link:evil\n");
    expect(checkLockfileIntegrity(spaceBeforeColon)).toEqual([expect.stringContaining(unreadable)]);
    const twice = withLockfile(reactResolution, "$&\n    resolution: {integrity: sha512-x}");
    expect(checkLockfileIntegrity(twice)).toEqual([expect.stringContaining('"resolution" appears twice')]);
  });

  it("refuses the YAML features pnpm does not use", () => {
    const variants = [
      "$1        version: &v 19.3.0\n", // anchor
      "$1        version: *v\n", // alias
      "$1        version: !!str 19.3.0\n", // tag
      '$1        version: "19.3.0"\n', // double quotes
      "$1        version: |\n          19.3.0\n", // block text
      "$1        ? version\n        : 19.3.0\n", // explicit key
      "$1        version: 19.3.0 # pinned\n", // comment after a value
      "$1        version:\t19.3.0\n", // tab
      "$1        version: 19.3.0 \n", // trailing space
      "$1        version: 19.3.0 \n", // a character outside printable ASCII
      "$1        version: '19.3.0\n", // text that does not end
      "$1        version:\n", // a key without a value
      "$1        null: 19.3.0\n        version: 19.3.0\n", // a key YAML reads as null
      "$1        - 19.3.0\n", // a list where a mapping continues
    ];
    for (const variant of variants) {
      const input = withLockfile(reactVersion, variant);
      expect(checkLockfileIntegrity(input), variant).toEqual([expect.stringContaining(unreadable)]);
    }
    const documentEnd = withLockfile("\nsettings:\n", "\n...\nsettings:\n");
    expect(checkLockfileIntegrity(documentEnd)).toEqual([expect.stringContaining(unreadable)]);
    const inlineDocument = withLockfile(
      /^---\nlockfileVersion: '9\.0'\n\nsettings:/m,
      "--- {lockfileVersion: '9.0'}\n\nsettings:",
    );
    expect(checkLockfileIntegrity(inlineDocument)).not.toEqual([]);
  });

  it("rejects another registry, however it is written", () => {
    const input = repositoryInput();
    const npmrc = (line: string) => checkLockfileIntegrity({ ...input, npmrc: `${input.npmrc}${line}\n` });
    expect(npmrc("registry=https://registry.example.org/")).toEqual([expect.stringContaining(".npmrc line")]);
    expect(npmrc("@bayandocs:registry=https://npm.example.org/")).toEqual([
      expect.stringContaining("@bayandocs:registry=https://npm.example.org/"),
    ]);
    expect(npmrc("REGISTRY = https://registry.example.org/")).toEqual([expect.stringContaining(".npmrc line")]);
    expect(npmrc("registry=https://registry.npmjs.org/")).toEqual([]);
    const workspace = (text: string) =>
      checkLockfileIntegrity({ ...input, workspaceYaml: `${input.workspaceYaml}${text}` });
    expect(workspace("\nregistries:\n  default: https://registry.example.org/\n").join("\n")).toContain(
      "pnpm-workspace.yaml line",
    );
    expect(workspace('\n"registry": https://registry.example.org/\n')).toEqual([
      expect.stringContaining("pnpm-workspace.yaml line"),
    ]);
    const explicitKey = workspace("\n? registry\n: https://registry.example.org/\n");
    expect(explicitKey.length).toBeGreaterThan(0);
    expect(explicitKey.every((problem) => problem.startsWith("pnpm-workspace.yaml line"))).toBe(true);
    expect(workspace("\nregistry: https://registry.npmjs.org/\n")).toEqual([]);
    expect(workspace("\n# Packages come only from the npm registry.\n")).toEqual([]);
  });

  it("refuses what it cannot read with certainty", () => {
    const version = withLockfile(/^lockfileVersion: '9\.0'$/m, "lockfileVersion: '10.0'");
    expect(checkLockfileIntegrity(version).join("\n")).toContain("is not '9.0'");
    const unquoted = withLockfile(/^lockfileVersion: '9\.0'$/m, "lockfileVersion: 9.0");
    expect(checkLockfileIntegrity(unquoted).join("\n")).toContain("is not '9.0'");
    const section = withLockfile("\nsnapshots:\n", "\nsurprise:\n  anything: here\n\nsnapshots:\n");
    expect(checkLockfileIntegrity(section).join("\n")).toContain('unknown section "surprise"');
    const comment = withLockfile("\nsettings:\n", "\n# a comment\nsettings:\n");
    expect(checkLockfileIntegrity(comment).join("\n")).toContain("comments are not part of the lockfile format");
    expect(checkLockfileIntegrity({ ...repositoryInput(), lockfile: "" })).toEqual(["pnpm-lock.yaml is empty."]);
  });

  it("checks pnpm's own entry in the first document too", () => {
    const input = withLockfile(
      /( {2}'@pnpm\/exe\.linux-x64@12\.9\.0':\n {4}resolution: )\{integrity: sha512-[^}]+\}/,
      "$1{tarball: https://example.org/pnpm.tgz}",
    );
    expect(checkLockfileIntegrity(input)).toEqual([
      expect.stringContaining("@pnpm/exe.linux-x64@12.9.0 resolves through tarball"),
    ]);
  });
});
