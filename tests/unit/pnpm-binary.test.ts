import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pnpmBinaryPin, sha512Integrity, supportedTargets } from "../../scripts/pnpm-binary.ts";

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const packageManager = (JSON.parse(read("package.json")) as { packageManager: string }).packageManager;
const lockfile = read("pnpm-lock.yaml");
const version = /^pnpm@(\d+\.\d+\.\d+)\+/.exec(packageManager)?.[1] ?? "";

const integrityA = `sha512-${"A".repeat(86)}==`;
const integrityB = `sha512-${"B".repeat(86)}==`;
function syntheticLockfile(lockedVersion: string, entries: string, secondDocument = ""): string {
  return `---
lockfileVersion: '9.0'

importers:

  .:
    configDependencies: {}
    packageManagerDependencies:
      pnpm:
        specifier: ${lockedVersion}
        version: ${lockedVersion}

packages:
${entries}
---
lockfileVersion: '9.0'
${secondDocument}`;
}
const entry = (target: string, v: string, integrity: string) =>
  `\n  '@pnpm/exe.${target}@${v}':\n    resolution: {integrity: ${integrity}}\n    cpu: [x64]\n`;

describe("pnpm native binary pins", () => {
  it("reads this repository's pin for every supported platform", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const target of supportedTargets) {
      const pin = pnpmBinaryPin(packageManager, lockfile, target);
      expect(pin.version).toBe(version);
      expect(pin.url).toBe(`https://registry.npmjs.org/@pnpm/exe.${target}/-/exe.${target}-${version}.tgz`);
      expect(Buffer.from(pin.integrity.slice("sha512-".length), "base64")).toHaveLength(64);
    }
  });

  it("refuses a lockfile that pins a different pnpm version than package.json", () => {
    const lock = syntheticLockfile("12.8.2", entry("linux-x64", version, integrityA));
    expect(() => pnpmBinaryPin(packageManager, lock, "linux-x64")).toThrow(/pins pnpm 12\.8\.2/);
  });

  it("refuses when the platform's binary has no integrity in the lockfile", () => {
    const lock = syntheticLockfile(version, entry("darwin-arm64", version, integrityA));
    expect(() => pnpmBinaryPin(packageManager, lock, "linux-x64")).toThrow(/no sha512 integrity/);
  });

  it("only trusts the first YAML document, where pnpm records itself", () => {
    const lock = syntheticLockfile(version, "", entry("linux-x64", version, integrityB));
    expect(() => pnpmBinaryPin(packageManager, lock, "linux-x64")).toThrow(/no sha512 integrity/);
    const good = syntheticLockfile(version, entry("linux-x64", version, integrityA));
    expect(pnpmBinaryPin(packageManager, good, "linux-x64").integrity).toBe(integrityA);
  });

  it("refuses unsupported platforms and an unpinned packageManager", () => {
    expect(() => pnpmBinaryPin(packageManager, lockfile, "linux-arm64")).toThrow(/no pinned pnpm build/);
    expect(() => pnpmBinaryPin("pnpm@12.9.0", lockfile, "linux-x64")).toThrow(/must pin pnpm/);
    expect(() => pnpmBinaryPin(undefined, lockfile, "linux-x64")).toThrow(/must pin pnpm/);
  });

  it("computes npm-style sha512 integrity strings", () => {
    // Reference value computed independently: printf abc | openssl dgst -sha512 -binary | base64
    expect(sha512Integrity(new TextEncoder().encode("abc"))).toBe(
      "sha512-3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==",
    );
  });
});
