import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  auditExceptions,
  checkEffectiveAudit,
  checkEffectiveSettings,
  checkNpmrc,
  checkWorkspaceSettings,
} from "../../scripts/pnpm-settings.ts";
import { recordedPnpmConfig } from "./fixtures/pnpm-config.ts";

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

const workspace = read("pnpm-workspace.yaml");
const withWorkspace = (text: string) => checkWorkspaceSettings(`${workspace}${text}`).problems;
const unreadable = "cannot read the file with certainty";

describe("pnpm-workspace.yaml, read strictly", () => {
  it("accepts this repository's settings", () => {
    expect(checkWorkspaceSettings(workspace).problems).toEqual([]);
    expect(auditExceptions(checkWorkspaceSettings(workspace).settings)).toEqual([]);
  });

  // The review of X-003 found that each of these single lines changed what pnpm 12.9.0 applies (`pnpm config list --json`) while the
  // line-by-line checks passed. Double quotes allow escapes such as \x74, so the strict reader refuses them.
  it("refuses settings in double quotes, with or without escapes", () => {
    for (const line of [
      '"dangerouslyAllowAllBuilds": true',
      '"minimumReleaseAgeExclude": ["react"]',
      '"ignoreScripts": true',
      '"trustPolicyExclude": ["react"]',
      '"regis\\x74ry": "https://npm.mirror.invalid/"',
      '"audit\\x43onfig": {"ignore\\x47hsas": ["\\x47HSA-35jh-r3h4-6jhm", "\\x47HSA-r5fr-rjxr-66jc"]}',
    ]) {
      expect(withWorkspace(`${line}\n`), line).toEqual([expect.stringContaining(unreadable)]);
    }
  });

  it("refuses the settings that bypass the policy, however plainly they are written", () => {
    for (const [text, reason] of [
      ["ignoreScripts: true", "hides dependency build scripts"],
      ["minimumReleaseAgeExclude:\n  - react", "bypasses the 24-hour minimum age"],
      ["dangerouslyAllowAllBuilds: true", "lets every dependency run install scripts"],
      ["trustPolicyExclude:\n  - react@19.3.0", "exempts packages from trustPolicy"],
      ["onlyBuiltDependencies:\n  - esbuild", "lets the packages it names run install scripts"],
      ["auditLevel: critical", "hides advisories below the level"],
      ["configDependencies:\n  pnpm-plugin-x: 1.0.0+sha512-abc", "can bring pnpmfile hooks"],
      ["pnpmfile: other.cjs", "a pnpmfile's hooks"],
    ] as const) {
      expect(withWorkspace(`\n${text}\n`), text).toEqual([expect.stringContaining(reason)]);
    }
  });

  it("refuses a setting it does not know", () => {
    expect(withWorkspace("\npackageExtensions:\n  foo:\n    dependencies:\n      bar: 1.0.0\n")).toEqual([
      expect.stringContaining('"packageExtensions" is not a setting the checks know'),
    ]);
    expect(withWorkspace("\n'@acme:registry': https://npm.mirror.invalid/\n")).toEqual([
      expect.stringContaining("without quotes"),
      expect.stringContaining('"@acme:registry" is not a setting the checks know'),
    ]);
  });

  it("refuses layouts and YAML features pnpm would read differently or that the reader does not know", () => {
    for (const text of [
      "? registry\n: https://npm.mirror.invalid/", // explicit key
      "registry: &r https://npm.mirror.invalid/", // anchor
      "<<: {registry: https://npm.mirror.invalid/}", // merge key
      "registry: !!str https://registry.npmjs.org/", // tag
      "minimumReleaseAge: 1440", // the same setting twice
      "registry: |\n  https://npm.mirror.invalid/", // block text
      "---\nregistry: https://npm.mirror.invalid/", // a second document
      "overrides:\n    lodash: 4.17.21", // four spaces
      "registry: https://registry.npmjs.org/ # npm", // a comment after a value
      "registry:\thttps://registry.npmjs.org/", // a tab
      "# a comment with a character outside ASCII: \u0085registry: https://npm.mirror.invalid/", // NEL, a line break in YAML 1.1
    ]) {
      expect(withWorkspace(`\n${text}\n`), text).toEqual([expect.stringContaining(unreadable)]);
    }
  });

  it("requires every safety setting, with the value the policy requires", () => {
    for (const line of ["minimumReleaseAge: 1440", "strictDepBuilds: true", "trustPolicy: no-downgrade"]) {
      const problems = checkWorkspaceSettings(workspace.replace(line, `# ${line}`)).problems;
      expect(problems).toEqual([`pnpm-workspace.yaml must contain "${line}".`]);
    }
    for (const [line, weakened] of [
      ["minimumReleaseAge: 1440", "minimumReleaseAge: 0"],
      ["minimumReleaseAge: 1440", "minimumReleaseAge: '1440'"],
      ["minimumReleaseAge: 1440", "minimumReleaseAge: 0x5A0"],
      ["minimumReleaseAgeStrict: true", "minimumReleaseAgeStrict: yes"],
      ["trustPolicy: no-downgrade", "trustPolicy: off"],
    ] as const) {
      const problems = checkWorkspaceSettings(workspace.replace(line, weakened)).problems;
      expect(problems, weakened).toEqual([expect.stringContaining(`${line.split(":")[0]} must be`)]);
    }
  });

  it("accepts comment lines, also inside a block, and blank lines", () => {
    expect(
      withWorkspace(
        "\n# Packages come only from the npm registry.\n\n    # indented\nregistry: https://registry.npmjs.org/\n",
      ),
    ).toEqual([]);
    expect(
      checkWorkspaceSettings(
        workspace.replace("allowBuilds:\n  fsevents: false", "allowBuilds:\n  # macOS only\n  fsevents: false"),
      ).problems,
    ).toEqual([]);
  });

  it("refuses another registry", () => {
    expect(withWorkspace("\nregistry: https://npm.mirror.invalid/\n")).toEqual([
      expect.stringContaining("registry must be https://registry.npmjs.org/"),
    ]);
    expect(withWorkspace("\nregistry: 'https://registry.npmjs.org/'\n")).toEqual([]);
  });

  it("accepts only denials in allowBuilds", () => {
    const allowBuilds = (block: string) =>
      checkWorkspaceSettings(workspace.replace("allowBuilds:\n  fsevents: false", block)).problems;
    expect(allowBuilds("allowBuilds: {}")).toEqual([]);
    expect(allowBuilds("allowBuilds:\n  fsevents: false\n  '@scope/pkg': false")).toEqual([]);
    expect(allowBuilds("allowBuilds: {fsevents: false}")).toEqual([]);
    expect(allowBuilds("allowBuilds:\n  esbuild: true")).toEqual([
      expect.stringContaining("must not let any package run scripts"),
    ]);
    expect(allowBuilds("allowBuilds: {esbuild: true}")).toEqual([
      expect.stringContaining("must not let any package run scripts"),
    ]);
    expect(allowBuilds("allowBuilds:\n  fsevents: false\n# note\n\n  esbuild: true")).toEqual([
      expect.stringContaining("must not let any package run scripts"),
    ]);
    for (const block of [
      "allowBuilds:\n  fsevents: no",
      "allowBuilds:\n  fsevents: 'false'",
      "allowBuilds: null",
      "allowBuilds:\n  - fsevents",
    ]) {
      expect(allowBuilds(block), block).toEqual([expect.stringContaining("allowBuilds")]);
    }
    for (const block of ["allowBuilds:", "allowBuilds: { fsevents: false }", "allowBuilds: {}\n  esbuild: false"]) {
      expect(allowBuilds(block), block).toEqual([expect.stringContaining(unreadable)]);
    }
  });

  it("reads audit exceptions only from auditConfig.ignoreGhsas, as pnpm audit --ignore writes them", () => {
    const text = `${workspace}auditConfig:\n  # lodash 4.17.22 (published 2026-10-07 10:00 UTC) is eligible from 2026-10-08 10:00 UTC; remove then.\n  ignoreGhsas:\n    - GHSA-35jh-r3h4-6jhm\n    - GHSA-r5fr-rjxr-66jc\n`;
    const read = checkWorkspaceSettings(text);
    expect(read.problems).toEqual([]);
    expect(auditExceptions(read.settings)).toEqual(["GHSA-35jh-r3h4-6jhm", "GHSA-r5fr-rjxr-66jc"]);
    expect(
      auditExceptions(
        checkWorkspaceSettings(`${workspace}auditConfig:\n  ignoreGhsas: [GHSA-35jh-r3h4-6jhm]\n`).settings,
      ),
    ).toEqual(["GHSA-35jh-r3h4-6jhm"]);
    for (const [block, reason] of [
      ["auditConfig:\n  ignoreCves:\n    - CVE-2021-23337", "ignoreCves is not applied"],
      ["auditConfig:\n  ignoreGhsas:\n    - GHSA-35jh-r3h4-6jhm\n  ignoreUnfixable: true", "may hold only ignoreGhsas"],
      ["auditConfig:\n  ignoreGhsas:\n    - lodash", "must list GHSA identifiers"],
      ["auditConfig:\n  ignoreGhsas: GHSA-35jh-r3h4-6jhm", "must be a list"],
    ] as const) {
      expect(withWorkspace(`${block}\n`), block).toEqual([expect.stringContaining(reason)]);
    }
    expect(withWorkspace("auditConfig:\n  ignoreGhsas:\n    - GHSA-35jh-r3h4-6jhm # reason\n")).toEqual([
      expect.stringContaining(unreadable),
    ]);
  });

  it("accepts overrides only to exact registry versions", () => {
    expect(withWorkspace("overrides:\n  lodash: 4.17.21\n  'lodash@<4.17.21': 4.17.21\n")).toEqual([]);
    for (const version of ["^4.17.21", "'>=4.17.21'", "link:../lodash", "'npm:lodash@4.17.21'", "'-'"]) {
      expect(withWorkspace(`overrides:\n  lodash: ${version}\n`), version).not.toEqual([]);
    }
  });
});

describe(".npmrc", () => {
  it("accepts this repository's file", () => {
    expect(checkNpmrc(read(".npmrc"))).toEqual([]);
  });

  it("refuses every line but the known ones, because pnpm 12 reads registry and authentication settings from it", () => {
    const npmrc = read(".npmrc");
    for (const line of [
      "registry=https://npm.mirror.invalid/",
      "@acme:registry=https://npm.mirror.invalid/",
      "//npm.mirror.invalid/:_authToken=abc",
      "REGISTRY = https://registry.example.org/",
      " registry=https://registry.npmjs.org/",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal ${…}, which npm expands from the environment in .npmrc.
      "${KEY}=https://npm.mirror.invalid/",
      "[section]",
    ]) {
      expect(checkNpmrc(`${npmrc}${line}\n`), line).toEqual([
        expect.stringContaining(`.npmrc line 5 is ${JSON.stringify(line)}`),
      ]);
    }
    expect(checkNpmrc(`${npmrc}registry=https://registry.npmjs.org/\n; a comment\n`)).toEqual([]);
  });

  it("requires the fences for npm", () => {
    expect(checkNpmrc("")).toHaveLength(3);
  });
});

describe("the settings pnpm applies", () => {
  const check = (changes: Record<string, unknown>, exceptions: readonly string[] = []) =>
    checkEffectiveSettings({ ...recordedPnpmConfig, ...changes }, exceptions);

  it("accepts what pnpm applies in this repository", () => {
    expect(checkEffectiveSettings(recordedPnpmConfig, [])).toEqual([]);
  });

  // The same bypasses as above, as pnpm reports them however they reached it (here, as the review found them, from escaped keys).
  it("refuses a weakened or bypassed safety setting", () => {
    for (const [changes, reason] of [
      [{ dangerouslyAllowAllBuilds: true }, "dangerouslyAllowAllBuilds lets every dependency run install scripts"],
      [{ minimumReleaseAgeExclude: ["react"] }, "bypasses the 24-hour minimum age"],
      [{ ignoreScripts: true }, "hides dependency build scripts"],
      [{ trustPolicyExclude: ["react"] }, "exempts packages from trustPolicy"],
      [
        { registry: "https://npm.mirror.invalid/" },
        'registry = "https://npm.mirror.invalid/", but the policy requires',
      ],
      [{ minimumReleaseAge: 0 }, "minimumReleaseAge = 0, but the policy requires 1440"],
      [{ minimumReleaseAgeStrict: false }, "minimumReleaseAgeStrict = false"],
      [{ strictDepBuilds: false }, "strictDepBuilds = false"],
      [{ trustPolicy: "off" }, 'trustPolicy = "off"'],
      [{ blockExoticSubdeps: false }, "blockExoticSubdeps = false"],
      [{ allowBuilds: { fsevents: false, esbuild: true } }, "every entry must be false"],
      [{ configDependencies: { "pnpm-plugin-x": "1.0.0+sha512-abc" } }, "can bring pnpmfile hooks"],
      [{ pnpmfile: "other.cjs" }, "a pnpmfile's hooks"],
      [{ onlyBuiltDependencies: ["esbuild"] }, "lets the packages it names run install scripts"],
      [{ verifyStoreIntegrity: false }, "which the checks do not know"],
      [{ overrides: { lodash: "^4.17.21" } }, "each must be an exact registry version"],
    ] as const) {
      expect(check(changes), JSON.stringify(changes)).toEqual([expect.stringContaining(reason)]);
    }
    expect(check({ registry: undefined })).toEqual([expect.stringContaining("registry = undefined")]);
  });

  it("refuses scoped registries beyond pnpm's built-in defaults", () => {
    const registries = {
      ...recordedPnpmConfig.registries,
      "https://npm.mirror.invalid/": { scopes: ["@acme"] },
    };
    expect(check({ "@acme:registry": "https://npm.mirror.invalid/", registries })).toEqual([
      expect.stringContaining("pnpm applies registries ="),
      expect.stringContaining("pnpm applies the setting @acme:registry"),
    ]);
    expect(check({ "@jsr:registry": "https://npm.mirror.invalid/" })).toEqual([
      expect.stringContaining("differs from pnpm's built-in default"),
    ]);
  });

  it("accepts machine-local settings that cannot change what is installed, and npm's own authentication", () => {
    expect(
      check({
        storeDir: "/tmp/store",
        httpsProxy: "http://proxy:3128",
        fetchRetries: 5,
        "//registry.npmjs.org/:_authToken": "(protected)",
      }),
    ).toEqual([]);
    expect(check({ verifyDepsBeforeRun: "error" })).toEqual([]);
    expect(check({ "//npm.mirror.invalid/:_authToken": "(protected)" })).toEqual([
      expect.stringContaining("which the checks do not know"),
    ]);
  });

  it("requires pnpm's audit exceptions to be exactly the ones pnpm-workspace.yaml names", () => {
    const named = ["GHSA-35jh-r3h4-6jhm"];
    expect(check({ audit: { ignore: named } }, named)).toEqual([]);
    expect(check({ audit: { ignore: ["GHSA-35jh-r3h4-6jhm", "GHSA-r5fr-rjxr-66jc"] } }, named)).toEqual([
      expect.stringContaining("pnpm ignores the advisories"),
    ]);
    expect(check({ audit: { ignore: named } })).toEqual([expect.stringContaining("pnpm ignores the advisories")]);
    expect(check({}, named)).toEqual([expect.stringContaining("pnpm ignores the advisories [], but")]);
    expect(checkEffectiveAudit({ level: "critical" }, [])).toEqual([
      expect.stringContaining("which hides advisories below that level"),
    ]);
    expect(checkEffectiveAudit("off", [])).toEqual([expect.stringContaining('pnpm applies audit = "off"')]);
  });

  it("refuses a report it cannot read", () => {
    expect(checkEffectiveSettings([], [])).toEqual([expect.stringContaining("as an object")]);
  });
});
