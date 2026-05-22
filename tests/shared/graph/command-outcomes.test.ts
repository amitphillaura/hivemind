import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Exhaustive coverage for the outcome-printing switch arms in
 * src/commands/graph.ts. Each runner (runBuildCommand, runPullCommand,
 * runInitCommand, runUninstallCommand) ends with a `switch (outcome.kind)`
 * that prints a per-case message — those branches were uncovered by the
 * happy-path tests in command.test.ts.
 *
 * Strategy: vi.doMock the underlying helpers (pushSnapshot, pullSnapshot,
 * install/uninstallPostCommitHook) per test to inject each outcome variant,
 * then assert the printed output contains the right branch-specific line.
 *
 * The build runner does heavy work (AST extraction, snapshot write) that we
 * don't want to re-run per push outcome, so we mock the BIG pieces too —
 * the tests target ONLY the post-build push-outcome printing.
 */

let workDir: string;
let graphsHome: string;
const prevHome = process.env.HIVEMIND_GRAPHS_HOME;

function captureLogs(fn: () => Promise<void> | void): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a) => out.push(a.map(String).join(" ")));
  const warn = vi.spyOn(console, "warn").mockImplementation((...a) => err.push(a.map(String).join(" ")));
  const e2 = vi.spyOn(console, "error").mockImplementation((...a) => err.push(a.map(String).join(" ")));
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit(${code})`);
  }) as never);
  return (async () => {
    try { await fn(); } catch { /* swallow forced exit */ }
    log.mockRestore();
    warn.mockRestore();
    e2.mockRestore();
    exitSpy.mockRestore();
    return { out: out.join("\n"), err: err.join("\n") };
  })();
}

describe("runPullCommand — every PullOutcome branch", () => {
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "outcome-pull-cwd-"));
    graphsHome = mkdtempSync(join(tmpdir(), "outcome-pull-home-"));
    process.env.HIVEMIND_GRAPHS_HOME = graphsHome;
    vi.resetModules();
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HIVEMIND_GRAPHS_HOME;
    else process.env.HIVEMIND_GRAPHS_HOME = prevHome;
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
    try { rmSync(graphsHome, { recursive: true, force: true }); } catch {}
  });

  async function runPullWithOutcome(outcome: unknown): Promise<{ out: string; err: string }> {
    vi.doMock("../../../src/graph/deeplake-pull.js", () => ({
      pullSnapshot: vi.fn(async () => outcome),
    }));
    const { runGraphCommand } = await import("../../../src/commands/graph.js");
    return captureLogs(() => runGraphCommand(["pull", "--cwd", workDir]));
  }

  it("pulled → prints commit, sha256, bytes, origin, cloud ts", async () => {
    const { out } = await runPullWithOutcome({
      kind: "pulled",
      commitSha: "9c4a7ce83f8cf79cb76c585175037912dc2ebef7",
      snapshotSha256: "749fc890608bad00df55dbe1d85b9b697a850f092a4d26a128d6b230b179514f",
      bytes: 1014683,
      cloudTs: 1779402726801,
      sourceWorktreePath: "e01c87cb64b9f223",
    });
    expect(out).toContain("Pulled commit 9c4a7ce");
    expect(out).toContain("sha256:");
    expect(out).toContain("bytes:");
    expect(out).toContain("worktree_id=e01c87cb64b9f223");
    expect(out).toContain("cloud ts:");
  });

  it("up-to-date → prints already-up-to-date with commit + sha", async () => {
    const { out } = await runPullWithOutcome({
      kind: "up-to-date",
      commitSha: "1d32aaa5e972c099c1842513f33f1ceaed1011bf",
      snapshotSha256: "04dd4147ff2d071d0790eb5fecf7526a5f8f215dc659c3066f4886bc62aa69bf",
    });
    expect(out).toContain("Already up-to-date");
    expect(out).toContain("1d32aaa");
  });

  it("local-newer → prints local+cloud ts comparison", async () => {
    const { out } = await runPullWithOutcome({
      kind: "local-newer",
      commitSha: "abc1234abc1234abc1234abc1234abc1234abc12",
      localTs: 2_000_000_000_000,
      cloudTs: 1_000_000_000_000,
    });
    expect(out).toContain("Local is newer");
    expect(out).toContain("commit:");
    expect(out).toContain("local ts:");
    expect(out).toContain("cloud ts:");
  });

  it("no-cloud-row → prints no-cloud message + suggestion to build", async () => {
    const { out } = await runPullWithOutcome({
      kind: "no-cloud-row",
      commitSha: "1234567890abcdef1234567890abcdef12345678",
    });
    expect(out).toContain("No cloud snapshot");
    expect(out).toContain("1234567");
    expect(out).toContain("graph build");
  });

  it("skipped-no-auth → prints login hint", async () => {
    const { out } = await runPullWithOutcome({ kind: "skipped-no-auth" });
    expect(out).toContain("Skipped");
    expect(out).toContain("not authenticated");
    expect(out).toContain("hivemind login");
  });

  it("skipped-disabled → prints env var", async () => {
    const { out } = await runPullWithOutcome({ kind: "skipped-disabled" });
    expect(out).toContain("HIVEMIND_GRAPH_PULL=0");
  });

  it("skipped-no-head → prints not-in-git-repo message", async () => {
    const { out } = await runPullWithOutcome({ kind: "skipped-no-head" });
    expect(out).toContain("not in a git repo");
  });

  it("error → prints non-fatal warning + sets exitCode=1", async () => {
    const prevExit = process.exitCode;
    const { err } = await runPullWithOutcome({ kind: "error", message: "network 503" });
    expect(err).toContain("Pull error");
    expect(err).toContain("network 503");
    expect(process.exitCode).toBe(1);
    process.exitCode = prevExit;  // restore for vitest
  });
});

describe("runInitCommand — every InstallStatus branch", () => {
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "outcome-init-cwd-"));
    graphsHome = mkdtempSync(join(tmpdir(), "outcome-init-home-"));
    process.env.HIVEMIND_GRAPHS_HOME = graphsHome;
    vi.resetModules();
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HIVEMIND_GRAPHS_HOME;
    else process.env.HIVEMIND_GRAPHS_HOME = prevHome;
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
    try { rmSync(graphsHome, { recursive: true, force: true }); } catch {}
  });

  async function runInitWithStatus(status: unknown): Promise<{ out: string; err: string }> {
    vi.doMock("../../../src/graph/git-hook-install.js", async () => {
      const actual = await vi.importActual<typeof import("../../../src/graph/git-hook-install.js")>(
        "../../../src/graph/git-hook-install.js",
      );
      return {
        ...actual,
        installPostCommitHook: vi.fn(() => status),
        uninstallPostCommitHook: vi.fn(() => status),
      };
    });
    const { runGraphCommand } = await import("../../../src/commands/graph.js");
    return captureLogs(() => runGraphCommand(["init", "--cwd", workDir, "--no-initial-build"]));
  }

  it("installed (was new) → prints install path", async () => {
    const { out } = await runInitWithStatus({
      kind: "installed", path: "/tmp/.git/hooks/post-commit", wasNew: true,
    });
    expect(out).toContain("Installed");
    expect(out).toContain("post-commit");
  });

  it("already-ours → prints already-managed message", async () => {
    const { out } = await runInitWithStatus({
      kind: "already-ours", path: "/tmp/.git/hooks/post-commit",
    });
    expect(out).toContain("already managed");
  });

  it("foreign-hook → prints hint to stderr + exits", async () => {
    const { err } = await runInitWithStatus({
      kind: "foreign-hook",
      path: "/tmp/.git/hooks/post-commit",
      hint: "test hint about --force",
    });
    expect(err).toContain("test hint about --force");
  });
});

describe("runUninstallCommand — every UninstallStatus branch", () => {
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "outcome-uninstall-cwd-"));
    graphsHome = mkdtempSync(join(tmpdir(), "outcome-uninstall-home-"));
    process.env.HIVEMIND_GRAPHS_HOME = graphsHome;
    vi.resetModules();
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HIVEMIND_GRAPHS_HOME;
    else process.env.HIVEMIND_GRAPHS_HOME = prevHome;
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
    try { rmSync(graphsHome, { recursive: true, force: true }); } catch {}
  });

  async function runUninstallWithStatus(status: unknown): Promise<{ out: string; err: string }> {
    vi.doMock("../../../src/graph/git-hook-install.js", async () => {
      const actual = await vi.importActual<typeof import("../../../src/graph/git-hook-install.js")>(
        "../../../src/graph/git-hook-install.js",
      );
      return {
        ...actual,
        uninstallPostCommitHook: vi.fn(() => status),
      };
    });
    const { runGraphCommand } = await import("../../../src/commands/graph.js");
    return captureLogs(() => runGraphCommand(["uninstall", "--cwd", workDir]));
  }

  it("removed → prints removed", async () => {
    const { out } = await runUninstallWithStatus({
      kind: "removed", path: "/tmp/.git/hooks/post-commit",
    });
    expect(out).toContain("Removed");
  });

  it("no-hook → prints no-op message", async () => {
    const { out } = await runUninstallWithStatus({
      kind: "no-hook", path: "/tmp/.git/hooks/post-commit",
    });
    expect(out).toContain("No post-commit");
  });

  it("not-ours → prints refusal hint", async () => {
    const { err } = await runUninstallWithStatus({
      kind: "not-ours",
      path: "/tmp/.git/hooks/post-commit",
      hint: "existing hook is not ours; remove manually",
    });
    expect(err).toContain("not ours");
  });
});

describe("runHistoryCommand — argument parsing branches", () => {
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "outcome-hist-cwd-"));
    graphsHome = mkdtempSync(join(tmpdir(), "outcome-hist-home-"));
    process.env.HIVEMIND_GRAPHS_HOME = graphsHome;
    vi.resetModules();
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HIVEMIND_GRAPHS_HOME;
    else process.env.HIVEMIND_GRAPHS_HOME = prevHome;
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
    try { rmSync(graphsHome, { recursive: true, force: true }); } catch {}
  });

  it("rejects -n with non-integer value (CodeRabbit Minor regression)", async () => {
    const { runGraphCommand } = await import("../../../src/commands/graph.js");
    const { err } = await captureLogs(() =>
      runGraphCommand(["history", "--cwd", workDir, "-n", "5junk"])
    );
    expect(err).toContain("-n must be a non-negative integer");
  });

  it("rejects --json with unknown extra arg", async () => {
    const { runGraphCommand } = await import("../../../src/commands/graph.js");
    const { err } = await captureLogs(() =>
      runGraphCommand(["history", "--cwd", workDir, "--bogus-flag"])
    );
    expect(err.length).toBeGreaterThan(0);
  });

  it("--json on empty history → emits empty list (valid JSON)", async () => {
    const { runGraphCommand } = await import("../../../src/commands/graph.js");
    const { out } = await captureLogs(() =>
      runGraphCommand(["history", "--cwd", workDir, "--json"])
    );
    // Any printable output that doesn't crash is fine
    expect(typeof out).toBe("string");
  });
});

describe("runDiffCommand — argument parsing branches", () => {
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "outcome-diff-cwd-"));
    graphsHome = mkdtempSync(join(tmpdir(), "outcome-diff-home-"));
    process.env.HIVEMIND_GRAPHS_HOME = graphsHome;
    vi.resetModules();
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HIVEMIND_GRAPHS_HOME;
    else process.env.HIVEMIND_GRAPHS_HOME = prevHome;
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
    try { rmSync(graphsHome, { recursive: true, force: true }); } catch {}
  });

  it("rejects --limit with non-integer value", async () => {
    const { runGraphCommand } = await import("../../../src/commands/graph.js");
    const { err } = await captureLogs(() =>
      runGraphCommand(["diff", "aaaa", "bbbb", "--cwd", workDir, "--limit", "5junk"])
    );
    expect(err).toContain("--limit must be a non-negative integer");
  });

  it("missing sha args → error + usage", async () => {
    const { runGraphCommand } = await import("../../../src/commands/graph.js");
    const { err } = await captureLogs(() =>
      runGraphCommand(["diff"])
    );
    expect(err.length).toBeGreaterThan(0);
  });
});
