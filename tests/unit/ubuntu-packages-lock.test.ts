// deps/ubuntu-packages.lock, the workflows that install it, and scripts/dev-setup.sh's apt pins (work package X-005; ADR-0017,
// amendment of 2026-11-05), following bayan-desktop's tests/ubuntu-packages/test_lock.py.
//
// The Ubuntu entry of ci.yml's verify job runs in a container from the base image that the lock's header names, and installs exactly the
// package files that the lock lists, with scripts/ubuntu-packages.sh. These tests check that the lock is well formed, as the script's lock
// command writes it; that its snapshot date is not before its base image was created (a package of an older date could need an older
// version of a library than the image has); that every package it unpacks is configured afterwards, at the same version; that every job
// that installs it runs in that base image, so that the plan apt made for that image is the one that dpkg replays; and that no workflow
// runs apt or names a snapshot date, so the lock is the only place where CI's packages are chosen. On developers' machines
// scripts/dev-setup.sh still installs the browsers' libraries with apt, from APT_PACKAGES at APT_SNAPSHOT; every one of those packages
// must be a requested package of the lock, and the date the lock's, so that in the container dev-setup finds them all installed and never
// falls back to apt. Each check is also tested on a broken example, so that a check that can no longer fail is noticed. The files are
// read as text.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");
const lockFile = join(root, "deps/ubuntu-packages.lock");
const workflowFolder = join(root, ".github/workflows");
const devSetupFile = join(root, "scripts/dev-setup.sh");
const installCommand = "scripts/ubuntu-packages.sh install";

const imagePattern = /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/;
const createdPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
const snapshotPattern = /^\d{8}T\d{6}Z$/;
const packagePattern = /^[a-z0-9][a-z0-9.+-]+$/;
const versionPattern = /^[0-9][0-9A-Za-z.+~:-]*$/;
// pool/<component>/<prefix>/<source package>/<file>; neither directory may be "." or "..".
const poolPattern = /^pool\/[a-z0-9-]+\/(?!\.\.?\/)[a-z0-9+.-]+\/(?!\.\.?\/)[a-z0-9+.-]+\/[A-Za-z0-9+.~_-]+\.deb$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

type Step =
  | { op: "unpack"; name: string; version: string; architecture: string; pool: string; size: number; sha256: string }
  | { op: "configure"; name: string; version: string };

interface Lock {
  image: string;
  /** The image's creation time as Docker reports it, such as 2026-10-26T23:50:00.169696607Z. */
  created: string;
  architecture: string;
  /** The snapshot ID, such as 20261111T000000Z. */
  snapshot: string;
  requests: string[];
  /** apt's plan, in its order. */
  steps: Step[];
}

/** A time as "YYYYMMDDHHMMSS" and nine digits of the fraction of a second, which sort as text in the order of time. */
function createdDigits(created: string): string {
  const [, year, month, day, hour, minute, second, fraction = ""] = createdPattern.exec(created) ?? [];
  return `${year}${month}${day}${hour}${minute}${second}${fraction.padEnd(9, "0")}`;
}

function snapshotDigits(snapshot: string): string {
  return `${snapshot.slice(0, 8)}${snapshot.slice(9, 15)}000000000`;
}

/** Reads a lock as scripts/ubuntu-packages.sh writes it; throws an error that names the line for anything else. */
function parseLock(text: string): Lock {
  const header = new Map<string, string>();
  const requests: string[] = [];
  const steps: Step[] = [];
  const expected = ["format", "image", "created", "architecture", "snapshot"];
  text.split("\n").forEach((line, index) => {
    const number = index + 1;
    if (line.trim() === "" || line.startsWith("#")) return;
    const words = line.split(" ");
    const key = expected.shift();
    if (key !== undefined) {
      if (words.length !== 2 || words[0] !== key)
        throw new Error(`line ${number}: expected "${key} <value>", found ${line}`);
      header.set(key, words[1] ?? "");
      return;
    }
    const [op = "", name = "", version = "", architecture = "", pool = "", size = "", sha256 = ""] = words;
    if (op === "request" && steps.length === 0) {
      if (words.length !== 2 || !packagePattern.test(name))
        throw new Error(`line ${number}: not a requested package: ${line}`);
      requests.push(name);
    } else if (op === "unpack" && words.length === 7) {
      if (!packagePattern.test(name) || !versionPattern.test(version) || !["amd64", "all"].includes(architecture)) {
        throw new Error(`line ${number}: malformed package, version or architecture: ${line}`);
      }
      const plainVersion = version.slice(version.indexOf(":") + 1);
      if (
        !poolPattern.test(pool) ||
        pool.slice(pool.lastIndexOf("/") + 1) !== `${name}_${plainVersion}_${architecture}.deb`
      ) {
        throw new Error(`line ${number}: not the pool path of ${name} ${version}: ${pool}`);
      }
      if (!/^[1-9][0-9]*$/.test(size) || !sha256Pattern.test(sha256)) {
        throw new Error(`line ${number}: malformed size or SHA-256: ${line}`);
      }
      steps.push({ op: "unpack", name, version, architecture, pool, size: Number(size), sha256 });
    } else if (op === "configure" && words.length === 3 && requests.length > 0) {
      steps.push({ op: "configure", name, version });
    } else {
      throw new Error(`line ${number}: unexpected line ${line}`);
    }
  });
  if (expected.length > 0) throw new Error(`the header has no "${expected[0]}" line`);
  const value = (key: string): string => header.get(key) ?? "";
  if (value("format") !== "1") throw new Error(`unknown format ${value("format")}`);
  if (!imagePattern.test(value("image"))) throw new Error(`not an image with a digest: ${value("image")}`);
  if (!createdPattern.test(value("created"))) throw new Error(`not a UTC time: ${value("created")}`);
  if (!snapshotPattern.test(value("snapshot"))) throw new Error(`not a snapshot ID: ${value("snapshot")}`);
  if (requests.length === 0) throw new Error("no requested packages");
  if (requests.join(" ") !== [...new Set(requests)].sort().join(" ")) {
    throw new Error("the requested packages must be sorted and named once");
  }
  if (steps.length === 0) throw new Error("no plan");
  return {
    image: value("image"),
    created: value("created"),
    architecture: value("architecture"),
    snapshot: value("snapshot"),
    requests,
    steps,
  };
}

/** What is wrong with a lock that parses: its dates, its architecture, and the order of its plan. */
function lockProblems(lock: Lock): string[] {
  const problems: string[] = [];
  if (lock.architecture !== "amd64") problems.push(`the architecture is ${lock.architecture}, not amd64`);
  if (snapshotDigits(lock.snapshot) < createdDigits(lock.created)) {
    problems.push(`the snapshot date ${lock.snapshot} is before the base image was created (${lock.created})`);
  }
  const unpacked = new Map<string, string>();
  const configured = new Set<string>();
  const files = new Set<string>();
  for (const step of lock.steps) {
    if (step.op === "unpack") {
      if (unpacked.has(step.name)) problems.push(`${step.name} is unpacked twice`);
      if (files.has(step.pool)) problems.push(`${step.pool} is listed twice`);
      unpacked.set(step.name, step.version);
      files.add(step.pool);
    } else {
      if (unpacked.get(step.name) !== step.version) {
        problems.push(`${step.name} ${step.version} is configured, but not unpacked before at that version`);
      }
      if (configured.has(step.name)) problems.push(`${step.name} is configured twice`);
      configured.add(step.name);
    }
  }
  for (const name of [...unpacked.keys()].sort()) {
    if (!configured.has(name)) problems.push(`${name} is unpacked but never configured`);
  }
  return problems;
}

/** A YAML scalar without its trailing comment and quotes (enough for the plain values these workflows use). */
function stripComment(value: string): string {
  return value
    .replace(/\s+#.*$/, "")
    .trim()
    .replace(/^['"]+|['"]+$/g, "");
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** A line that is a key of a mapping, possibly the first key of a list item: its indent (of the key), its name and its value. */
function keyOf(line: string): { indent: number; key: string; value: string } | undefined {
  const match = /^(\s*)(- )?([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line);
  if (match === null) return undefined;
  const [, spaces = "", dash = "", key = "", value = ""] = match;
  return { indent: spaces.length + dash.length, key, value: stripComment(value) };
}

/** The jobs of a workflow, each with the lines of its body; blank lines and comment lines are left out. */
function jobBodies(workflow: string): Map<string, string[]> {
  const jobs = new Map<string, string[]>();
  let inJobs = false;
  let jobIndent: number | undefined;
  let current: string[] | undefined;
  for (const line of workflow.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = indentOf(line);
    if (indent === 0) {
      inJobs = line.trimEnd() === "jobs:";
      current = undefined;
      continue;
    }
    if (!inJobs) continue;
    jobIndent ??= indent;
    if (indent === jobIndent) {
      const job = keyOf(line);
      current = job === undefined ? undefined : [];
      if (job !== undefined && current !== undefined) jobs.set(job.key, current);
      continue;
    }
    current?.push(line);
  }
  return jobs;
}

/** The value of the `image:` key of the mapping that starts below line `index`, whose key is indented by `keyIndent`. */
function mappingImage(body: string[], index: number, keyIndent: number): string[] {
  for (const line of body.slice(index + 1)) {
    if (indentOf(line) <= keyIndent) break;
    const entry = keyOf(line);
    if (entry?.key === "image") return [entry.value];
  }
  return [];
}

/**
 * The images a job's container comes from: the value of its `container:` key, or of that mapping's `image:` key, or, when the value is
 * an expression on the matrix (such as `${{ matrix.container || '' }}`), every value that the job's matrix gives that key. Null when the
 * job has no container.
 */
function containerImages(body: string[]): string[] | null {
  const propertyIndent = indentOf(body[0] ?? "");
  const index = body.findIndex((line) => indentOf(line) === propertyIndent && keyOf(line)?.key === "container");
  const container = keyOf(body[index] ?? "");
  if (index < 0 || container === undefined) return null;
  if (container.value === "") return mappingImage(body, index, container.indent);
  if (!container.value.startsWith("${{")) return [container.value];
  const matrixKey = /^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)/.exec(container.value)?.[1];
  const images: string[] = [];
  body.forEach((line, lineIndex) => {
    const entry = keyOf(line);
    if (lineIndex === index || entry === undefined || entry.key !== matrixKey) return;
    images.push(...(entry.value === "" ? mappingImage(body, lineIndex, entry.indent) : [entry.value]));
  });
  return images;
}

/** The jobs of a workflow that run the install command, each with the images of its container (null if it has none). */
function installingJobs(workflow: string): Map<string, string[] | null> {
  const result = new Map<string, string[] | null>();
  for (const [job, body] of jobBodies(workflow)) {
    if (body.some((line) => line.includes(installCommand))) result.set(job, containerImages(body));
  }
  return result;
}

// apt, its --snapshot option, or a snapshot ID such as 20261111T000000Z (for example a workflow variable that holds one).
const aptCommand =
  /\bapt(?:-get)?\s+(?:-\S+\s+)*(?:install|update|upgrade|dist-upgrade|full-upgrade)\b|--snapshot\b|\bapt-get\b|\b\d{8}T\d{6}Z\b/;

/** The lines of a workflow, comments aside (whole comment lines and trailing comments), that run apt or name a snapshot date. */
function aptLines(workflow: string): string[] {
  return workflow
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#") && aptCommand.test(stripComment(line)))
    .map((line) => line.trim());
}

function workflows(): Map<string, string> {
  const names = readdirSync(workflowFolder).filter((name) => name.endsWith(".yml"));
  return new Map(names.sort().map((name) => [name, readFileSync(join(workflowFolder, name), "utf8")]));
}

/** What is wrong with scripts/dev-setup.sh's apt pins (APT_PACKAGES and APT_SNAPSHOT) against the lock. */
function devSetupProblems(devSetup: string, lock: Lock): string[] {
  const snapshot = /^APT_SNAPSHOT=(\S+)/m.exec(devSetup)?.[1];
  const list = /^APT_PACKAGES='([^']*)'/m.exec(devSetup)?.[1];
  const packages = (list ?? "").split(/\s+/).filter((name) => name !== "");
  const problems: string[] = [];
  if (packages.length === 0) problems.push("scripts/dev-setup.sh has no APT_PACKAGES list");
  const requested = new Set(lock.requests);
  for (const name of packages) {
    if (!requested.has(name)) problems.push(`${name} is in APT_PACKAGES, but the lock does not request it`);
  }
  if (snapshot !== lock.snapshot)
    problems.push(`APT_SNAPSHOT is ${snapshot ?? "missing"}, but the lock's snapshot is ${lock.snapshot}`);
  return problems;
}

describe("deps/ubuntu-packages.lock", () => {
  const lock = parseLock(readFileSync(lockFile, "utf8"));

  it("is well formed, and its plan configures every package it unpacks", () => {
    expect(lockProblems(lock)).toEqual([]);
  });

  it("is installed only by jobs that run in its base image", () => {
    const found = new Map<string, string[] | null>();
    for (const [name, text] of workflows()) {
      for (const [job, images] of installingJobs(text)) found.set(`${name}: ${job}`, images);
    }
    for (const [job, images] of found) {
      expect(images, `${job} installs the lock without a container`).not.toBeNull();
      expect(images, `${job}: no image found for its container`).not.toEqual([]);
      for (const image of images ?? [])
        expect(image, `${job} runs in another image than the lock's header names`).toBe(lock.image);
    }
    // The job X-005 moved into a container; if the reader stopped finding it, the check above would pass without checking anything.
    expect([...found.keys()]).toContain("ci.yml: verify");
  });

  it("is the only place where CI's Ubuntu packages are chosen: no workflow runs apt or names a snapshot date", () => {
    for (const [name, text] of workflows()) {
      expect(aptLines(text), `${name} runs apt or names a snapshot date; install from the lock instead`).toEqual([]);
    }
  });

  it("requests every package of scripts/dev-setup.sh's APT_PACKAGES, at its APT_SNAPSHOT", () => {
    expect(devSetupProblems(readFileSync(devSetupFile, "utf8"), lock)).toEqual([]);
  });
});

const exampleLock = `# comment
format 1
image docker.io/library/buildpack-deps:noble-scm@sha256:94ed690dd634b8b2f531eaa742fde9b1264077cd8ea695a3b960bd104ae4c481
created 2026-10-26T23:50:00.169696607Z
architecture amd64
snapshot 20261111T000000Z
request hello
unpack libhello1 1:1.0-1 amd64 pool/main/h/hello/libhello1_1.0-1_amd64.deb 1234 0000000000000000000000000000000000000000000000000000000000000001
unpack hello 2.10-3build2 amd64 pool/main/h/hello/hello_2.10-3build2_amd64.deb 5678 0000000000000000000000000000000000000000000000000000000000000002
configure libhello1 1:1.0-1
configure hello 2.10-3build2
`;

const baseImage =
  "docker.io/library/buildpack-deps:noble-scm@sha256:94ed690dd634b8b2f531eaa742fde9b1264077cd8ea695a3b960bd104ae4c481";
const otherImage =
  "docker.io/library/ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852";

const exampleWorkflow = `name: Example
on:
  pull_request:
jobs:
  inside:
    runs-on: ubuntu-24.04
    container:
      image: ${baseImage} # created 2026-10-26
    steps:
      - run: sh scripts/ubuntu-packages.sh install deps/ubuntu-packages.lock "$RUNNER_TEMP/ubuntu-packages"
  inline:
    runs-on: ubuntu-24.04
    container: ${otherImage}
    steps:
      - name: Install
        run: |
          sh scripts/ubuntu-packages.sh install deps/ubuntu-packages.lock "$RUNNER_TEMP/ubuntu-packages"
  outside:
    runs-on: ubuntu-24.04
    steps:
      - run: sh scripts/ubuntu-packages.sh install deps/ubuntu-packages.lock /tmp/cache
  matrix:
    strategy:
      matrix:
        runner: [ubuntu-24.04, macos-15]
        include:
          - runner: ubuntu-24.04
            container:
              image: ${baseImage} # created 2026-10-26
              options: --init
    runs-on: \${{ matrix.runner }}
    container: \${{ matrix.container || '' }}
    steps:
      - if: \${{ runner.os == 'Linux' }}
        run: sh scripts/ubuntu-packages.sh install deps/ubuntu-packages.lock "$RUNNER_TEMP/ubuntu-packages"
  matrix-other:
    strategy:
      matrix:
        include:
          - runner: ubuntu-24.04
            box: ${otherImage}
    runs-on: \${{ matrix.runner }}
    container: \${{ matrix.box }}
    steps:
      - run: sh scripts/ubuntu-packages.sh install deps/ubuntu-packages.lock "$RUNNER_TEMP/ubuntu-packages"
  other:
    runs-on: ubuntu-24.04
    steps:
      # sh scripts/ubuntu-packages.sh install is only mentioned here
      - run: echo hello
`;

const exampleDevSetup = `#!/usr/bin/env bash
APT_SNAPSHOT=20261111T000000Z # the lock's snapshot
APT_PACKAGES='
  hello
'
`;

describe("the checks of the lock themselves, on broken examples", () => {
  it("pass a lock as the script writes it", () => {
    const lock = parseLock(exampleLock);
    expect(lockProblems(lock)).toEqual([]);
    expect(lock.requests).toEqual(["hello"]);
    expect(lock.steps).toHaveLength(4);
  });

  it("find a snapshot date before the image was created", () => {
    let lock = parseLock(exampleLock.replace("snapshot 20261111T000000Z", "snapshot 20261026T000000Z"));
    expect(lockProblems(lock)).toHaveLength(1);
    expect(lockProblems(lock)[0]).toContain("before the base image was created");
    // The same second as the creation, but the image was created a fraction of a second later.
    lock = parseLock(exampleLock.replace("snapshot 20261111T000000Z", "snapshot 20261026T235000Z"));
    expect(lockProblems(lock)[0]).toContain("before the base image was created");
    lock = parseLock(exampleLock.replace("snapshot 20261111T000000Z", "snapshot 20261026T235001Z"));
    expect(lockProblems(lock)).toEqual([]);
  });

  it("find a package that is unpacked but not configured, or configured at another version", () => {
    let lock = parseLock(exampleLock.replace("configure hello 2.10-3build2\n", ""));
    expect(lockProblems(lock)).toEqual(["hello is unpacked but never configured"]);
    lock = parseLock(exampleLock.replace("configure hello 2.10-3build2", "configure hello 2.10-3"));
    expect(lockProblems(lock)).toContain("hello 2.10-3 is configured, but not unpacked before at that version");
  });

  it("find a package configured before it is unpacked", () => {
    const lines = exampleLock.split("\n");
    // configure libhello1 first, then the two unpack lines
    const reordered = [...lines.slice(0, 7), lines[9] ?? "", ...lines.slice(7, 9), ...lines.slice(10)].join("\n");
    expect(lockProblems(parseLock(reordered))).toContain(
      "libhello1 1:1.0-1 is configured, but not unpacked before at that version",
    );
  });

  const broken: Array<[string, string]> = [
    ["no digest", exampleLock.replace("@sha256:94ed690dd634b8b2f531eaa742fde9b1264077cd8ea695a3b960bd104ae4c481", "")],
    ["unsorted requests", exampleLock.replace("request hello\n", "request hello\nrequest abc\n")],
    [
      "a pool path of another package",
      exampleLock.replace("pool/main/h/hello/hello_2.10", "pool/main/h/hello/other_2.10"),
    ],
    ["a path outside the pool", exampleLock.replace("pool/main/h/hello/hello_", "pool/../h/hello/hello_")],
    ["'..' as pool directories", exampleLock.replace("pool/main/h/hello/hello_", "pool/main/../../hello_")],
    ["'.' as a pool directory", exampleLock.replace("pool/main/h/hello/hello_", "pool/main/h/./hello_")],
    ["a short SHA-256", exampleLock.replace("0000000000000000000000000000000000000000000000000000000000000002", "02")],
    ["an unknown line", `${exampleLock}remove hello\n`],
    ["a missing header line", exampleLock.replace("architecture amd64\n", "")],
    ["no plan", `${exampleLock.split("\n").slice(0, 7).join("\n")}\n`],
  ];
  for (const [name, text] of broken) {
    it(`refuse a malformed lock (${name})`, () => {
      expect(() => parseLock(text)).toThrow();
    });
  }

  it("find a job in another image or without a container, also when its container comes from the matrix", () => {
    const jobs = installingJobs(exampleWorkflow);
    expect(Object.fromEntries(jobs)).toEqual({
      inside: [baseImage],
      inline: [otherImage],
      outside: null,
      matrix: [baseImage],
      "matrix-other": [otherImage],
    });
  });

  it("find a workflow that runs apt or names a snapshot date", () => {
    expect(aptLines(exampleWorkflow)).toEqual([]);
    expect(aptLines("      - run: sudo apt-get install -y libgl-dev\n")).toHaveLength(1);
    expect(aptLines("      - run: apt -y install zstd\n")).toHaveLength(1);
    expect(aptLines("      run: dpkg-query --snapshot 1\n")).toHaveLength(1);
    expect(aptLines("      # sudo apt-get update --snapshot 20261027T000000Z\n")).toHaveLength(0);
    // A bare snapshot ID outside a comment, such as the value of a variable for apt, is found; one only in a comment is not.
    expect(aptLines("  UBUNTU_SNAPSHOT: 20261027T000000Z # for apt --snapshot\n")).toHaveLength(1);
    expect(aptLines("        run: echo 20261111T000000Z\n")).toHaveLength(1);
    expect(aptLines("    # the lock's snapshot, 20261111T000000Z\n")).toHaveLength(0);
    expect(
      aptLines(`      image: ${baseImage} # created 2026-10-26T23:50:00Z, snapshot 20261111T000000Z\n`),
    ).toHaveLength(0);
  });

  it("find a package of APT_PACKAGES that the lock does not request, and an APT_SNAPSHOT other than the lock's", () => {
    const lock = parseLock(exampleLock);
    expect(devSetupProblems(exampleDevSetup, lock)).toEqual([]);
    expect(devSetupProblems(exampleDevSetup.replace("  hello\n", "  hello libnew1\n"), lock)).toEqual([
      "libnew1 is in APT_PACKAGES, but the lock does not request it",
    ]);
    expect(devSetupProblems(exampleDevSetup.replace("=20261111T000000Z", "=20261025T000000Z"), lock)).toEqual([
      "APT_SNAPSHOT is 20261025T000000Z, but the lock's snapshot is 20261111T000000Z",
    ]);
    expect(devSetupProblems("#!/usr/bin/env bash\n", lock)).toEqual([
      "scripts/dev-setup.sh has no APT_PACKAGES list",
      "APT_SNAPSHOT is missing, but the lock's snapshot is 20261111T000000Z",
    ]);
  });
});
