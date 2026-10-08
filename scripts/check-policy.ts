// Checks that this repository still enforces the dependency policy (ADR-0017, WEB-001, X-003): exact pins, pinned Node.js and pnpm,
// and the pnpm safety settings, both as pnpm-workspace.yaml and .npmrc write them and as pnpm applies them (`pnpm config list --json`).
// `pnpm verify` runs it first, so loosening any of these fails the gate. pnpm itself enforces the settings during install; this check stops
// them from being edited away unnoticed. How the settings are read and checked is explained in scripts/pnpm-settings.ts.
//
// Usage: node scripts/check-policy.ts   (run from the repository root; it runs `pnpm config list --json` with the pnpm that runs it)

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditExceptions,
  checkEffectiveSettings,
  checkNpmrc,
  checkWorkspaceSettings,
  readEffectiveSettings,
} from "./pnpm-settings.ts";

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
  /**
   * The npm_config_user_agent environment variable, which pnpm sets for every script it runs (for example
   * "pnpm/12.9.0 npm/? node/v24.21.0 linux x64"), or undefined when this check runs outside a package manager.
   */
  userAgent: string | undefined;
  /** The settings pnpm applies (the output of `pnpm config list --json`), or why they could not be read. */
  pnpmConfig: { config: unknown } | { error: string };
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
  } else {
    if (pkg.engines?.["pnpm"] !== manager[1]) {
      problems.push(`package.json "engines.pnpm" must equal the pinned pnpm version ${manager[1]}.`);
    }
    // Defense in depth: an older pnpm normally switches itself to the pinned version, but if that switch fails it can fall back to
    // running as itself. The user agent says which pnpm is really running this check; anything but the pinned pnpm fails.
    if (input.userAgent !== undefined) {
      const running = /^pnpm\/(\S+)\s/.exec(`${input.userAgent} `)?.[1];
      if (running === undefined) {
        problems.push(
          `run this check through pnpm only (pnpm run check:policy), not ${JSON.stringify(input.userAgent.split(" ")[0])}.`,
        );
      } else if (running !== manager[1]) {
        problems.push(`pnpm ${running} is running, but package.json pins pnpm ${manager[1]}.`);
      }
    }
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

  // The settings as the files write them, then as pnpm applies them from every source.
  const workspace = checkWorkspaceSettings(input.workspaceYaml);
  problems.push(...workspace.problems);
  problems.push(...checkNpmrc(input.npmrc));
  if ("error" in input.pnpmConfig) {
    problems.push(`Cannot check the settings pnpm applies: ${input.pnpmConfig.error}`);
  } else {
    problems.push(...checkEffectiveSettings(input.pnpmConfig.config, auditExceptions(workspace.settings)));
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
    userAgent: process.env["npm_config_user_agent"],
    pnpmConfig: readEffectiveSettings(),
  });
  if (problems.length > 0) {
    console.error(`Dependency policy check failed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(
    "Dependency policy check passed: exact pins, pinned Node.js and pnpm, and the pnpm safety settings in place, both in pnpm-workspace.yaml and as pnpm applies them.",
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
