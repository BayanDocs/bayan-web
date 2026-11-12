// scripts/ubuntu-packages.sh (work package X-005; ADR-0017, amendment of 2026-11-05), the same file, byte for byte, as bayan-desktop's,
// whose tests/ubuntu-packages/test_script.py these tests follow. Linux only: CI runs the script in its Linux container, and the script
// needs GNU's sha256sum. Needs sh, curl and openssl.
//
// fetch: every source is the same local HTTPS server under a different path, with a certificate made for the test run by openssl, which
// curl trusts through CURL_CA_BUNDLE; the stall limit is shortened through UBUNTU_PACKAGES_STALL_SECONDS. The tests show that a failed
// download moves to the next source, that a source that accepts the connection and then sends nothing moves to the next one within the
// stall limit, that the job stops and names the file and every source's error when all of them fail, that a size or SHA-256 mismatch
// stops the job without trying another source, that a redirect to an http:// address is refused, and that a file already in the cache
// folder is checked and, if it does not match, stops the job with the message that says how to recover.
//
// lock: a stand-in for the Docker client (the DOCKER variable) reports an image and prints, for `docker run`, what apt would print in the
// image. The tests show that the command writes the same lock for the same inputs, in whatever order the packages are given and again
// from the lock itself (--from), and that it refuses a snapshot date before the image's creation or not before the cutoff, a cutoff less
// than 24 hours ago, a plan that would remove a package, and a package that the verified index does not have, without writing a lock.
//
// install: stand-ins for dpkg, dpkg-query and id, first on PATH, so the tests change nothing on the machine and pass as any user.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "../../scripts/ubuntu-packages.sh");
const image =
  "docker.io/library/buildpack-deps:noble-scm@sha256:94ed690dd634b8b2f531eaa742fde9b1264077cd8ea695a3b960bd104ae4c481";
const snapshot = "20261111T000000Z";
const onLinux = process.platform === "linux";
const folders: string[] = [];

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function folder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  folders.push(dir);
  return dir;
}

interface Package {
  name: string;
  version: string;
  architecture: string;
  /** The file's name in the pool: package, version without its epoch, architecture. */
  file: string;
  pool: string;
  content: Buffer;
  sha256: string;
}

function makePackage(
  name: string,
  version: string,
  architecture: string,
  poolFolder: string,
  content: string,
): Package {
  const plainVersion = version.slice(version.indexOf(":") + 1);
  const file = `${name}_${plainVersion}_${architecture}.deb`;
  const data = Buffer.from(content);
  return { name, version, architecture, file, pool: `${poolFolder}/${file}`, content: data, sha256: sha256(data) };
}

const packages: [Package, Package] = [
  makePackage("libhello1", "1:1.0-1ubuntu0.1", "amd64", "pool/main/h/hello", "first package file\n".repeat(1000)),
  makePackage("hello-data", "2.10-3build2", "all", "pool/universe/h/hello", "second package file\n".repeat(1500)),
];
const [first, second] = packages;

function lockText(): string {
  return [
    "# A lock for the tests",
    "format 1",
    `image ${image}`,
    "created 2026-10-26T23:50:00.169696607Z",
    "architecture amd64",
    `snapshot ${snapshot}`,
    "request hello",
    ...packages.map((p) => `unpack ${p.name} ${p.version} ${p.architecture} ${p.pool} ${p.content.length} ${p.sha256}`),
    ...packages.map((p) => `configure ${p.name} ${p.version}`),
    "",
  ].join("\n");
}

/** The environment for the script: without proxies (the servers are local) and without the job summary of GitHub Actions. */
function cleanEnvironment(extra: Record<string, string>): Record<string, string> {
  const removed = new Set([
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "curl_ca_bundle",
    "github_step_summary",
  ]);
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !removed.has(name.toLowerCase())) environment[name] = value;
  }
  return { ...environment, ...extra };
}

interface Result {
  status: number | null;
  stdout: Buffer;
  stderr: string;
}

/** Runs the script with sh, without blocking this process, whose event loop serves the downloads. */
function run(args: string[], env: Record<string, string>): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", [script, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout: Buffer.concat(stdout), stderr });
    });
  });
}

type Source = "snapshot" | "launchpad" | "archive";
/** What a source does for every request: the right file, 404, accept and send nothing, a wrong file, or a redirect to http://. */
type Behaviour = "serve" | "missing" | "stall" | "wrong-size" | "wrong-hash" | "redirect-http";

/** One HTTPS server for the three sources (paths /snapshot, /launchpad and /archive) and one plain HTTP server, both local. */
class Sources {
  behaviour: Partial<Record<Source, Behaviour>> = {};
  /** Every request to the HTTPS server, as [source, file name]. */
  requests: Array<[string, string]> = [];
  /** Every request to the plain HTTP server. */
  httpRequests: string[] = [];
  readonly certificate: string;
  private readonly https: Server;
  private readonly http: Server;

  constructor(dir: string) {
    const key = join(dir, "server.key");
    this.certificate = join(dir, "server.crt");
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", this.certificate, "-days", "1"].concat([
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ]),
      { stdio: "ignore" },
    );
    // TLS 1.2 or newer, as the script's curl requires (--tlsv1.2).
    this.https = createHttpsServer(
      { key: readFileSync(key), cert: readFileSync(this.certificate), minVersion: "TLSv1.2" },
      (request, response) => this.answer(request, response),
    );
    this.http = createHttpServer((request, response) => {
      this.httpRequests.push(request.url ?? "");
      response.writeHead(404).end();
    });
  }

  async listen(): Promise<void> {
    for (const server of [this.https, this.http]) {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    }
  }

  async close(): Promise<void> {
    for (const server of [this.https, this.http]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  url(source: Source): string {
    return `https://127.0.0.1:${(this.https.address() as AddressInfo).port}/${source}`;
  }

  get httpPort(): number {
    return (this.http.address() as AddressInfo).port;
  }

  private answer(request: IncomingMessage, response: ServerResponse): void {
    const path = (request.url ?? "").replace(/^\/+/, "");
    const slash = path.indexOf("/");
    const source = slash < 0 ? path : path.slice(0, slash);
    const rest = slash < 0 ? "" : path.slice(slash + 1);
    const name = rest.slice(rest.lastIndexOf("/") + 1);
    this.requests.push([source, name]);
    const found = packages.find((p) => p.file === name);
    const expected: Record<string, string | undefined> = {
      snapshot: found && `${snapshot}/${found.pool}`,
      launchpad: name,
      archive: found?.pool,
    };
    let what: Behaviour = this.behaviour[source as Source] ?? "missing";
    if (found === undefined || rest !== expected[source]) what = "missing";
    if (what === "stall") return; // the response stays open, without a byte, until curl gives up or the server closes
    if (what === "redirect-http") {
      // A fixed address, nothing taken from the request.
      response.writeHead(302, { Location: `http://127.0.0.1:${this.httpPort}/redirected.deb`, "Content-Length": "0" });
      response.end();
      return;
    }
    if (found === undefined || what === "missing") {
      response.writeHead(404).end();
      return;
    }
    let body = found.content;
    if (what === "wrong-size") body = Buffer.concat([body, Buffer.from("!")]);
    if (what === "wrong-hash") body = Buffer.concat([Buffer.from("X"), body.subarray(1)]);
    response.writeHead(200, { "Content-Length": String(body.length) });
    response.end(body);
  }
}

afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!onLinux)("ubuntu-packages.sh fetch", { timeout: 60_000 }, () => {
  let sources: Sources;
  let certificates: string;
  let lock: string;
  let cache: string;
  let report: string;

  beforeAll(async () => {
    certificates = mkdtempSync(join(tmpdir(), "ubuntu-packages-certificate-"));
    sources = new Sources(certificates);
    await sources.listen();
  });

  afterAll(async () => {
    await sources.close();
    rmSync(certificates, { recursive: true, force: true });
  });

  beforeEach(() => {
    sources.requests = [];
    sources.httpRequests = [];
    sources.behaviour = {};
    const work = folder("ubuntu-packages-fetch-");
    lock = join(work, "ubuntu-packages.lock");
    writeFileSync(lock, lockText());
    cache = join(work, "cache");
    report = join(work, "report");
  });

  function fetchWith(behaviour: Partial<Record<Source, Behaviour>>): Promise<Result> {
    sources.behaviour = behaviour;
    const env = cleanEnvironment({
      CURL_CA_BUNDLE: sources.certificate,
      UBUNTU_PACKAGES_SNAPSHOT_URL: sources.url("snapshot"),
      UBUNTU_PACKAGES_LAUNCHPAD_URL: sources.url("launchpad"),
      UBUNTU_PACKAGES_ARCHIVE_URL: sources.url("archive"),
      UBUNTU_PACKAGES_STALL_SECONDS: "2",
    });
    return run(["fetch", "--report", report, lock, cache], env);
  }

  /** The counts of fetch's report: files, bytes and how many files came from each place. */
  function reportCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const line of readFileSync(report, "utf8").trim().split("\n")) {
      const [key = "", value = ""] = line.split(" ");
      if (key !== "seconds") counts[key] = Number(value);
    }
    return counts;
  }

  function expectCacheHoldsEveryFile(): void {
    expect(readdirSync(cache).sort()).toEqual(packages.map((p) => p.file).sort());
    for (const p of packages) expect(readFileSync(join(cache, p.file)).equals(p.content)).toBe(true);
  }

  it("downloads every file from the first source and checks it", async () => {
    const result = await fetchWith({ snapshot: "serve", launchpad: "serve", archive: "serve" });
    expect(result.status, result.stderr).toBe(0);
    expectCacheHoldsEveryFile();
    expect([...sources.requests].sort()).toEqual(packages.map((p) => ["snapshot", p.file]).sort());
    const counts = reportCounts();
    expect([counts["files"], counts["snapshot"], counts["launchpad"], counts["archive"], counts["cache"]]).toEqual([
      2, 2, 0, 0, 0,
    ]);
    expect(counts["bytes"]).toBe(first.content.length + second.content.length);
  });

  it("moves to the next source when a download fails", async () => {
    let result = await fetchWith({ snapshot: "missing", launchpad: "serve", archive: "serve" });
    expect(result.status, result.stderr).toBe(0);
    expectCacheHoldsEveryFile();
    expect(reportCounts()["launchpad"]).toBe(2);
    // Each failed attempt is in the log with its error, so a summary that counts files from a later source can be explained.
    for (const p of packages) {
      expect(result.stderr).toContain(
        `${p.file}: could not download from ${sources.url("snapshot")}/${snapshot}/${p.pool} (curl: (22)`,
      );
    }
    expect(result.stderr).toContain("404); trying the next source");
    result = await fetchWith({ snapshot: "missing", launchpad: "missing", archive: "serve" });
    expect(result.status, result.stderr).toBe(0);
    expect(reportCounts()["cache"]).toBe(2); // the files of the first run are now in the cache folder
    rmSync(cache, { recursive: true });
    result = await fetchWith({ snapshot: "missing", launchpad: "missing", archive: "serve" });
    expect(result.status, result.stderr).toBe(0);
    expect(reportCounts()["archive"]).toBe(2);
  });

  it("moves from a stalled source to the next one within the time limit", async () => {
    const started = performance.now();
    const result = await fetchWith({ snapshot: "stall", launchpad: "serve", archive: "serve" });
    const elapsed = (performance.now() - started) / 1000;
    expect(result.status, result.stderr).toBe(0);
    expectCacheHoldsEveryFile();
    expect(reportCounts()["launchpad"]).toBe(2);
    // The stall limit is 2 seconds here (30 by default); both files download at the same time.
    expect(elapsed).toBeGreaterThanOrEqual(2);
    expect(elapsed).toBeLessThan(20);
  });

  it("stops and names the file and each source's error when every source fails", async () => {
    const result = await fetchWith({ snapshot: "missing", launchpad: "stall", archive: "redirect-http" });
    expect(result.status).not.toBe(0);
    for (const p of packages) {
      const message = result.stderr
        .split("\n")
        .find((line) => line.includes(`could not download ${p.file} from any source`));
      expect(message, result.stderr).toBeDefined();
      expect(message).toContain(`${sources.url("snapshot")}/${snapshot}/${p.pool}: curl: (22)`);
      expect(message).toContain("404");
      expect(message).toContain(`${sources.url("launchpad")}/${p.file}: curl: (28)`); // 28: the stall limit
      expect(message).toContain(`${sources.url("archive")}/${p.pool}: curl: (1)`); // 1: http:// is not allowed
    }
    expect(readdirSync(cache)).toEqual([]);
  });

  for (const wrong of ["wrong-size", "wrong-hash"] as const) {
    it(`stops without trying another source after a size or SHA-256 mismatch (${wrong})`, async () => {
      const result = await fetchWith({ snapshot: wrong, launchpad: "serve", archive: "serve" });
      expect(result.status).not.toBe(0);
      for (const p of packages)
        expect(result.stderr).toContain(`${p.file} from ${sources.url("snapshot")}/${snapshot}/${p.pool} has`);
      expect(result.stderr).toContain("no other source is tried");
      expect(result.stderr).toContain(wrong === "wrong-hash" ? "SHA-256" : "bytes");
      expect(new Set(sources.requests.map(([source]) => source))).toEqual(new Set(["snapshot"]));
      expect(readdirSync(cache)).toEqual([]);
    });
  }

  it("refuses a redirect to an http:// address", async () => {
    const result = await fetchWith({ snapshot: "redirect-http", launchpad: "serve", archive: "serve" });
    expect(result.status, result.stderr).toBe(0);
    expect(sources.httpRequests).toEqual([]);
    expectCacheHoldsEveryFile();
    expect(reportCounts()["launchpad"]).toBe(2);
  });

  it("checks a file that is already in the cache folder and uses it", async () => {
    mkdirSync(cache);
    writeFileSync(join(cache, first.file), first.content);
    const result = await fetchWith({ snapshot: "serve" });
    expect(result.status, result.stderr).toBe(0);
    expectCacheHoldsEveryFile();
    expect(sources.requests).toEqual([["snapshot", second.file]]);
    const counts = reportCounts();
    expect([counts["cache"], counts["snapshot"]]).toEqual([1, 1]);
  });

  it("stops with the recovery message when a file in the cache folder does not match the lock", async () => {
    mkdirSync(cache);
    const bad = Buffer.concat([Buffer.from("X"), first.content.subarray(1)]);
    writeFileSync(join(cache, first.file), bad);
    const result = await fetchWith({ snapshot: "serve", launchpad: "serve", archive: "serve" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `${first.file} in the cache has the SHA-256 ${sha256(bad)}, but the lock pins ${first.sha256}`,
    );
    expect(result.stderr).toContain("change the version in the cache key");
    expect(sources.requests.map(([, name]) => name)).not.toContain(first.file);
    expect(readFileSync(join(cache, first.file)).equals(bad)).toBe(true); // left as it was, for whoever investigates
  });

  it("accepts only https:// sources", async () => {
    const env = cleanEnvironment({ UBUNTU_PACKAGES_LAUNCHPAD_URL: `http://127.0.0.1:${sources.httpPort}` });
    const result = await run(["fetch", lock, cache], env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("every source address must start with https://");
    expect([sources.requests, sources.httpRequests]).toEqual([[], []]);
  });

  for (const directories of ["pool/main/../..", "pool/main/h/."]) {
    it(`refuses a pool path with a "." or ".." directory (${directories})`, async () => {
      const path = `${directories}/${first.file}`;
      writeFileSync(lock, lockText().replace(first.pool, path));
      const result = await fetchWith({ snapshot: "serve", launchpad: "serve", archive: "serve" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`a pool path with a "." or ".." directory: ${path}`);
      expect(sources.requests).toEqual([]);
    });
  }

  it("refuses a lock that was edited by hand", async () => {
    writeFileSync(lock, lockText().replace(`configure ${second.name} ${second.version}\n`, ""));
    const result = await fetchWith({ snapshot: "serve" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unpacked but never configured");
    expect(sources.requests).toEqual([]);
  });
});

// What plan_in_image prints in the image for `docker run`: the architecture, apt's simulated plan and the verified index's fields.
const aptOutput = `architecture amd64
Inst libhello1 [1:1.0-1] (1:1.0-1ubuntu0.1 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64]) [hello:amd64 ]
Conf libhello1 (1:1.0-1ubuntu0.1 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64]) []
Inst hello-data (2.10-3build2 Ubuntu:24.04/noble [all])
Conf hello-data (2.10-3build2 Ubuntu:24.04/noble [all])
index
Package: libhello1
Architecture: amd64
Version: 1:1.0-1ubuntu0.1
Filename: ${first.pool}
Size: ${first.content.length}
SHA256: ${first.sha256}
Package: hello-data
Architecture: all
Version: 2.10-3build2
Filename: ${second.pool}
Size: ${second.content.length}
SHA256: ${second.sha256}
`;

// A stand-in for the Docker client. It records each call on a line of its own, the arguments separated by tabs and without the script's
// text (the argument after -c), and answers `image inspect` with $FAKE_DOCKER_CREATED, `run` with the file $FAKE_DOCKER_APT_OUTPUT and
// `pull` with nothing.
const fakeDocker = `#!/bin/sh
line="" previous=""
for argument in "$@"; do
  [ "$previous" = -c ] || line="$line	$argument"
  previous=$argument
done
printf '%s\\n' "\${line#?}" >>"$FAKE_DOCKER_LOG"
case $1 in
  image) printf '%s linux amd64\\n' "$FAKE_DOCKER_CREATED" ;;
  run) cat "$FAKE_DOCKER_APT_OUTPUT" ;;
  pull) ;;
  *) exit 2 ;;
esac
`;

const expectedLockBody = `format 1
image ${image}
created 2026-10-26T23:50:00.169696607Z
architecture amd64
snapshot ${snapshot}
request g++
request hello
request libfoo-dev
unpack libhello1 1:1.0-1ubuntu0.1 amd64 ${first.pool} ${first.content.length} ${first.sha256}
configure libhello1 1:1.0-1ubuntu0.1
unpack hello-data 2.10-3build2 all ${second.pool} ${second.content.length} ${second.sha256}
configure hello-data 2.10-3build2
`;

describe.skipIf(!onLinux)("ubuntu-packages.sh lock", { timeout: 60_000 }, () => {
  let work: string;
  let docker: string;
  let log: string;
  let aptFile: string;
  let output: string;

  beforeEach(() => {
    work = folder("ubuntu-packages-lock-");
    docker = join(work, "docker");
    writeFileSync(docker, fakeDocker);
    chmodSync(docker, 0o755);
    log = join(work, "docker.log");
    aptFile = join(work, "apt-output");
    writeFileSync(aptFile, aptOutput);
    output = join(work, "ubuntu-packages.lock");
  });

  function lock(args: string[], options: { created?: string; apt?: string } = {}): Promise<Result> {
    if (options.apt !== undefined) writeFileSync(aptFile, options.apt);
    const env = cleanEnvironment({
      DOCKER: docker,
      FAKE_DOCKER_LOG: log,
      FAKE_DOCKER_CREATED: options.created ?? "2026-10-26T23:50:00.169696607Z",
      FAKE_DOCKER_APT_OUTPUT: aptFile,
    });
    return run(["lock", ...args], env);
  }

  /** The calls of `docker run`, each as its list of arguments. */
  function dockerRuns(): string[][] {
    if (!existsSync(log)) return [];
    const calls = readFileSync(log, "utf8").trimEnd().split("\n");
    return calls.map((call) => call.split("\t")).filter((call) => call[0] === "run");
  }

  function standard(
    { snapshot: date = snapshot, cutoff = "2026-11-11T15:00:00Z" }: { snapshot?: string; cutoff?: string } = {},
    ...requested: string[]
  ): string[] {
    const names = requested.length > 0 ? requested : ["libfoo-dev", "hello", "g++"];
    return ["--image", image, "--snapshot", date, "--cutoff", cutoff, "--output", output, ...names];
  }

  it("writes the lock from apt's plan and the verified index", async () => {
    const result = await lock(standard());
    expect(result.status, result.stderr).toBe(0);
    const text = readFileSync(output, "utf8");
    const body = text
      .split("\n")
      .filter((line) => !line.startsWith("#"))
      .join("\n");
    expect(body).toBe(expectedLockBody);
    const runs = dockerRuns();
    expect(runs).toHaveLength(1);
    const call = runs[0] ?? [];
    expect(call).toContain("--platform");
    expect(call.slice(call.indexOf("__plan"))).toEqual(["__plan", snapshot, "", "", "g++", "hello", "libfoo-dev"]);
  });

  it("writes the same file, byte for byte, from the same inputs", async () => {
    expect((await lock(standard())).status).toBe(0);
    const written = readFileSync(output);
    expect((await lock(standard({}, "hello", "g++", "libfoo-dev", "hello"))).status).toBe(0);
    expect(readFileSync(output).equals(written)).toBe(true);
    const again = join(work, "again.lock");
    let result = await lock(["--from", output, "--cutoff", "2026-11-11T15:00:00Z", "--output", again]);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(again).equals(written)).toBe(true);
    result = await lock(["--from", output, "--cutoff", "2026-11-11T15:00:00Z"]);
    expect(result.stdout.equals(written)).toBe(true);
  });

  it("refuses a snapshot date before the image was created", async () => {
    let result = await lock(standard({ snapshot: "20261026T000000Z" }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("is before the image was created");
    // The same second as the creation, which was a fraction of a second later.
    result = await lock(standard({ snapshot: "20261026T235000Z" }));
    expect(result.stderr).toContain("is before the image was created");
    expect(dockerRuns()).toEqual([]);
    expect(existsSync(output)).toBe(false);
    result = await lock(standard({ snapshot: "20261026T235001Z" }));
    expect(result.status, result.stderr).toBe(0);
  });

  for (const date of ["20261111T150000Z", "20261112T000000Z"]) {
    it(`refuses a snapshot date that is not before the cutoff (${date})`, async () => {
      const result = await lock(standard({ snapshot: date }));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`the snapshot ${date} is not before the cutoff 2026-11-11T15:00:00Z`);
      expect(dockerRuns()).toEqual([]);
    });
  }

  it("refuses a cutoff less than 24 hours ago", async () => {
    const cutoff = new Date(Date.now() - 23 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
    const result = await lock(standard({ cutoff }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("is less than 24 hours ago");
    expect(dockerRuns()).toEqual([]);
  });

  it("refuses a plan that would remove a package (a Remv line)", async () => {
    const result = await lock(standard(), { apt: aptOutput.replace("index\n", "Remv oldhello [1.0-1]\nindex\n") });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("it would remove oldhello");
    expect(existsSync(output)).toBe(false);
  });

  it("refuses a package that the verified index does not have", async () => {
    const result = await lock(standard(), { apt: aptOutput.replace("Version: 2.10-3build2", "Version: 2.10-3build3") });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("the verified index has no record of hello-data 2.10-3build2 (all)");
    expect(existsSync(output)).toBe(false);
  });

  const unpinned: Array<[string, string, string]> = [
    ["the image must be named with its digest", "--image", "docker.io/library/buildpack-deps:noble-scm"],
    ["not a snapshot ID", "--snapshot", "2026-11-11"],
    ["not a UTC time", "--cutoff", "yesterday"],
  ];
  for (const [message, option, value] of unpinned) {
    it(`refuses inputs that are not pinned or not dates (${option})`, async () => {
      const args = standard();
      args[args.indexOf(option) + 1] = value;
      const result = await lock(args);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(message);
      expect(dockerRuns()).toEqual([]);
    });
  }
});

// Stand-ins for install's tools, put first on PATH: dpkg records its arguments and answers --audit with $FAKE_DPKG_AUDIT; dpkg-query
// prints each queried package's line ("<package> <status> <version>") from $FAKE_DPKG_STATE; id says root.
const fakeDpkg = `#!/bin/sh
printf '%s\\n' "$*" >>"$FAKE_DPKG_LOG"
if [ "$*" = --audit ]; then printf '%s' "\${FAKE_DPKG_AUDIT:-}"; fi
`;

const fakeDpkgQuery = `#!/bin/sh
shift 3
status=0
for package in "$@"; do
  line=$(awk -v p="$package" '$1 == p { print; exit }' "$FAKE_DPKG_STATE")
  if [ -n "$line" ]; then printf '%s\\n' "$line"; else echo "dpkg-query: no packages found matching $package" >&2; status=1; fi
done
exit $status
`;

const fakeId = `#!/bin/sh
echo 0
`;

describe.skipIf(!onLinux)("ubuntu-packages.sh install", { timeout: 60_000 }, () => {
  let bin: string;
  let lock: string;
  let cache: string;
  let log: string;
  let state: string;

  beforeEach(() => {
    const work = folder("ubuntu-packages-install-");
    bin = join(work, "bin");
    mkdirSync(bin);
    for (const [name, text] of [
      ["dpkg", fakeDpkg],
      ["dpkg-query", fakeDpkgQuery],
      ["id", fakeId],
    ] as const) {
      writeFileSync(join(bin, name), text);
      chmodSync(join(bin, name), 0o755);
    }
    lock = join(work, "ubuntu-packages.lock");
    writeFileSync(lock, lockText());
    cache = join(work, "cache");
    mkdirSync(cache);
    for (const p of packages) writeFileSync(join(cache, p.file), p.content);
    log = join(work, "dpkg.log");
    state = join(work, "dpkg-state");
    writeFileSync(state, packages.map((p) => `${p.name} ii ${p.version}\n`).join(""));
  });

  function install(audit = ""): Promise<Result> {
    const env = cleanEnvironment({
      PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
      FAKE_DPKG_LOG: log,
      FAKE_DPKG_AUDIT: audit,
      FAKE_DPKG_STATE: state,
    });
    return run(["install", lock, cache], env);
  }

  it("replays the plan and succeeds when dpkg reports everything installed", async () => {
    const result = await install();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("installed the 2 packages");
    const options = "--no-triggers --force-confdef --force-confold";
    expect(readFileSync(log, "utf8").trimEnd().split("\n")).toEqual([
      `--unpack --auto-deconfigure ${options} ${first.file} ${second.file}`,
      `--configure ${options} ${first.name} ${second.name}`,
      "--configure --pending",
      "--audit",
    ]);
  });

  it("fails when dpkg --audit reports a problem", async () => {
    const audit = `The following packages are only half configured, probably due to problems
configuring them the first time.
 hello-data
`;
    const result = await install(audit);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "dpkg --audit reports unfinished packages: The following packages are only half configured",
    );
    expect(result.stderr).not.toContain("installed the");
  });

  const wrongStates: Array<[string, string, string]> = [
    ["another version", `${second.name} ii 2.10-3build1\n`, "ii 2.10-3build1"],
    ["unpacked, not configured", `${second.name} iU ${second.version}\n`, `iU ${second.version}`],
    ["not installed", "", "not installed"],
  ];
  for (const [name, secondState, shown] of wrongStates) {
    it(`fails when a locked package is not installed at its locked version (${name})`, async () => {
      writeFileSync(state, `${first.name} ii ${first.version}\n${secondState}`);
      const result = await install();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        `these packages are not installed at their locked versions: ${second.name} ${second.version}: ${shown};`,
      );
      expect(result.stderr).not.toContain("installed the");
    });
  }
});
