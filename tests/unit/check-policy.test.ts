import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkPolicy, type PolicyInput } from "../../scripts/check-policy.ts";

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
    ]) {
      const input = repositoryInput();
      input.workspaceYaml += `\n${line}\n`;
      expect(checkPolicy(input)).toHaveLength(1);
    }
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
