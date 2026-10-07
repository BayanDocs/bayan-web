// The audit gate (ADR-0017 rule 7; work package X-003): runs `pnpm audit --json` and fails on any advisory of high or critical severity.
// Advisories of moderate, low or informational severity are reported but do not fail the gate; they are handled in the next batched dependency
// session, and a Dependabot security alert fires for them too. The gate also fails when the audit could not run at all (for example when the
// registry's advisory service does not answer), so that "no advisories" is never assumed. CI runs it on every pull request, on pushes to main
// and nightly, so that new advisories against unchanged dependencies are noticed.
//
// Usage: pnpm run audit   (runs `pnpm audit --json` with the pnpm that runs this script)

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The severities that fail the gate. */
export const failingSeverities: readonly string[] = ["critical", "high"];

/** Every severity pnpm reports, from the most to the least severe. */
const severities = ["critical", "high", "moderate", "low", "info"] as const;

export interface AuditResult {
  /** Advisories that fail the gate, or why the audit could not be trusted. */
  failures: string[];
  /** Advisories that are reported without failing the gate. */
  reported: string[];
}

interface Advisory {
  module_name?: unknown;
  severity?: unknown;
  title?: unknown;
  url?: unknown;
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
 * The advisories that pnpm-workspace.yaml tells the audit to ignore (`auditConfig.ignoreGhsas`), which the report leaves out. The
 * dependency-update runbook allows such an entry only as a temporary, commented exception while the only fix is younger than 24 hours;
 * the gate names every one of them on every run, so none is forgotten.
 */
export function ignoredAdvisories(workspaceYaml: string): string[] {
  const lines = workspaceYaml.split(/\r?\n/);
  const ignored: string[] = [];
  let inAuditConfig = false;
  let inIgnoreList = false;
  for (const line of lines) {
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) {
      inAuditConfig = /^auditConfig\s*:/.test(line);
      inIgnoreList = false;
      continue;
    }
    if (!inAuditConfig) continue;
    const key = /^\s+(\w+)\s*:\s*(.*)$/.exec(line);
    if (key) {
      inIgnoreList = key[1] === "ignoreGhsas";
      if (inIgnoreList && (key[2] ?? "").trim() !== "") ignored.push(`ignoreGhsas: ${(key[2] ?? "").trim()}`);
      continue;
    }
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (inIgnoreList && item) ignored.push(item[1] ?? "");
  }
  return ignored;
}

/**
 * Judges the output of `pnpm audit --json`: `status` is its exit status (0 when nothing was found, 1 when advisories were found or the audit
 * failed), `stdout` its JSON report and `stderr` its error output.
 */
export function evaluateAudit(status: number | null, stdout: string, stderr: string): AuditResult {
  const couldNotRun = (why: string): AuditResult => ({
    failures: [
      `pnpm audit did not produce a usable report (${why}), so the dependencies were not checked.${stderr.trim() ? `\n${stderr.trim()}` : ""}`,
    ],
    reported: [],
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
  const result: AuditResult = { failures: [], reported: [] };
  const listed = Object.values(advisories as Record<string, Advisory>);
  for (const advisory of listed) {
    const severity = String(advisory.severity);
    if (!severities.includes(severity as (typeof severities)[number])) {
      result.failures.push(`advisory with an unknown severity: ${describe(advisory)}`);
    } else if (failingSeverities.includes(severity)) {
      result.failures.push(describe(advisory));
    } else {
      result.reported.push(describe(advisory));
    }
  }
  // The decision rests on the list of advisories. The counts are not compared with it, because pnpm leaves advisories that
  // `auditConfig.ignoreGhsas` in pnpm-workspace.yaml excludes out of the list but still counts them (pnpm 12.9.0).
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

function main(): void {
  const workspaceFile = resolve("pnpm-workspace.yaml");
  const ignored = existsSync(workspaceFile) ? ignoredAdvisories(readFileSync(workspaceFile, "utf8")) : [];
  if (ignored.length > 0) {
    console.log(
      `pnpm-workspace.yaml tells the audit to ignore these advisories (auditConfig.ignoreGhsas); remove each one as soon as its fix is at least 24 hours old:\n${ignored.map((line) => `  - ${line}`).join("\n")}`,
    );
  }
  // pnpm sets npm_execpath to its own executable, so the audit runs with the pinned pnpm that runs this script.
  const execpath = process.env["npm_execpath"];
  const pnpm = execpath !== undefined && !/\.[cm]?js$/.test(execpath) ? execpath : "pnpm";
  const audit = spawnSync(pnpm, ["audit", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (audit.error) {
    console.error(`Could not run ${pnpm} audit: ${audit.error.message}`);
    process.exit(1);
  }
  const { failures, reported } = evaluateAudit(audit.status, audit.stdout, audit.stderr);
  if (reported.length > 0) {
    console.log(
      `Advisories of moderate or lower severity (reported, not failing; fix them in the next dependency session):\n${reported.map((line) => `  - ${line}`).join("\n")}`,
    );
  }
  if (failures.length > 0) {
    console.error(
      `Audit failed: high or critical advisories, or no trustworthy report (ADR-0017 rule 7). Follow the security-alert procedure in the docs repository's developer/dependency-update-runbook.md:\n${failures.map((line) => `  - ${line}`).join("\n")}`,
    );
    process.exit(1);
  }
  console.log(
    reported.length > 0
      ? "Audit passed: no high or critical advisories."
      : "Audit passed: no known vulnerabilities in the dependencies in pnpm-lock.yaml.",
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
