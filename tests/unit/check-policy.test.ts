import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkPolicy, type PolicyInput } from "../../scripts/check-policy.ts";
import { recordedPnpmConfig } from "./fixtures/pnpm-config.ts";

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

function repositoryInput(): PolicyInput {
  const nvmrc = read(".nvmrc");
  return {
    packageJson: JSON.parse(read("package.json")),
    workspaceYaml: read("pnpm-workspace.yaml"),
    npmrc: read(".npmrc"),
    nvmrc,
    lockfileExists: true,
    nodeVersion: `v${nvmrc.trim()}`,
    userAgent: undefined,
    pnpmConfig: { config: recordedPnpmConfig },
  };
}

describe("dependency policy check", () => {
  it("accepts this repository's configuration", () => {
    expect(checkPolicy(repositoryInput())).toEqual([]);
  });

  it("rejects version ranges", () => {
    const input = repositoryInput();
    input.packageJson.devDependencies = { ...input.packageJson.devDependencies, vite: "^8.3.2" };
    expect(checkPolicy(input)).toEqual([expect.stringContaining("devDependencies.vite must be an exact version")]);
  });

  it("rejects an unpinned or unhashed package manager", () => {
    const input = repositoryInput();
    input.packageJson.packageManager = "pnpm@12.9.0";
    expect(checkPolicy(input).join("\n")).toContain("sha512");
  });

  it("rejects a missing or weakened pnpm safety setting", () => {
    for (const line of ["minimumReleaseAge: 1440", "strictDepBuilds: true", "trustPolicy: no-downgrade"]) {
      const input = repositoryInput();
      input.workspaceYaml = input.workspaceYaml.replace(line, `# ${line}`);
      expect(checkPolicy(input).join("\n")).toContain(line);
    }
  });

  it("rejects settings that bypass the policy", () => {
    for (const line of [
      "ignoreScripts: true",
      "minimumReleaseAgeExclude:\n  - foo",
      "dangerouslyAllowAllBuilds: true",
      "trustPolicyExclude:\n  - foo@1.0.0",
      "auditLevel: critical",
      "configDependencies:\n  pnpm-plugin-x: 1.0.0+sha512-abc",
    ]) {
      const input = repositoryInput();
      input.workspaceYaml += `\n${line}\n`;
      expect(checkPolicy(input), line).toHaveLength(1);
    }
  });

  // The review of X-003 changed what pnpm 12.9.0 applies with each of these lines, while the line-by-line check passed.
  it("rejects settings written in quotes or with escapes", () => {
    for (const line of [
      '"dangerouslyAllowAllBuilds": true',
      '"minimumReleaseAgeExclude": ["react"]',
      '"regis\\x74ry": "https://npm.mirror.invalid/"',
      '"audit\\x43onfig": {"ignore\\x47hsas": ["\\x47HSA-35jh-r3h4-6jhm"]}',
    ]) {
      const input = repositoryInput();
      input.workspaceYaml += `${line}\n`;
      expect(checkPolicy(input), line).toEqual([expect.stringContaining("cannot read the file with certainty")]);
    }
  });

  it("rejects what pnpm applies when it breaks the policy, wherever the setting comes from", () => {
    const input = repositoryInput();
    input.pnpmConfig = { config: { ...recordedPnpmConfig, minimumReleaseAge: 0, dangerouslyAllowAllBuilds: true } };
    expect(checkPolicy(input)).toEqual([
      expect.stringContaining("pnpm applies minimumReleaseAge = 0"),
      expect.stringContaining("dangerouslyAllowAllBuilds lets every dependency run install scripts"),
    ]);
    input.pnpmConfig = { error: "could not run pnpm config list: spawn pnpm ENOENT" };
    expect(checkPolicy(input)).toEqual([expect.stringContaining("Cannot check the settings pnpm applies")]);
  });

  it("rejects an .npmrc line it does not know, because pnpm reads registry settings there", () => {
    const input = repositoryInput();
    input.npmrc += "@acme:registry=https://npm.mirror.invalid/\n";
    expect(checkPolicy(input)).toEqual([expect.stringContaining('"@acme:registry=https://npm.mirror.invalid/"')]);
  });

  it("accepts the pinned pnpm as the running package manager", () => {
    const input = repositoryInput();
    input.userAgent = "pnpm/12.9.0 npm/? node/v24.21.0 linux x64";
    expect(checkPolicy(input)).toEqual([]);
  });

  it("rejects a different pnpm version than the pin, as reported by npm_config_user_agent", () => {
    const input = repositoryInput();
    input.userAgent = "pnpm/12.8.2 npm/? node/v24.21.0 linux x64";
    expect(checkPolicy(input)).toEqual([expect.stringContaining("pnpm 12.8.2 is running")]);
  });

  it("rejects running the check through another package manager", () => {
    const input = repositoryInput();
    input.userAgent = "npm/10.9.2 node/v24.21.0 linux x64 workspaces/false";
    expect(checkPolicy(input)).toEqual([expect.stringContaining("through pnpm only")]);
  });

  it("rejects a different Node.js version", () => {
    const input = repositoryInput();
    input.nodeVersion = "v22.22.0";
    expect(checkPolicy(input).join("\n")).toContain("Node.js v22.22.0 is running");
  });

  it("rejects a missing lockfile and missing .npmrc fences", () => {
    const input = repositoryInput();
    input.lockfileExists = false;
    input.npmrc = "";
    expect(checkPolicy(input)).toHaveLength(4);
  });
});
