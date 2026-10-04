// Checks that this repository still enforces the dependency policy (ADR-0017, WEB-001): exact pins, pinned Node.js and pnpm,
// and the pnpm safety settings. `pnpm verify` runs it first, so loosening any of these fails the gate.
// pnpm itself enforces the settings during install; this check stops them from being edited away unnoticed.
//
// Usage: node scripts/check-policy.ts   (run from the repository root)

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Settings that must appear, exactly as written, as top-level lines in pnpm-workspace.yaml. */
export const requiredWorkspaceSettings: readonly string[] = [
  "minimumReleaseAge: 1440",
  "minimumReleaseAgeStrict: true",
  "strictDepBuilds: true",
  "allowBuilds: {}",
  "trustPolicy: no-downgrade",
  "blockExoticSubdeps: true",
  "saveExact: true",
  "engineStrict: true",
  "verifyDepsBeforeRun: error",
];

/** Settings that must never appear in pnpm-workspace.yaml, with the reason. */
export const forbiddenWorkspaceSettings: ReadonlyArray<readonly [RegExp, string]> = [
  [/^ignoreScripts\s*:/m, "ignoreScripts hides dependency build scripts from strictDepBuilds; leave it out"],
  [/^minimumReleaseAgeExclude\s*:/m, "minimumReleaseAgeExclude bypasses the 24-hour minimum age"],
  [/^dangerouslyAllowAllBuilds\s*:/m, "dangerouslyAllowAllBuilds lets every dependency run install scripts"],
];

export const requiredNpmrcLines: readonly string[] = ["ignore-scripts=true", "save-exact=true", "engine-strict=true"];

const exactVersion = /^\d+\.\d+\.\d+$/;
const pinnedPackageManager = /^pnpm@(\d+\.\d+\.\d+)\+sha512\.[0-9a-f]{128}$/;

interface PackageJson {
  packageManager?: unknown;
  engines?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
}

export interface PolicyInput {
  packageJson: PackageJson;
  workspaceYaml: string;
  npmrc: string;
  nvmrc: string;
  lockfileExists: boolean;
  /** The running Node.js version, e.g. "v24.21.0". */
  nodeVersion: string;
}

/** Returns a list of policy violations; an empty list means the configuration is compliant. */
export function checkPolicy(input: PolicyInput): string[] {
  const problems: string[] = [];
  const pkg = input.packageJson;

  const manager = typeof pkg.packageManager === "string" ? pinnedPackageManager.exec(pkg.packageManager) : null;
  if (manager === null) {
    problems.push(
      'package.json "packageManager" must pin pnpm exactly with its sha512 hash (pnpm@x.y.z+sha512.<hex>).',
    );
  } else if (pkg.engines?.["pnpm"] !== manager[1]) {
    problems.push(`package.json "engines.pnpm" must equal the pinned pnpm version ${manager[1]}.`);
  }

  const nvmrc = input.nvmrc.trim();
  if (!exactVersion.test(nvmrc)) {
    problems.push(".nvmrc must contain one exact Node.js version (x.y.z).");
  }
  if (pkg.engines?.["node"] !== nvmrc) {
    problems.push(`package.json "engines.node" must equal .nvmrc (${nvmrc}).`);
  }
  if (input.nodeVersion !== `v${nvmrc}`) {
    problems.push(`Node.js ${input.nodeVersion} is running, but the project pins v${nvmrc}.`);
  }

  for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    for (const [name, version] of Object.entries(pkg[field] ?? {})) {
      if (typeof version !== "string" || !exactVersion.test(version)) {
        problems.push(`${field}.${name} must be an exact version (x.y.z), not ${JSON.stringify(version)}.`);
      }
    }
  }
  if (pkg.peerDependencies !== undefined) {
    problems.push("An application has no peerDependencies; declare dependencies exactly instead.");
  }

  const yamlLines = new Set(input.workspaceYaml.split(/\r?\n/).map((line) => line.trimEnd()));
  for (const setting of requiredWorkspaceSettings) {
    if (!yamlLines.has(setting)) {
      problems.push(`pnpm-workspace.yaml must contain the line "${setting}".`);
    }
  }
  for (const [pattern, reason] of forbiddenWorkspaceSettings) {
    if (pattern.test(input.workspaceYaml)) {
      problems.push(`pnpm-workspace.yaml: ${reason}.`);
    }
  }

  const npmrcLines = new Set(input.npmrc.split(/\r?\n/).map((line) => line.trim()));
  for (const line of requiredNpmrcLines) {
    if (!npmrcLines.has(line)) {
      problems.push(`.npmrc must contain "${line}".`);
    }
  }

  if (!input.lockfileExists) {
    problems.push("pnpm-lock.yaml must be committed.");
  }
  return problems;
}

function main(): void {
  const read = (file: string) => readFileSync(resolve(file), "utf8");
  const problems = checkPolicy({
    packageJson: JSON.parse(read("package.json")) as PackageJson,
    workspaceYaml: read("pnpm-workspace.yaml"),
    npmrc: read(".npmrc"),
    nvmrc: read(".nvmrc"),
    lockfileExists: existsSync(resolve("pnpm-lock.yaml")),
    nodeVersion: process.version,
  });
  if (problems.length > 0) {
    console.error(`Dependency policy check failed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log("Dependency policy check passed: exact pins, pinned Node.js and pnpm, pnpm safety settings in place.");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
