import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  lastBuildPath,
  readLastBuild,
  writeLastBuild,
} from "../../../src/graph/last-build.js";
import { decideGate, type GateContext } from "../../../src/hooks/graph-on-stop.js";

describe("last-build state I/O", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "last-build-"));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("readLastBuild returns null on missing file", () => {
    expect(readLastBuild(baseDir)).toBeNull();
  });

  it("write/read roundtrip", () => {
    const state = { ts: 1234567890, commit_sha: "abc", snapshot_sha256: "def" };
    writeLastBuild(baseDir, state);
    expect(readLastBuild(baseDir)).toEqual(state);
  });

  it("preserves null commit_sha (non-git context)", () => {
    writeLastBuild(baseDir, { ts: 1, commit_sha: null, snapshot_sha256: "x" });
    expect(readLastBuild(baseDir)?.commit_sha).toBeNull();
  });

  it("returns null on corrupt JSON", () => {
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(lastBuildPath(baseDir), "{ corrupt");
    expect(readLastBuild(baseDir)).toBeNull();
  });

  it("returns null on shape mismatch (missing fields, wrong types)", () => {
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(lastBuildPath(baseDir), JSON.stringify({ ts: "string-not-number" }));
    expect(readLastBuild(baseDir)).toBeNull();
    writeFileSync(lastBuildPath(baseDir), JSON.stringify({ ts: 1, commit_sha: 123, snapshot_sha256: "x" }));
    expect(readLastBuild(baseDir)).toBeNull();
  });
});

describe("decideGate — Stop hook auto-build gates", () => {
  let workDir: string;
  let graphsHome: string;
  const prevHome = process.env.HIVEMIND_GRAPHS_HOME;
  const prevDisable = process.env.HIVEMIND_GRAPH_ON_STOP;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "stop-gate-work-"));
    graphsHome = mkdtempSync(join(tmpdir(), "stop-gate-home-"));
    process.env.HIVEMIND_GRAPHS_HOME = graphsHome;
    delete process.env.HIVEMIND_GRAPH_ON_STOP;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HIVEMIND_GRAPHS_HOME;
    else process.env.HIVEMIND_GRAPHS_HOME = prevHome;
    if (prevDisable === undefined) delete process.env.HIVEMIND_GRAPH_ON_STOP;
    else process.env.HIVEMIND_GRAPH_ON_STOP = prevDisable;
    rmSync(workDir, { recursive: true, force: true });
    rmSync(graphsHome, { recursive: true, force: true });
  });

  function ctx(over: Partial<GateContext> = {}): GateContext {
    return {
      cwd: workDir,
      now: Date.now(),
      intervalMs: 10 * 60 * 1000,
      envDisable: false,
      ...over,
    };
  }

  function initGitRepo(): string {
    execSync("git init -q -b main", { cwd: workDir });
    execSync('git config user.email "test@example.com"', { cwd: workDir });
    execSync('git config user.name "Test"', { cwd: workDir });
    execSync("git remote add origin https://example.com/test-stop.git", { cwd: workDir });
    writeFileSync(join(workDir, "a.ts"), "export const x = 1;");
    execSync("git add .", { cwd: workDir });
    execSync('git commit -q -m "init"', { cwd: workDir });
    return execSync("git rev-parse HEAD", { cwd: workDir, encoding: "utf8" }).trim();
  }

  // Read repoDir the way the production code does so tests use the same path
  // resolution. Imported lazily to avoid coupling test setup to the module.
  async function repoBaseDir(): Promise<string> {
    const { repoDir } = await import("../../../src/graph/snapshot.js");
    const { deriveProjectKey } = await import("../../../src/utils/repo-identity.js");
    return repoDir(deriveProjectKey(workDir).key);
  }

  it("envDisable short-circuits without I/O", () => {
    const d = decideGate(ctx({ envDisable: true }));
    expect(d.fire).toBe(false);
    expect(d.reason).toMatch(/disabled/);
  });

  it("first build (no prior state) → fire", () => {
    initGitRepo();
    const d = decideGate(ctx());
    expect(d.fire).toBe(true);
    expect(d.reason).toMatch(/first build/);
  });

  it("rate limit: recent last-build → skip", async () => {
    const head = initGitRepo();
    const baseDir = await repoBaseDir();
    writeLastBuild(baseDir, { ts: Date.now(), commit_sha: head, snapshot_sha256: "x" });
    const d = decideGate(ctx());
    expect(d.fire).toBe(false);
    expect(d.reason).toMatch(/rate limit/);
  });

  it("HEAD unchanged since last build → skip", async () => {
    const head = initGitRepo();
    const baseDir = await repoBaseDir();
    writeLastBuild(baseDir, { ts: 0, commit_sha: head, snapshot_sha256: "x" });
    const d = decideGate(ctx({ now: Date.now() }));
    expect(d.fire).toBe(false);
    expect(d.reason).toMatch(/HEAD unchanged/);
  });

  it("no git repo → skip with 'not in a git repo'", async () => {
    // workDir is NOT a git repo here (didn't call initGitRepo)
    const baseDir = await repoBaseDir();
    writeLastBuild(baseDir, { ts: 0, commit_sha: "fakeoldsha", snapshot_sha256: "x" });
    const d = decideGate(ctx());
    expect(d.fire).toBe(false);
    expect(d.reason).toMatch(/not in a git repo/);
  });

  it("new commit with source-file change → fire", async () => {
    const head1 = initGitRepo();
    const baseDir = await repoBaseDir();
    writeLastBuild(baseDir, { ts: 0, commit_sha: head1, snapshot_sha256: "x" });
    // make a TS commit
    writeFileSync(join(workDir, "b.ts"), "export const y = 2;");
    execSync("git add .", { cwd: workDir });
    execSync('git commit -q -m "add b"', { cwd: workDir });
    const d = decideGate(ctx({ now: Date.now() }));
    expect(d.fire).toBe(true);
    expect(d.reason).toMatch(/1 source file/);
  });

  it("new commit but only README → skip (threshold gate)", async () => {
    const head1 = initGitRepo();
    const baseDir = await repoBaseDir();
    writeLastBuild(baseDir, { ts: 0, commit_sha: head1, snapshot_sha256: "x" });
    writeFileSync(join(workDir, "README.md"), "# only docs");
    execSync("git add .", { cwd: workDir });
    execSync('git commit -q -m "docs"', { cwd: workDir });
    const d = decideGate(ctx({ now: Date.now() }));
    expect(d.fire).toBe(false);
    expect(d.reason).toMatch(/no source files changed/);
  });

  it("intervalMs of 0 disables rate limit (test override)", async () => {
    const head1 = initGitRepo();
    const baseDir = await repoBaseDir();
    writeLastBuild(baseDir, { ts: Date.now(), commit_sha: head1, snapshot_sha256: "x" });
    // rate limit was triggered above; with intervalMs=0 we bypass and
    // fall through to commit/source checks (which find no change → skip
    // with HEAD unchanged, not rate limit)
    const d = decideGate(ctx({ intervalMs: 0 }));
    expect(d.fire).toBe(false);
    expect(d.reason).toMatch(/HEAD unchanged/);
  });
});
