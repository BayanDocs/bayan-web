// scripts/check-engine-pin.sh, which scripts/engine-package.sh runs before it builds the engine: the pinned bayan-core commit must be
// one of main's own commits, merged at least 24 hours before now and before the bayan-web commit that pinned it (ADR-0017 rule 4), and
// the bayan-web clone must have its history. These tests build small Git repositories with chosen commit times, so they need no network.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "../../scripts/check-engine-pin.sh");
const hour = 3600;
const now = Math.floor(Date.now() / 1000);
const folders: string[] = [];

/** Git without the machine's own configuration, so that no setting of the developer's changes what the tests build. */
const gitEnv = {
  PATH: process.env["PATH"] ?? "",
  HOME: tmpdir(),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: devNull,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@bayandocs.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@bayandocs.invalid",
};

interface Times {
  author: number;
  committer: number;
}

/** Times `hours` before now, authored and committed at once. */
const at = (hours: number): Times => ({ author: now - hours * hour, committer: now - hours * hour });

function git(dir: string, args: string[], times?: Times): string {
  const env = times
    ? { ...gitEnv, GIT_AUTHOR_DATE: `${times.author} +0000`, GIT_COMMITTER_DATE: `${times.committer} +0000` }
    : gitEnv;
  return execFileSync("git", ["-C", dir, ...args], { env, encoding: "utf8" }).trim();
}

function repository(): string {
  const dir = mkdtempSync(join(tmpdir(), "engine-pin-"));
  folders.push(dir);
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  return dir;
}

function commit(dir: string, file: string, text: string, times: Times): string {
  writeFileSync(join(dir, file), text);
  git(dir, ["add", file]);
  git(dir, ["commit", "--quiet", "-m", `change ${file}`], times);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** bayan-core with a commit that reached main `hoursAgo` hours ago, written by GitHub at the merge, after its author wrote it. */
function core(hoursAgo: number): { dir: string; merged: string } {
  const dir = repository();
  commit(dir, "README.md", "bayan-core\n", at(400));
  const merged = commit(dir, "engine.rs", "fn main() {}\n", {
    author: now - (hoursAgo + 5) * hour,
    committer: now - hoursAgo * hour,
  });
  return { dir, merged };
}

/**
 * bayan-web, pinning `pinnedCommit` in a commit at `pinned`, or in a change not committed yet; with `reworded`, a later commit at that
 * time changes only the file's comment.
 */
function web(pinnedCommit: string, pinned: Times | "uncommitted", reworded?: Times): string {
  const dir = repository();
  commit(dir, "README.md", "bayan-web\n", at(500));
  const line = `commit=${pinnedCommit}\n`;
  if (pinned === "uncommitted") {
    commit(dir, "bayan-core.pin", `commit=${"0".repeat(40)}\n`, at(450));
    writeFileSync(join(dir, "bayan-core.pin"), line);
  } else {
    commit(dir, "bayan-core.pin", `# The pinned commit.\n${line}`, pinned);
    if (reworded) commit(dir, "bayan-core.pin", `# The bayan-core commit that bayan-web builds.\n${line}`, reworded);
  }
  return dir;
}

function check(coreDir: string, pinned: string, webDir: string): { ok: boolean; output: string } {
  const result = spawnSync("bash", [script, coreDir, "refs/heads/main", pinned, webDir], {
    env: gitEnv,
    encoding: "utf8",
  });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("check-engine-pin.sh", () => {
  it("accepts a commit of main merged more than 24 hours before it was pinned", () => {
    const { dir, merged } = core(100);
    const result = check(dir, merged, web(merged, at(48)));
    expect(result.output).toContain("merged at least 24 hours before it was pinned");
    expect(result.ok).toBe(true);
  });

  it("refuses a shallow clone of bayan-web, which lacks the commit that pinned the engine", () => {
    const { dir, merged } = core(100);
    const full = web(merged, at(48));
    const shallow = mkdtempSync(join(tmpdir(), "engine-pin-shallow-"));
    folders.push(shallow);
    execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${full}`, shallow], { env: gitEnv });
    const result = check(dir, merged, shallow);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("shallow");
  });

  it("refuses a commit that reached main less than 24 hours ago", () => {
    const { dir, merged } = core(10);
    const result = check(dir, merged, web(merged, "uncommitted"));
    expect(result.ok).toBe(false);
    expect(result.output).toContain("less than 24 hours ago");
  });

  it("refuses a commit pinned less than 24 hours after it reached main, however long ago that was", () => {
    const { dir, merged } = core(40);
    const result = check(dir, merged, web(merged, at(30)));
    expect(result.ok).toBe(false);
    expect(result.output).toContain("pinned less than 24 hours after");
  });

  it("takes the pin time from the commit that added the pinned line, not from a later change to the file's comments", () => {
    const { dir, merged } = core(40);
    // Pinned 10 hours after the merge; an hour ago a commit only reworded the comment above the line.
    const result = check(dir, merged, web(merged, at(30), at(1)));
    expect(result.ok).toBe(false);
    expect(result.output).toContain("pinned less than 24 hours after");
  });

  it("takes the earlier of the pin commit's author and committer times, which amending or rebasing cannot move", () => {
    const { dir, merged } = core(100);
    // Written 5 hours after the merge, amended 98 hours later: the pin was still made too early.
    const result = check(dir, merged, web(merged, { author: now - 95 * hour, committer: now - 2 * hour }));
    expect(result.ok).toBe(false);
    expect(result.output).toContain("pinned less than 24 hours after");
  });

  it("refuses a commit that reached main through a merge rather than as one of main's own commits", () => {
    const dir = repository();
    commit(dir, "README.md", "bayan-core\n", at(400));
    git(dir, ["checkout", "--quiet", "-b", "side"]);
    const side = commit(dir, "side.rs", "fn side() {}\n", at(300));
    git(dir, ["checkout", "--quiet", "main"]);
    commit(dir, "main.rs", "fn main() {}\n", at(250));
    git(dir, ["merge", "--quiet", "--no-ff", "--no-edit", "side"], at(200));
    const result = check(dir, side, web(side, at(48)));
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not one of the commits of bayan-core's main branch");
  });
});
