import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkAllowBuilds, checkPolicy, type PolicyInput } from "../../scripts/check-policy.ts";

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
    ]) {
      const input = repositoryInput();
      input.workspaceYaml += `\n${line}\n`;
      expect(checkPolicy(input)).toHaveLength(1);
    }
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

describe("allowBuilds check", () => {
  const yaml = (allowBuilds: string) => `strictDepBuilds: true\n${allowBuilds}\ntrustPolicy: no-downgrade\n`;

  it('accepts "allowBuilds: {}"', () => {
    expect(checkAllowBuilds(yaml("allowBuilds: {}"))).toEqual([]);
  });

  it('accepts explicit denials such as "fsevents: false"', () => {
    expect(checkAllowBuilds(yaml("allowBuilds:\n  fsevents: false"))).toEqual([]);
    expect(checkAllowBuilds(yaml("allowBuilds:\n  fsevents: false\n  '@scope/pkg': false\n  # a comment"))).toEqual([]);
  });

  it("rejects a true entry, even one hidden after a comment or blank line", () => {
    expect(checkAllowBuilds(yaml("allowBuilds:\n  esbuild: true"))).toEqual([expect.stringContaining("must not let")]);
    expect(checkAllowBuilds(yaml("allowBuilds:\n  fsevents: false\n# note\n\n  esbuild: true"))).toEqual([
      expect.stringContaining("must not let"),
    ]);
  });

  it("rejects flow-style maps", () => {
    expect(checkAllowBuilds(yaml("allowBuilds: { fsevents: false }"))).toHaveLength(1);
    expect(checkAllowBuilds(yaml("allowBuilds: {esbuild: true}"))).toHaveLength(1);
  });

  it("fails closed on anything it cannot read with certainty", () => {
    for (const block of [
      "allowBuilds:\n  fsevents: no",
      "allowBuilds:\n  fsevents: false # macOS",
      "allowBuilds:\n    fsevents: false",
      "allowBuilds:\n\tfsevents: false",
      "allowBuilds: {}\n  esbuild: false",
      "allowBuilds:",
      "allowBuilds: null",
    ]) {
      expect(checkAllowBuilds(yaml(block)), block).not.toEqual([]);
    }
  });

  it("requires allowBuilds exactly once", () => {
    expect(checkAllowBuilds("strictDepBuilds: true\n")).toHaveLength(1);
    expect(checkAllowBuilds(yaml("allowBuilds: {}\n'allowBuilds':\n  esbuild: true"))).toHaveLength(1);
  });
});
