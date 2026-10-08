// The audit gate (ADR-0017 rule 7; work package X-003): fails on any advisory of high or critical severity against the packages in
// pnpm-lock.yaml, unless pnpm-workspace.yaml names it as a temporary exception. Advisories of moderate, low or informational severity are
// reported but do not fail the gate; they are handled in the next batched dependency session, and a Dependabot security alert fires for them
// too. The gate also fails when the audit could not run at all (for example when the registry's advisory service does not answer), so that
// "no advisories" is never assumed. CI runs it on every pull request, on pushes to main and nightly, so that new advisories against unchanged
// dependencies are noticed.
//
// The decision is this script's, not pnpm's. pnpm applies audit exceptions and audit levels written in any YAML layout and from sources
// outside the repository, so the script asks pnpm for every advisory, with no exception applied and no level hidden (`auditArguments`
// below), and applies only the exceptions it reads itself: the GHSA identifiers in auditConfig.ignoreGhsas of pnpm-workspace.yaml, read
// strictly by scripts/pnpm-settings.ts, which the gate names on every run. It also fails when pnpm counts more high or critical advisories
// than its report lists (then something still hides some), and when the exceptions pnpm itself applies (`audit.ignore` in `pnpm config list
// --json`) are not exactly the ones it read, so that `pnpm audit` run by hand shows what the gate decides.
//
// Usage: pnpm run audit   (runs pnpm with the pnpm that runs this script)

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditExceptions,
  checkEffectiveAudit,
  checkWorkspaceSettings,
  pnpmCommand,
  readEffectiveSettings,
} from "./pnpm-settings.ts";

/**
 * How the gate runs the audit: as JSON, listing every severity (`--audit-level info`, which overrides an audit level from the
 * configuration), and without pnpm-workspace.yaml (`--ignore-workspace`), so that pnpm applies none of its exceptions.
 */
export const auditArguments: readonly string[] = ["audit", "--json", "--audit-level", "info", "--ignore-workspace"];

/** The severities that fail the gate. */
export const failingSeverities: readonly string[] = ["critical", "high"];

/** Every severity pnpm reports, from the most to the least severe. */
const severities = ["critical", "high", "moderate", "low", "info"] as const;

export interface AuditResult {
  /** Advisories that fail the gate, or why the audit could not be trusted. */
  failures: string[];
  /** Advisories that are reported without failing the gate. */
  reported: string[];
  /** High or critical advisories that a named exception lets pass. */
  excepted: string[];
  /** Named exceptions that match no advisory any more, and can be removed. */
  unusedExceptions: string[];
}

interface Advisory {
  module_name?: unknown;
  severity?: unknown;
  title?: unknown;
  url?: unknown;
  github_advisory_id?: unknown;
  vulnerable_versions?: unknown;
  patched_versions?: unknown;
  findings?: unknown;
}

function describe(advisory: Advisory): string {
  const versions = Array.isArray(advisory.findings)
    ? advisory.findings
        .map((finding: { version?: unknown }) => (typeof finding?.version === "string" ? finding.version : undefined))
        .filter((version): version is string => version !== undefined)
    : [];
  const installed = versions.length > 0 ? ` ${[...new Set(versions)].join(", ")}` : "";
  return `${String(advisory.severity)}: ${String(advisory.module_name)}${installed} (vulnerable ${String(advisory.vulnerable_versions)}, fixed in ${String(advisory.patched_versions)}): ${String(advisory.title)} ${String(advisory.url)}`;
}

/**
 * Judges the output of `pnpm audit` run with `auditArguments`: `status` is its exit status (0 when nothing was found, 1 when advisories were
 * found or the audit failed), `stdout` its JSON report and `stderr` its error output. `exceptions` are the GHSA identifiers that
 * pnpm-workspace.yaml names; only they can let a high or critical advisory pass.
 */
export function evaluateAudit(
  status: number | null,
  stdout: string,
  stderr: string,
  exceptions: readonly string[],
): AuditResult {
  const couldNotRun = (why: string): AuditResult => ({
    failures: [
      `pnpm audit did not produce a usable report (${why}), so the dependencies were not checked.${stderr.trim() ? `\n${stderr.trim()}` : ""}`,
    ],
    reported: [],
    excepted: [],
    unusedExceptions: [],
  });
  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch {
    return couldNotRun(`exit status ${String(status)}, no JSON report`);
  }
  const advisories = (report as { advisories?: unknown })?.advisories;
  const counts = (report as { metadata?: { vulnerabilities?: unknown } })?.metadata?.vulnerabilities;
  if (typeof advisories !== "object" || advisories === null || typeof counts !== "object" || counts === null) {
    return couldNotRun("the report has no advisories or no vulnerability counts");
  }
  const result: AuditResult = { failures: [], reported: [], excepted: [], unusedExceptions: [] };
  const listed = Object.values(advisories as Record<string, Advisory>);
  const listedBySeverity = new Map<string, number>();
  const matched = new Set<string>();
  for (const advisory of listed) {
    const severity = String(advisory.severity);
    listedBySeverity.set(severity, (listedBySeverity.get(severity) ?? 0) + 1);
    const identifier = typeof advisory.github_advisory_id === "string" ? advisory.github_advisory_id : undefined;
    if (identifier !== undefined && exceptions.includes(identifier)) matched.add(identifier);
    if (!severities.includes(severity as (typeof severities)[number])) {
      result.failures.push(`advisory with an unknown severity: ${describe(advisory)}`);
    } else if (!failingSeverities.includes(severity)) {
      result.reported.push(describe(advisory));
    } else if (identifier !== undefined && exceptions.includes(identifier)) {
      result.excepted.push(`${identifier}: ${describe(advisory)}`);
    } else {
      result.failures.push(describe(advisory));
    }
  }
  result.unusedExceptions = exceptions.filter((identifier) => !matched.has(identifier));
  // pnpm counts every advisory by severity, also those it leaves out of the list (pnpm 12.9.0 leaves out the advisories that its exceptions
  // and audit level hide). The gate's run applies neither, so the counts and the list agree unless something still hides advisories.
  for (const severity of failingSeverities) {
    const count = (counts as Record<string, unknown>)[severity];
    const shown = listedBySeverity.get(severity) ?? 0;
    if (typeof count !== "number") {
      result.failures.push(`the report has no count of ${severity} advisories.`);
    } else if (count !== shown) {
      result.failures.push(
        `pnpm counts ${count} ${severity} advisories but lists ${shown}, so something hides ${count > shown ? "some of them" : "nothing but miscounts"}: an exception or an audit level that pnpm applies from a source this script does not read (see \`pnpm config list --json\`).`,
      );
    }
  }
  const counted = severities.reduce((total, severity) => {
    const count = (counts as Record<string, unknown>)[severity];
    return total + (typeof count === "number" ? count : 0);
  }, 0);
  if (status !== 0 && status !== 1) {
    result.failures.push(`pnpm audit exited with status ${String(status)}.`);
  } else if (status === 1 && counted === 0 && listed.length === 0) {
    return couldNotRun("exit status 1 without any advisory");
  }
  return result;
}

function fail(message: string, lines: readonly string[]): never {
  console.error(`Audit failed: ${message}${lines.map((line) => `\n  - ${line}`).join("")}`);
  process.exit(1);
}

function main(): void {
  // The exceptions, as this script reads them, and the check that pnpm applies exactly these.
  const workspace = checkWorkspaceSettings(readFileSync(resolve("pnpm-workspace.yaml"), "utf8"));
  if (workspace.problems.length > 0) {
    fail(
      "pnpm-workspace.yaml does not pass the strict reading of its settings, so its audit exceptions cannot be read with certainty:",
      workspace.problems,
    );
  }
  const exceptions = auditExceptions(workspace.settings);
  const effective = readEffectiveSettings();
  if ("error" in effective) fail("cannot check which audit exceptions pnpm applies:", [effective.error]);
  const config = effective.config;
  const audit =
    typeof config === "object" && config !== null ? (config as Record<string, unknown>)["audit"] : undefined;
  const auditProblems = checkEffectiveAudit(audit, exceptions);
  if (auditProblems.length > 0)
    fail("pnpm applies audit settings that pnpm-workspace.yaml does not show:", auditProblems);
  if (exceptions.length > 0) {
    console.log(
      `pnpm-workspace.yaml names these audit exceptions (auditConfig.ignoreGhsas); remove each one as soon as its fix is at least 24 hours old:\n${exceptions.map((line) => `  - ${line}`).join("\n")}`,
    );
  }

  const pnpm = pnpmCommand();
  const run = spawnSync(pnpm, auditArguments, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.error) fail(`could not run ${pnpm} audit: ${run.error.message}`, []);
  const { failures, reported, excepted, unusedExceptions } = evaluateAudit(
    run.status,
    run.stdout,
    run.stderr,
    exceptions,
  );
  if (excepted.length > 0) {
    console.log(
      `High or critical advisories that a named exception lets pass until their fix is eligible:\n${excepted.map((line) => `  - ${line}`).join("\n")}`,
    );
  }
  if (unusedExceptions.length > 0) {
    console.log(
      `Audit exceptions that match no advisory any more; remove them from pnpm-workspace.yaml:\n${unusedExceptions.map((line) => `  - ${line}`).join("\n")}`,
    );
  }
  if (reported.length > 0) {
    console.log(
      `Advisories of moderate or lower severity (reported, not failing; fix them in the next dependency session):\n${reported.map((line) => `  - ${line}`).join("\n")}`,
    );
  }
  if (failures.length > 0) {
    fail(
      "high or critical advisories, or no trustworthy report (ADR-0017 rule 7). Follow the security-alert procedure in the docs repository's developer/dependency-update-runbook.md:",
      failures,
    );
  }
  console.log(
    reported.length > 0 || excepted.length > 0
      ? "Audit passed: no high or critical advisories without an exception."
      : "Audit passed: no known vulnerabilities in the dependencies in pnpm-lock.yaml.",
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
