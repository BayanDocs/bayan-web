import { describe, expect, it } from "vitest";
import { auditArguments, evaluateAudit } from "../../scripts/audit.ts";

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

const none = { failures: [], reported: [], excepted: [], unusedExceptions: [] };

describe("audit gate", () => {
  it("passes when there are no advisories", () => {
    expect(evaluateAudit(0, report([]), "", [])).toEqual(none);
  });

  it("fails on high and critical advisories", () => {
    const result = evaluateAudit(1, report([advisory(1, "high"), advisory(2, "critical")]), "", []);
    expect(result.failures).toEqual([
      expect.stringMatching(/^high: lodash 4\.17\.20 /),
      expect.stringMatching(/^critical: lodash /),
    ]);
    expect(result.reported).toEqual([]);
  });

  it("reports moderate and lower advisories without failing", () => {
    const result = evaluateAudit(1, report([advisory(1, "moderate"), advisory(2, "low"), advisory(3, "info")]), "", []);
    expect(result.failures).toEqual([]);
    expect(result.reported).toHaveLength(3);
    expect(result.reported[0]).toContain("moderate: lodash 4.17.20 (vulnerable <4.17.21, fixed in >=4.17.21)");
  });

  it("fails and reports a mix of severities", () => {
    const result = evaluateAudit(1, report([advisory(1, "high"), advisory(2, "moderate")]), "", []);
    expect(result.failures).toHaveLength(1);
    expect(result.reported).toHaveLength(1);
  });

  it("fails when the audit could not run", () => {
    const stderr = "Error: ERR_PNPM_AUDIT_BAD_RESPONSE\n  × Failed to request the audit endpoint";
    const result = evaluateAudit(1, "", stderr, []);
    expect(result.failures).toEqual([expect.stringContaining("did not produce a usable report")]);
    expect(result.failures[0]).toContain("ERR_PNPM_AUDIT_BAD_RESPONSE");
    expect(evaluateAudit(1, "{}", "", []).failures).toEqual([
      expect.stringContaining("no advisories or no vulnerability counts"),
    ]);
    expect(evaluateAudit(1, report([]), "", []).failures).toEqual([
      expect.stringContaining("exit status 1 without any advisory"),
    ]);
    expect(evaluateAudit(null, report([]), "", []).failures).toEqual([
      expect.stringContaining("exited with status null"),
    ]);
  });

  // pnpm 12.9.0 leaves the advisories that its exceptions or audit level hide out of the list, but still counts them. The review of X-003
  // hid two high advisories this way with escaped keys in pnpm-workspace.yaml, and the audit passed. The gate's own run applies neither,
  // so a count above the list means that something still hides advisories.
  it("fails when pnpm counts more high or critical advisories than it lists", () => {
    const hidden = JSON.parse(report([advisory(2, "moderate")]));
    hidden.metadata.vulnerabilities.high = 2;
    expect(evaluateAudit(1, JSON.stringify(hidden), "", [])).toEqual({
      ...none,
      failures: [expect.stringContaining("pnpm counts 2 high advisories but lists 0, so something hides some of them")],
      reported: [expect.stringContaining("moderate")],
    });
    const onlyHidden = JSON.parse(report([]));
    onlyHidden.metadata.vulnerabilities.critical = 1;
    expect(evaluateAudit(1, JSON.stringify(onlyHidden), "", []).failures).toEqual([
      expect.stringContaining("pnpm counts 1 critical advisories but lists 0"),
    ]);
    // Exceptions that the script applies itself do not explain hidden advisories either: in its run, pnpm hides none.
    expect(evaluateAudit(1, JSON.stringify(hidden), "", ["GHSA-0000-0000-0001"]).failures).toEqual([
      expect.stringContaining("pnpm counts 2 high advisories but lists 0"),
    ]);
  });

  it("lets a high or critical advisory pass only when pnpm-workspace.yaml names it", () => {
    const advisories = report([advisory(1, "high"), advisory(2, "critical"), advisory(3, "moderate")]);
    const result = evaluateAudit(1, advisories, "", ["GHSA-0000-0000-0001"]);
    expect(result.failures).toEqual([expect.stringMatching(/^critical: lodash /)]);
    expect(result.excepted).toEqual([expect.stringMatching(/^GHSA-0000-0000-0001: high: lodash /)]);
    expect(result.reported).toEqual([expect.stringMatching(/^moderate: /)]);
    expect(evaluateAudit(1, advisories, "", ["GHSA-0000-0000-0001", "GHSA-0000-0000-0002"]).failures).toEqual([]);
  });

  it("names the exceptions that match no advisory any more", () => {
    const result = evaluateAudit(1, report([advisory(1, "high")]), "", ["GHSA-0000-0000-0001", "GHSA-35jh-r3h4-6jhm"]);
    expect(result.failures).toEqual([]);
    expect(result.unusedExceptions).toEqual(["GHSA-35jh-r3h4-6jhm"]);
  });

  it("asks pnpm for every advisory, with no level hidden and none of the workspace's exceptions applied", () => {
    expect(auditArguments).toEqual(["audit", "--json", "--audit-level", "info", "--ignore-workspace"]);
  });

  it("fails on a severity it does not know", () => {
    expect(evaluateAudit(1, report([advisory(1, "severe")]), "", []).failures).toEqual([
      expect.stringContaining("unknown severity"),
    ]);
  });
});
