// The pnpm settings of this repository, read strictly and checked against ADR-0017 (work package X-003). scripts/check-policy.ts,
// scripts/check-lockfile-integrity.ts and scripts/audit.ts all read pnpm-workspace.yaml through this module, so they read it the same way.
//
// pnpm takes its settings from several places and reads each in its own way: pnpm-workspace.yaml as YAML (in every layout, with every
// escape), the registry and authentication lines of .npmrc and ~/.npmrc, its global configuration, and pnpm_config_* environment
// variables. The checks are therefore in two layers:
//   1. The files in the repository, read strictly. pnpm-workspace.yaml is read with scripts/strict-yaml.ts and may hold only the settings
//      in `workspaceSettings` below, each with the value the policy requires; .npmrc may hold only the lines in `npmrcLines`. Anything
//      else fails, so that no setting in them can mean one thing to pnpm and another to the checks.
//   2. What pnpm applies, whatever its source, as `pnpm config list --json` reports it: the registry, the 24-hour minimum age, the
//      build-script and trust settings and the audit exceptions must be exactly as the policy requires, and every other setting must be
//      one listed in `harmlessSettings`, which cannot change where packages come from, which versions may be installed or whether their
//      scripts run. A personal setting outside that list (in ~/.npmrc, pnpm's global configuration or the environment) fails the check
//      on that machine until it is removed or, after review, added to the list.
// Neither layer sees what a pnpmfile's hooks change (`pnpm config list` reports the settings before the hooks run), so
// scripts/check-lockfile-integrity.ts refuses pnpmfiles themselves.

import { spawnSync } from "node:child_process";
import { describe, type Mapping, type Node, numberedLines, readDocument, Unreadable } from "./strict-yaml.ts";

/** The only registry packages may come from. */
export const npmRegistry = "https://registry.npmjs.org/";

/** A registry version: major.minor.patch, with an optional pre-release and build part. */
export const registryVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** An npm package name, with or without a scope. */
export const packageName = /^(?:@[A-Za-z0-9~-][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~-][A-Za-z0-9._~-]*$/;

/** A GitHub advisory identifier, the form `pnpm audit --ignore` writes. */
const ghsaIdentifier = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/;

// ---------------------------------------------------------------------------------------------------------------------------------
// pnpm-workspace.yaml

interface WorkspaceSetting {
  /** Whether the file must have the setting. */
  required: boolean;
  /** The setting as it must be written, for the message when it is missing. */
  expected: string;
  /** The problems with the setting's value; none means it is as the policy requires. */
  check: (node: Node) => string[];
}

/** Plain text, exactly as given. */
function exactly(expected: string): (node: Node) => string[] {
  return (node) =>
    node.kind === "text" && !node.quoted && node.value === expected
      ? []
      : [`must be ${expected}, not ${describe(node)}`];
}

/** allowBuilds: only denials, `<package>: false`, or `{}`. `true` would let a package run its install and build scripts. */
function onlyDenials(node: Node): string[] {
  if (node.kind !== "mapping") return [`must be a mapping of "<package>: false" entries or {}, not ${describe(node)}`];
  const problems: string[] = [];
  for (const [name, denial] of node.entries) {
    if (!packageName.test(name)) problems.push(`${JSON.stringify(name)} is not a package name`);
    if (denial.kind === "text" && !denial.quoted && denial.value === "true") {
      problems.push(`must not let any package run scripts: ${JSON.stringify(name)} is true`);
    } else if (denial.kind !== "text" || denial.quoted || denial.value !== "false") {
      problems.push(`entries must be exactly "<package>: false", not ${JSON.stringify(name)}: ${describe(denial)}`);
    }
  }
  return problems;
}

/** auditConfig: only `ignoreGhsas`, a list of GHSA identifiers (the security-alert procedure's temporary exceptions). */
function auditExceptionList(node: Node): string[] {
  if (node.kind !== "mapping") return [`must be a mapping with only ignoreGhsas, not ${describe(node)}`];
  const problems: string[] = [];
  for (const [key, entry] of node.entries) {
    if (key === "ignoreCves") {
      problems.push(
        "ignoreCves is not applied by pnpm 12.9.0; name the advisory's GHSA identifier in ignoreGhsas instead",
      );
    } else if (key !== "ignoreGhsas") {
      problems.push(`may hold only ignoreGhsas, not ${JSON.stringify(key)}`);
    } else if (entry.kind !== "list") {
      problems.push(`ignoreGhsas must be a list of GHSA identifiers, not ${describe(entry)}`);
    } else {
      for (const item of entry.items) {
        if (item.kind !== "text" || item.quoted || !ghsaIdentifier.test(item.value)) {
          problems.push(`ignoreGhsas must list GHSA identifiers (GHSA-xxxx-xxxx-xxxx), not ${describe(item)}`);
        }
      }
    }
  }
  return problems;
}

/** overrides: package selectors pinned to exact registry versions (the security-alert procedure's way to replace a vulnerable version). */
function registryOverrides(node: Node): string[] {
  if (node.kind !== "mapping")
    return [`must be a mapping of package selectors to exact versions, not ${describe(node)}`];
  const problems: string[] = [];
  for (const [selector, version] of node.entries) {
    if (version.kind !== "text" || !registryVersion.test(version.value)) {
      problems.push(`the override of ${selector} must be an exact registry version, not ${describe(version)}`);
    }
  }
  return problems;
}

function npmRegistryValue(node: Node): string[] {
  return node.kind === "text" && node.value === npmRegistry
    ? []
    : [`must be ${npmRegistry}: packages come only from npm's registry, not ${describe(node)}`];
}

/**
 * Every setting pnpm-workspace.yaml may have, with the value the policy requires. A setting that is not listed fails until it has been
 * reviewed and added here, in a pull request that explains what it changes.
 */
export const workspaceSettings: ReadonlyMap<string, WorkspaceSetting> = new Map<string, WorkspaceSetting>([
  // The 24-hour minimum age (in minutes), and failing instead of falling back to an older version.
  ["minimumReleaseAge", { required: true, expected: "minimumReleaseAge: 1440", check: exactly("1440") }],
  ["minimumReleaseAgeStrict", { required: true, expected: "minimumReleaseAgeStrict: true", check: exactly("true") }],
  // A dependency that wants to run an install or build script fails the install, unless allowBuilds denies the script explicitly.
  ["strictDepBuilds", { required: true, expected: "strictDepBuilds: true", check: exactly("true") }],
  [
    "allowBuilds",
    { required: true, expected: 'allowBuilds (with only "<package>: false" entries)', check: onlyDenials },
  ],
  ["trustPolicy", { required: true, expected: "trustPolicy: no-downgrade", check: exactly("no-downgrade") }],
  ["blockExoticSubdeps", { required: true, expected: "blockExoticSubdeps: true", check: exactly("true") }],
  ["saveExact", { required: true, expected: "saveExact: true", check: exactly("true") }],
  ["engineStrict", { required: true, expected: "engineStrict: true", check: exactly("true") }],
  ["verifyDepsBeforeRun", { required: true, expected: "verifyDepsBeforeRun: error", check: exactly("error") }],
  ["auditConfig", { required: false, expected: "auditConfig", check: auditExceptionList }],
  ["overrides", { required: false, expected: "overrides", check: registryOverrides }],
  ["registry", { required: false, expected: `registry: ${npmRegistry}`, check: npmRegistryValue }],
]);

/** Why some settings pnpm knows must never be added, for a clearer message than "not on the list". */
const forbiddenSettings: ReadonlyMap<string, string> = new Map([
  ["ignoreScripts", "ignoreScripts hides dependency build scripts from strictDepBuilds; leave it out"],
  ["minimumReleaseAgeExclude", "minimumReleaseAgeExclude bypasses the 24-hour minimum age"],
  ["dangerouslyAllowAllBuilds", "dangerouslyAllowAllBuilds lets every dependency run install scripts"],
  ["trustPolicyExclude", "trustPolicyExclude exempts packages from trustPolicy: no-downgrade"],
  ["onlyBuiltDependencies", "onlyBuiltDependencies lets the packages it names run install scripts"],
  ["auditLevel", "auditLevel hides advisories below the level it names from the audit"],
  ["configDependencies", "configDependencies are installed before everything else and can bring pnpmfile hooks"],
  ["pnpmfile", "a pnpmfile's hooks can change pnpm's settings and the packages it installs, unseen by these checks"],
  [
    "globalPnpmfile",
    "a pnpmfile's hooks can change pnpm's settings and the packages it installs, unseen by these checks",
  ],
]);

export interface WorkspaceSettings {
  /** Every problem found; none means the file is as the policy requires. */
  problems: string[];
  /** The settings that could be read (none when the file could not be read). */
  settings: ReadonlyMap<string, Node>;
}

/** Reads pnpm-workspace.yaml strictly and checks every setting in it against `workspaceSettings`. */
export function checkWorkspaceSettings(text: string): WorkspaceSettings {
  let root: Mapping;
  try {
    root = readDocument(numberedLines(text), { commentLines: true });
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    return {
      problems: [
        `pnpm-workspace.yaml line ${error.line}: cannot read the file with certainty (${error.message}). pnpm reads every YAML layout, so the checks read only the layout pnpm writes: one setting per line as "name: value", two spaces per level, plain or single-quoted text, comments on lines of their own.`,
      ],
      settings: new Map(),
    };
  }
  const problems: string[] = [];
  for (const [name, node] of root.entries) {
    const setting = workspaceSettings.get(name);
    if (root.quotedKeys.has(name)) {
      problems.push(`pnpm-workspace.yaml line ${node.line}: write the setting name ${name} without quotes.`);
    }
    if (setting === undefined) {
      const reason = forbiddenSettings.get(name);
      problems.push(
        reason === undefined
          ? `pnpm-workspace.yaml line ${node.line}: "${name}" is not a setting the checks know (scripts/pnpm-settings.ts); pnpm applies every setting it knows, so an unreviewed one fails until it has been reviewed and added there.`
          : `pnpm-workspace.yaml line ${node.line}: ${reason}.`,
      );
      continue;
    }
    for (const problem of setting.check(node))
      problems.push(`pnpm-workspace.yaml line ${node.line}: ${name} ${problem}.`);
  }
  for (const [name, setting] of workspaceSettings) {
    if (setting.required && !root.entries.has(name))
      problems.push(`pnpm-workspace.yaml must contain "${setting.expected}".`);
  }
  return { problems, settings: root.entries };
}

/** The GHSA identifiers that pnpm-workspace.yaml's auditConfig.ignoreGhsas names, from settings that checkWorkspaceSettings accepted. */
export function auditExceptions(settings: ReadonlyMap<string, Node>): string[] {
  const config = settings.get("auditConfig");
  const list = config?.kind === "mapping" ? config.entries.get("ignoreGhsas") : undefined;
  return list?.kind === "list" ? list.items.flatMap((item) => (item.kind === "text" ? [item.value] : [])) : [];
}

// ---------------------------------------------------------------------------------------------------------------------------------
// .npmrc

/** The lines .npmrc must have. They are for npm, which this repository does not use, so that an accidental npm install stays safe. */
export const npmrcLines: readonly string[] = ["ignore-scripts=true", "save-exact=true", "engine-strict=true"];

/** The one other line .npmrc may have. */
const optionalNpmrcLines: readonly string[] = [`registry=${npmRegistry}`];

/**
 * Checks .npmrc. pnpm 12 reads its registry and authentication settings (`registry=…`, `@scope:registry=…`, `//host/:_authToken=…`), so the
 * file may hold only the lines above, blank lines and comment lines (starting with # or ;); any other line fails.
 */
export function checkNpmrc(text: string): string[] {
  const problems: string[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line === "" || line.startsWith("#") || line.startsWith(";")) {
      if (/[^\x20-\x7e]/.test(line)) problems.push(`.npmrc line ${index + 1} has a character outside printable ASCII.`);
      return;
    }
    if (npmrcLines.includes(line) || optionalNpmrcLines.includes(line)) return;
    problems.push(
      `.npmrc line ${index + 1} is ${JSON.stringify(line)}; pnpm reads registry and authentication settings from .npmrc, so it may hold only ${[...npmrcLines, ...optionalNpmrcLines].join(", ")}, blank lines and comment lines.`,
    );
  });
  for (const line of npmrcLines) {
    if (!lines.includes(line)) problems.push(`.npmrc must contain "${line}".`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// What pnpm applies

/** The settings pnpm must apply, exactly; the registries are pnpm 12.9.0's built-in defaults. */
const requiredEffectiveSettings: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ["registry", npmRegistry],
  ["minimumReleaseAge", 1440],
  ["minimumReleaseAgeStrict", true],
  ["strictDepBuilds", true],
  ["trustPolicy", "no-downgrade"],
  ["blockExoticSubdeps", true],
]);

/** Built into pnpm 12.9.0 (absent in a pnpm without them): JSR's registry for the @jsr scope, and the prefixes pnpm knows. */
const builtInEffectiveSettings: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ["@jsr:registry", "https://npm.jsr.io/"],
  [
    "registries",
    {
      "https://npm.jsr.io/": { scopes: ["@jsr"] },
      "https://npm.pkg.github.com/": { prefix: "gh" },
      "https://registry.npmjs.org/": { scopes: ["@"], prefix: "npmjs" },
    },
  ],
]);

/**
 * Settings that may have any value, because they cannot change where packages come from, which versions may be installed or whether
 * their scripts run: pnpm's own user agent, the policy's file-only settings (saveExact and engineStrict, and verifyDepsBeforeRun, which
 * `pnpm run` switches off for the commands it starts), and machine-local folders, proxies, network tuning and output.
 */
export const harmlessSettings: ReadonlySet<string> = new Set([
  "userAgent",
  "saveExact",
  "engineStrict",
  "verifyDepsBeforeRun",
  "storeDir",
  "cacheDir",
  "stateDir",
  "httpsProxy",
  "httpProxy",
  "proxy",
  "noProxy",
  "fetchRetries",
  "fetchRetryFactor",
  "fetchRetryMintimeout",
  "fetchRetryMaxtimeout",
  "fetchTimeout",
  "networkConcurrency",
  "color",
  "loglevel",
  "updateNotifier",
]);

/** Settings for npm's own registry, which do not route anything elsewhere: its authentication token, for one. */
const npmRegistrySetting = /^\/\/registry\.npmjs\.org\/:/;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Checks the settings pnpm applies, as `pnpm config list --json` reports them. `exceptions` are the audit exceptions that
 * pnpm-workspace.yaml names; pnpm's own list (`audit.ignore`) must be exactly those.
 */
export function checkEffectiveSettings(config: unknown, exceptions: readonly string[]): string[] {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return ["pnpm config list --json did not report the settings as an object."];
  }
  const settings = new Map(Object.entries(config));
  const problems: string[] = [];
  const where =
    "pnpm-workspace.yaml, .npmrc, ~/.npmrc, pnpm's global configuration or a pnpm_config_* environment variable";
  for (const [name, expected] of requiredEffectiveSettings) {
    if (!same(settings.get(name), expected)) {
      problems.push(
        `pnpm applies ${name} = ${JSON.stringify(settings.get(name))}, but the policy requires ${JSON.stringify(expected)}; look for it in ${where}.`,
      );
    }
  }
  for (const [name, value] of settings) {
    if (requiredEffectiveSettings.has(name) || harmlessSettings.has(name) || npmRegistrySetting.test(name)) continue;
    if (builtInEffectiveSettings.has(name)) {
      if (!same(value, builtInEffectiveSettings.get(name))) {
        problems.push(
          `pnpm applies ${name} = ${JSON.stringify(value)}, which differs from pnpm's built-in default; packages come only from ${npmRegistry}.`,
        );
      }
    } else if (name === "allowBuilds") {
      const entries = typeof value === "object" && value !== null ? Object.entries(value) : [];
      if (typeof value !== "object" || value === null || entries.some(([, allowed]) => allowed !== false)) {
        problems.push(`pnpm applies allowBuilds = ${JSON.stringify(value)}; every entry must be false.`);
      }
    } else if (name === "audit") {
      problems.push(...checkEffectiveAudit(value, exceptions));
    } else if (name === "overrides") {
      const entries = typeof value === "object" && value !== null ? Object.entries(value) : [];
      if (
        typeof value !== "object" ||
        value === null ||
        entries.some(([, version]) => typeof version !== "string" || !registryVersion.test(version))
      ) {
        problems.push(`pnpm applies overrides = ${JSON.stringify(value)}; each must be an exact registry version.`);
      }
    } else {
      const reason = forbiddenSettings.get(name);
      problems.push(
        `pnpm applies the setting ${name} = ${JSON.stringify(value)}${reason === undefined ? ", which the checks do not know" : ` (${reason})`}. It comes from ${where}; remove it, or, if it cannot change where packages come from, which versions may be installed or whether their scripts run, add it to harmlessSettings in scripts/pnpm-settings.ts in a reviewed pull request.`,
      );
    }
  }
  if (!settings.has("allowBuilds"))
    problems.push("pnpm applies no allowBuilds setting; pnpm-workspace.yaml must set it.");
  if (!settings.has("audit") && exceptions.length > 0) problems.push(...checkEffectiveAudit(undefined, exceptions));
  return problems;
}

/**
 * Checks pnpm's audit settings (`audit` in `pnpm config list --json`): only `ignore`, which must name exactly `exceptions`, the
 * identifiers pnpm-workspace.yaml's auditConfig.ignoreGhsas lists. pnpm applies exceptions written in any YAML layout and from other
 * sources too, so an exception that pnpm applies but the checks cannot read fails here.
 */
export function checkEffectiveAudit(audit: unknown, exceptions: readonly string[]): string[] {
  const isObject = typeof audit === "object" && audit !== null && !Array.isArray(audit);
  const settings = isObject ? Object.entries(audit) : [];
  const problems: string[] = [];
  if (audit !== undefined && !isObject) problems.push(`pnpm applies audit = ${JSON.stringify(audit)}.`);
  let ignored: unknown[] = [];
  for (const [name, value] of settings) {
    if (name === "ignore" && Array.isArray(value)) {
      ignored = value;
    } else {
      problems.push(
        `pnpm applies the audit setting ${name} = ${JSON.stringify(value)}${name === "level" ? ", which hides advisories below that level" : ""}; the only audit setting allowed is the exception list (auditConfig.ignoreGhsas).`,
      );
    }
  }
  const named = [...exceptions].sort();
  const applied = ignored.map(String).sort();
  if (!same(named, applied)) {
    problems.push(
      `pnpm ignores the advisories ${JSON.stringify(applied)}, but pnpm-workspace.yaml names ${JSON.stringify(named)} in auditConfig.ignoreGhsas, the only layout the checks read. pnpm reads exceptions in every YAML layout and from other sources, so these must agree.`,
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Running pnpm

/** The pnpm to run: the one that runs this script (pnpm sets npm_execpath to its own executable), or else pnpm on PATH. */
export function pnpmCommand(): string {
  const execpath = process.env["npm_execpath"];
  return execpath !== undefined && !/\.[cm]?js$/.test(execpath) ? execpath : "pnpm";
}

/** The settings pnpm applies in this repository, from `pnpm config list --json`, or why they could not be read. */
export function readEffectiveSettings(): { config: unknown } | { error: string } {
  const pnpm = pnpmCommand();
  const result = spawnSync(pnpm, ["config", "list", "--json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) return { error: `could not run ${pnpm} config list: ${result.error.message}` };
  if (result.status !== 0) {
    return { error: `${pnpm} config list exited with status ${String(result.status)}: ${result.stderr.trim()}` };
  }
  try {
    return { config: JSON.parse(result.stdout) };
  } catch {
    return { error: `${pnpm} config list --json did not print JSON: ${result.stdout.slice(0, 200)}` };
  }
}
