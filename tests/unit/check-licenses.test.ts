import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkLicenses, noticeFiles, packageDirectories, parseLicenseFile } from "../../scripts/check-licenses.ts";

const sample = `# Licenses

The app bundles dependencies which contain the following licenses:

## clsx - 2.1.1 (MIT)

MIT License

Permission is hereby granted, free of charge.

## react-aria - 3.52.1 (Apache-2.0)

## Apache License
Version 2.0

## no-text - 1.0.0 (MIT)
`;

describe("parseLicenseFile", () => {
  it("reads each package's name, version, identifier and licence text", () => {
    const packages = parseLicenseFile(sample);
    expect(packages.map((p) => [p.name, p.version, p.identifier])).toEqual([
      ["clsx", "2.1.1", "MIT"],
      ["react-aria", "3.52.1", "Apache-2.0"],
      ["no-text", "1.0.0", "MIT"],
    ]);
    expect(packages[0]?.text).toBe("MIT License\n\nPermission is hereby granted, free of charge.");
  });

  it("does not mistake a heading inside a licence text for a new package", () => {
    expect(parseLicenseFile(sample)[1]?.text).toBe("## Apache License\nVersion 2.0");
  });
});

describe("checkLicenses", () => {
  let store: string;
  const install = (directory: string, name: string, files: Record<string, string> = {}) => {
    const packageDir = join(store, directory, "node_modules", name);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), "{}");
    for (const [file, content] of Object.entries(files)) writeFileSync(join(packageDir, file), content);
    return packageDir;
  };

  beforeEach(() => {
    store = mkdtempSync(join(tmpdir(), "bayan-licenses-"));
  });
  afterEach(() => {
    rmSync(store, { recursive: true, force: true });
  });

  it("accepts packages that have licence text and no NOTICE file", () => {
    install("clsx@2.1.1", "clsx", { LICENSE: "MIT" });
    expect(checkLicenses([{ name: "clsx", version: "2.1.1", identifier: "MIT", text: "MIT License" }], store)).toEqual(
      [],
    );
  });

  it("fails when a bundled package has no licence text", () => {
    install("no-text@1.0.0", "no-text");
    expect(checkLicenses([{ name: "no-text", version: "1.0.0", identifier: "MIT", text: "" }], store)).toEqual([
      expect.stringContaining("has no licence text"),
    ]);
  });

  it("fails when a bundled package ships a NOTICE file (Apache-2.0 section 4(d))", () => {
    install("react-aria@3.52.1_react@19.3.0", "react-aria", { "NOTICE.txt": "Copyright" });
    expect(
      checkLicenses([{ name: "react-aria", version: "3.52.1", identifier: "Apache-2.0", text: "x" }], store),
    ).toEqual([expect.stringContaining("ships NOTICE.txt")]);
  });

  it("fails closed when the licence file lists nothing or a package cannot be found", () => {
    expect(checkLicenses([], store)).toHaveLength(1);
    expect(checkLicenses([{ name: "ghost", version: "1.0.0", identifier: "MIT", text: "x" }], store)).toEqual([
      expect.stringContaining("is not installed"),
    ]);
  });

  it("finds store directories by name and version, with peer-dependency suffixes and scoped names", () => {
    const plain = install("react-dom@19.3.0_react@19.3.0", "react-dom");
    const scoped = install("@scope+pkg@1.0.0", "@scope/pkg");
    install("foo@1.0.10", "foo");
    expect(packageDirectories(store, "react-dom", "19.3.0")).toEqual([plain]);
    expect(packageDirectories(store, "@scope/pkg", "1.0.0")).toEqual([scoped]);
    // 1.0.1 must not match the directory of 1.0.10.
    expect(packageDirectories(store, "foo", "1.0.1")).toEqual([]);
  });

  it("recognises the usual NOTICE file names", () => {
    const dir = install("x@1.0.0", "x", { NOTICE: "", "notice.md": "", "NOTICES.txt": "", LICENSE: "" });
    expect(noticeFiles(dir).sort()).toEqual(["NOTICE", "NOTICES.txt", "notice.md"]);
  });
});
