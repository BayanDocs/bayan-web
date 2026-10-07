import { describe, expect, it } from "vitest";
import { evaluateAudit, ignoredAdvisories } from "../../scripts/audit.ts";

// Reports in the format that `pnpm audit --json` prints (recorded from pnpm 12.9.0 on 2026-10-07 for a test project that depended on an old
// lodash); the advisory titles, identifiers and addresses here are placeholders.
function advisory(id: number, severity: string) {
  return {
    id,
    title: `Example ${severity} advisory`,
    module_name: "lodash",
    vulnerable_versions: "<4.17.21",
    patched_versions: ">=4.17.21",
    severity,
    cwe: "CWE-0",
    github_advisory_id: `GHSA-0000-0000-000${id}`,
    url: `https://github.com/advisories/GHSA-0000-0000-000${id}`,
    findings: [{ version: "4.17.20", paths: [".>lodash"], dev: false, optional: false, bundled: false }],
  };
}

function report(advisories: ReturnType<typeof advisory>[]) {
  const vulnerabilities: Record<string, number> = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  for (const entry of advisories) {
    vulnerabilities[entry.severity] = (vulnerabilities[entry.severity] ?? 0) + 1;
  }
  return JSON.stringify({
    advisories: Object.fromEntries(advisories.map((entry) => [String(entry.id), entry])),
    metadata: { vulnerabilities, dependencies: 1, devDependencies: 0, optionalDependencies: 0, totalDependencies: 1 },
  });
}

describe("audit gate", () => {
  it("passes when there are no advisories", () => {
    expect(evaluateAudit(0, report([]), "")).toEqual({ failures: [], reported: [] });
  });

  it("fails on high and critical advisories", () => {
    const result = evaluateAudit(1, report([advisory(1, "high"), advisory(2, "critical")]), "");
    expect(result.failures).toEqual([
      expect.stringMatching(/^high: lodash 4\.17\.20 /),
      expect.stringMatching(/^critical: lodash /),
    ]);
    expect(result.reported).toEqual([]);
  });

  it("reports moderate and lower advisories without failing", () => {
    const result = evaluateAudit(1, report([advisory(1, "moderate"), advisory(2, "low"), advisory(3, "info")]), "");
    expect(result.failures).toEqual([]);
    expect(result.reported).toHaveLength(3);
    expect(result.reported[0]).toContain("moderate: lodash 4.17.20 (vulnerable <4.17.21, fixed in >=4.17.21)");
  });

  it("fails and reports a mix of severities", () => {
    const result = evaluateAudit(1, report([advisory(1, "high"), advisory(2, "moderate")]), "");
    expect(result.failures).toHaveLength(1);
    expect(result.reported).toHaveLength(1);
  });

  it("fails when the audit could not run", () => {
    const stderr = "Error: ERR_PNPM_AUDIT_BAD_RESPONSE\n  × Failed to request the audit endpoint";
    const result = evaluateAudit(1, "", stderr);
    expect(result.failures).toEqual([expect.stringContaining("did not produce a usable report")]);
    expect(result.failures[0]).toContain("ERR_PNPM_AUDIT_BAD_RESPONSE");
    expect(evaluateAudit(1, "{}", "").failures).toEqual([
      expect.stringContaining("no advisories or no vulnerability counts"),
    ]);
    expect(evaluateAudit(1, report([]), "").failures).toEqual([
      expect.stringContaining("exit status 1 without any advisory"),
    ]);
    expect(evaluateAudit(null, report([]), "").failures).toEqual([expect.stringContaining("exited with status null")]);
  });

  it("trusts the list over the counts, which still include ignored advisories", () => {
    // With `auditConfig.ignoreGhsas` in pnpm-workspace.yaml, pnpm 12.9.0 leaves the ignored advisory out of the list but keeps it in the counts.
    const ignored = JSON.parse(report([advisory(2, "moderate")]));
    ignored.metadata.vulnerabilities.high = 1;
    expect(evaluateAudit(1, JSON.stringify(ignored), "")).toEqual({
      failures: [],
      reported: [expect.stringContaining("moderate")],
    });
    const onlyIgnored = JSON.parse(report([]));
    onlyIgnored.metadata.vulnerabilities.high = 1;
    expect(evaluateAudit(1, JSON.stringify(onlyIgnored), "")).toEqual({ failures: [], reported: [] });
  });

  it("names the advisories that pnpm-workspace.yaml ignores", () => {
    expect(ignoredAdvisories("minimumReleaseAge: 1440\n")).toEqual([]);
    const workspace = [
      "minimumReleaseAge: 1440",
      "auditConfig:",
      "  # Fix in lodash 4.17.22 (published 2026-10-07 10:00 UTC) is eligible from 2026-10-08 10:00 UTC; remove then.",
      "  ignoreGhsas:",
      "    - GHSA-35jh-r3h4-6jhm",
      "    - GHSA-29mw-wpgm-hmr9 # second one",
      "trustPolicy: no-downgrade",
    ].join("\n");
    expect(ignoredAdvisories(workspace)).toEqual(["GHSA-35jh-r3h4-6jhm", "GHSA-29mw-wpgm-hmr9 # second one"]);
    expect(ignoredAdvisories("auditConfig:\n  ignoreGhsas: [GHSA-a, GHSA-b]\n")).toEqual([
      "ignoreGhsas: [GHSA-a, GHSA-b]",
    ]);
    expect(ignoredAdvisories("auditConfig:\n  ignoreCves:\n    - CVE-2026-0001\n")).toEqual(["CVE-2026-0001"]);
  });

  // pnpm reads every YAML layout; an exception the reader cannot see would be honoured by pnpm and never reported.
  it("refuses audit exceptions in a form it cannot read", () => {
    for (const workspace of [
      "auditConfig: {ignoreGhsas: [GHSA-35jh-r3h4-6jhm]}\n",
      '"auditConfig":\n  ignoreGhsas:\n    - GHSA-35jh-r3h4-6jhm\n',
      "? auditConfig\n: {ignoreGhsas: [GHSA-35jh-r3h4-6jhm]}\n",
      "auditConfig:\n    ignoreGhsas:\n      - GHSA-35jh-r3h4-6jhm\n",
      "auditConfig:\n  ignoreGhsas:\n    - GHSA-35jh-r3h4-6jhm\n  somethingElse: true\n",
      "ignoreGhsas:\n  - GHSA-not-under-auditConfig\n",
    ]) {
      expect(() => ignoredAdvisories(workspace), workspace).toThrow(/cannot read/);
    }
  });

  it("fails on a severity it does not know", () => {
    expect(evaluateAudit(1, report([advisory(1, "severe")]), "").failures).toEqual([
      expect.stringContaining("unknown severity"),
    ]);
  });
});
