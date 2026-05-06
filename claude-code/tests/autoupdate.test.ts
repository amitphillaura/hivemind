import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoUpdate,
  extractUpdateSummary,
  type SpawnResult,
} from "../../src/hooks/shared/autoupdate.js";

/**
 * Tests for src/hooks/shared/autoupdate.ts — the centralized autoupdate
 * helper that every agent's session-start hook calls.
 *
 * Replaced an older `autoupdate.test.ts` that tested an inline copy of
 * the legacy buildUpdateNotice / isNewer logic. That logic is now removed
 * from session-start.ts (it lived in the per-agent legacy paths we just
 * deleted), so the inline-copy tests were testing dead code. The real
 * version compare now lives in `src/cli/update.ts:isNewer` and the
 * notice generation has moved to `extractUpdateSummary` here.
 *
 * The helper has three gates and one "do the thing" path. Tests assert
 * COUNT and SHAPE of the spawn injection (CLAUDE.md rule 6) so a
 * regression that fires the spawn under the wrong gate, or fires twice,
 * cannot slip past.
 *
 * Mocks at the boundary (rule 5): we inject the `spawn` function and the
 * resolved `hivemindBinaryPath`, NOT the path-walk and NOT the underlying
 * `which`. The spawn injection captures the exact command + args; the
 * binary path injection lets us avoid actually shelling out to `which`.
 */

const VALID_CREDS = {
  token: "tok",
  orgId: "org",
  savedAt: "2026-05-05T00:00:00Z",
};

let stderrMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  stderrMock = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("autoUpdate — gating", () => {
  it("no-op when creds are null (not logged in)", async () => {
    const spawnFn = vi.fn();
    await autoUpdate(null, { agent: "claude", spawn: spawnFn, hivemindBinaryPath: "/u/bin/hivemind", stderr: stderrMock, skipLock: true });
    expect(spawnFn).not.toHaveBeenCalled();
    expect(stderrMock).not.toHaveBeenCalled();
  });

  it("no-op when creds.token is missing", async () => {
    const spawnFn = vi.fn();
    await autoUpdate({ ...VALID_CREDS, token: "" }, { agent: "claude", spawn: spawnFn, hivemindBinaryPath: "/u/bin/hivemind", stderr: stderrMock, skipLock: true });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("no-op when creds.autoupdate === false (user opted out)", async () => {
    const spawnFn = vi.fn();
    await autoUpdate(
      { ...VALID_CREDS, autoupdate: false },
      { agent: "claude", spawn: spawnFn, hivemindBinaryPath: "/u/bin/hivemind", stderr: stderrMock, skipLock: true },
    );
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("DOES run when creds.autoupdate is undefined (default true)", async () => {
    const spawnFn = vi.fn().mockResolvedValue({ stdout: "is up to date", stderr: "", code: 0 });
    await autoUpdate(VALID_CREDS, {
      agent: "claude", spawn: spawnFn, hivemindBinaryPath: "/u/bin/hivemind", stderr: stderrMock, skipLock: true,
    });
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it("no-op when hivemindBinaryPath is null (binary not on PATH)", async () => {
    const spawnFn = vi.fn();
    await autoUpdate(VALID_CREDS, {
      agent: "claude", spawn: spawnFn, hivemindBinaryPath: null, stderr: stderrMock, skipLock: true,
    });
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

describe("autoUpdate — spawn invocation", () => {
  it("spawns the resolved binary with args ['update'] (exactly once)", async () => {
    const spawnFn = vi.fn().mockResolvedValue({ stdout: "is up to date", stderr: "", code: 0 });
    await autoUpdate(VALID_CREDS, {
      agent: "claude", spawn: spawnFn, hivemindBinaryPath: "/usr/local/bin/hivemind", stderr: stderrMock, skipLock: true,
    });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn.mock.calls[0][0]).toBe("/usr/local/bin/hivemind");
    expect(spawnFn.mock.calls[0][1]).toEqual(["update"]);
    expect(typeof spawnFn.mock.calls[0][2]).toBe("number");
  });

  it("default timeoutMs is 90000ms (slow links + npm install -g + re-exec install)", async () => {
    const spawnFn = vi.fn().mockResolvedValue({ stdout: "is up to date", stderr: "", code: 0 });
    await autoUpdate(VALID_CREDS, {
      agent: "claude", spawn: spawnFn, hivemindBinaryPath: "/u/bin/hivemind", stderr: stderrMock, skipLock: true,
    });
    expect(spawnFn.mock.calls[0][2]).toBe(90_000);
  });

  it("custom timeoutMs propagates through", async () => {
    const spawnFn = vi.fn().mockResolvedValue({ stdout: "is up to date", stderr: "", code: 0 });
    await autoUpdate(VALID_CREDS, {
      agent: "claude", spawn: spawnFn, hivemindBinaryPath: "/u/bin/hivemind", stderr: stderrMock, skipLock: true,
      timeoutMs: 30_000,
    });
    expect(spawnFn.mock.calls[0][2]).toBe(30_000);
  });
});

describe("autoUpdate — output handling", () => {
  it("'Updated to X.Y.Z.' result prints upgrade notice with agent-specific restart hint", async () => {
    const spawnFn = vi.fn().mockResolvedValue({
      stdout: "Update available: 0.6.99 → 0.7.4\nUpgrading via npm…\nUpdated to 0.7.4.\n",
      stderr: "",
      code: 0,
    });
    await autoUpdate(VALID_CREDS, {
      agent: "claude", spawn: spawnFn, hivemindBinaryPath: "/u/bin/hivemind", stderr: stderrMock, skipLock: true,
    });
    const written = stderrMock.mock.calls.map(c => c[0]).join("");
    expect(written).toContain("✅ Hivemind Updated to 0.7.4.");
    expect(written).toContain("Run /reload-plugins to apply.");
  });

  it.each([
    ["claude",   "Run /reload-plugins to apply."],
    ["codex",    "Restart Codex to apply."],
    ["cursor",   "Restart Cursor to apply."],
    ["hermes",   "Restart Hermes to apply."],
    ["pi",       "Restart pi to apply."],
    ["openclaw", "Restart OpenClaw to apply."],
  ] as const)("%s gets the right restart hint after a successful upgrade", async (agent, hint) => {
    const spawnFn = vi.fn().mockResolvedValue({ stdout: "Updated to 1.2.3.\n", stderr: "", code: 0 });
    await autoUpdate(VALID_CREDS, {
      agent, spawn: spawnFn, hivemindBinaryPath: "/u/bin/hivemind", stderr: stderrMock, skipLock: true,
    });
    expect(stderrMock.mock.calls.map(c => c[0]).join("")).toContain(hint);
  });

  it("'is up to date' is silent (common case, no stderr noise on every session-start)", async () => {
    const spawnFn = vi.fn().mockResolvedValue({
      stdout: "hivemind 0.7.4 is up to date (npm latest: 0.7.4).\n",
      stderr: "",
      code: 0,
    });
    await autoUpdate(VALID_CREDS, {
      agent: "claude", spawn: spawnFn, hivemindBinaryPath: "/u/bin/hivemind", stderr: stderrMock, skipLock: true,
    });
    expect(stderrMock).not.toHaveBeenCalled();
  });

  it("'Update available: …' (e.g. local-dev refusal) surfaces as ⬆️ notice", async () => {
    const spawnFn = vi.fn().mockResolvedValue({
      stdout: "Update available: 0.6.99 → 0.7.4\n",
      stderr: "hivemind is running from a local development checkout (/repo)\n",
      code: 1,
    });
    await autoUpdate(VALID_CREDS, {
      agent: "codex", spawn: spawnFn, hivemindBinaryPath: "/u/bin/hivemind", stderr: stderrMock, skipLock: true,
    });
    const written = stderrMock.mock.calls.map(c => c[0]).join("");
    expect(written).toContain("⬆️ Hivemind:");
    expect(written).toContain("Update available: 0.6.99 → 0.7.4");
  });

  it("non-zero exit + no recognized phrase = silent (e.g. 'Unknown command: update' from older binary)", async () => {
    const spawnFn = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "Unknown command: update\nhivemind --help\n",
      code: 1,
    });
    await autoUpdate(VALID_CREDS, {
      agent: "claude", spawn: spawnFn, hivemindBinaryPath: "/u/bin/hivemind", stderr: stderrMock, skipLock: true,
    });
    expect(stderrMock).not.toHaveBeenCalled();
  });

  it("spawn rejecting (network / process error) is swallowed silently", async () => {
    const spawnFn = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(autoUpdate(VALID_CREDS, {
      agent: "claude", spawn: spawnFn, hivemindBinaryPath: "/u/bin/hivemind", stderr: stderrMock, skipLock: true,
    })).resolves.toBeUndefined();
    expect(stderrMock).not.toHaveBeenCalled();
  });
});

describe("autoUpdate — negative pattern: legacy paths must NOT fire", () => {
  // After centralization, autoUpdate should NEVER produce output that
  // mentions the legacy commands. Catches a regression where someone
  // re-introduces the marketplace / git-clone / ClawHub advice text.
  it("never references 'claude plugin update' or 'git clone' or 'openclaw plugins update' or 'clawhub' in stderr output", async () => {
    const spawnFn = vi.fn().mockResolvedValue({ stdout: "Updated to 1.2.3.\n", stderr: "", code: 0 });
    await autoUpdate(VALID_CREDS, {
      agent: "claude", spawn: spawnFn, hivemindBinaryPath: "/u/bin/hivemind", stderr: stderrMock, skipLock: true,
    });
    const written = stderrMock.mock.calls.map(c => c[0]).join("");
    expect(written).not.toContain("claude plugin update");
    expect(written).not.toContain("git clone");
    expect(written).not.toContain("openclaw plugins update");
    expect(written).not.toContain("clawhub.ai");
  });
});

describe("extractUpdateSummary", () => {
  it("returns the 'Updated to' line on a successful upgrade", () => {
    const out = "Update available: 0.6.99 → 0.7.4\nUpgrading via npm…\nchanged 333 packages\n  Codex installed -> /home/u/.codex/hivemind\nUpdated to 0.7.4.\n";
    expect(extractUpdateSummary(out)).toBe("Updated to 0.7.4.");
  });

  it("returns 'Update available: …' line when no 'Updated to' line is present", () => {
    const out = "Update available: 0.6.99 → 0.7.4\nhivemind is running from a local development checkout\n";
    expect(extractUpdateSummary(out)).toBe("Update available: 0.6.99 → 0.7.4");
  });

  it("returns the 'is up to date' line when nothing newer", () => {
    const out = "hivemind 0.7.4 is up to date (npm latest: 0.7.4).";
    expect(extractUpdateSummary(out)).toBe("hivemind 0.7.4 is up to date (npm latest: 0.7.4).");
  });

  it("returns null when no recognized phrase is present", () => {
    expect(extractUpdateSummary("Unknown command: update")).toBeNull();
    expect(extractUpdateSummary("")).toBeNull();
  });

  it("prefers 'Updated to' over 'Update available' if both appear (specificity)", () => {
    const out = "Update available: 0.6.99 → 0.7.4\nUpgrading…\nUpdated to 0.7.4.";
    expect(extractUpdateSummary(out)).toBe("Updated to 0.7.4.");
  });

  it("handles CRLF line endings", () => {
    const out = "Updated to 0.7.4.\r\n";
    expect(extractUpdateSummary(out)).toBe("Updated to 0.7.4.");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Default-path coverage: the test file above injects `spawn`, `stderr`,
// and `hivemindBinaryPath` to keep tests fast/deterministic. Those
// injections leave the helper's *default* paths uncovered, which the
// per-file 90% branch threshold rejects. The cases below exercise the
// defaults end-to-end with controlled real inputs.
// ─────────────────────────────────────────────────────────────────────────

describe("autoUpdate — default findHivemindOnPath()", () => {
  it("no-op when `which hivemind` returns nothing (real PATH lookup, hivemind absent)", async () => {
    const origPath = process.env.PATH;
    process.env.PATH = "/nonexistent-hivemind-test-path";
    try {
      const spawnFn = vi.fn();
      // hivemindBinaryPath NOT passed → triggers the real findHivemindOnPath()
      await autoUpdate(VALID_CREDS, {
        agent: "claude", spawn: spawnFn, stderr: stderrMock, skipLock: true,
      });
      // No binary on the empty PATH → spawn shouldn't have fired
      expect(spawnFn).not.toHaveBeenCalled();
      expect(stderrMock).not.toHaveBeenCalled();
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("finds binary when on PATH, then runs the full spawn pipeline (real `which`, real default spawn)", async () => {
    // Build a PATH that contains a fake `hivemind` binary that prints
    // exactly what `hivemind update` would print on a successful upgrade.
    const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "fake-hivemind-"));
    const fakeBin = join(dir, "hivemind");
    writeFileSync(fakeBin, "#!/usr/bin/env bash\necho 'Updated to 9.9.9.'\n");
    chmodSync(fakeBin, 0o755);
    const origPath = process.env.PATH;
    process.env.PATH = `${dir}:${origPath ?? ""}`;
    try {
      // No spawn override + no hivemindBinaryPath override → exercises
      // both findHivemindOnPath() and defaultSpawn() end-to-end.
      await autoUpdate(VALID_CREDS, { agent: "claude", stderr: stderrMock, skipLock: true });
      const written = stderrMock.mock.calls.map(c => c[0]).join("");
      expect(written).toContain("✅ Hivemind Updated to 9.9.9.");
      expect(written).toContain("Run /reload-plugins to apply.");
    } finally {
      process.env.PATH = origPath;
      const { rmSync } = await import("node:fs");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("default spawn captures non-zero exit + 'Update available' output (real subprocess)", async () => {
    const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "fake-hivemind-"));
    const fakeBin = join(dir, "hivemind");
    writeFileSync(
      fakeBin,
      "#!/usr/bin/env bash\necho 'Update available: 0.6.99 → 0.7.4' >&2\nexit 1\n",
    );
    chmodSync(fakeBin, 0o755);
    try {
      await autoUpdate(VALID_CREDS, {
        agent: "codex", hivemindBinaryPath: fakeBin, stderr: stderrMock, skipLock: true,
      });
      const written = stderrMock.mock.calls.map(c => c[0]).join("");
      expect(written).toContain("⬆️ Hivemind:");
      expect(written).toContain("Update available: 0.6.99");
    } finally {
      const { rmSync } = await import("node:fs");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("default spawn handles binary that fails to launch (ENOENT / non-existent path)", async () => {
    // Pointing hivemindBinaryPath at a path that doesn't exist exercises
    // the spawn 'error' event handler in defaultSpawn — the helper
    // should swallow it and produce no stderr output.
    await autoUpdate(VALID_CREDS, {
      agent: "claude",
      hivemindBinaryPath: "/nonexistent-binary-that-cannot-exec-xyz",
      stderr: stderrMock, skipLock: true,
    });
    expect(stderrMock).not.toHaveBeenCalled();
  });
});

describe("autoUpdate — default stderr writer", () => {
  it("writes to process.stderr when no stderr override is provided", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const spawnFn = vi.fn().mockResolvedValue({ stdout: "Updated to 1.2.3.", stderr: "", code: 0 });
    // No `stderr` opt → exercises the defaultStderr fallback
    await autoUpdate(VALID_CREDS, {
      agent: "hermes", spawn: spawnFn, hivemindBinaryPath: "/u/bin/hivemind",
      skipLock: true,
    });
    expect(stderrSpy).toHaveBeenCalled();
    const written = stderrSpy.mock.calls.map(c => String(c[0])).join("");
    expect(written).toContain("Updated to 1.2.3.");
    expect(written).toContain("Restart Hermes to apply.");
    stderrSpy.mockRestore();
  });
});

describe("autoUpdate — default timeoutMs", () => {
  it("uses 90000ms when no timeoutMs override is provided", async () => {
    const spawnFn = vi.fn().mockResolvedValue({ stdout: "is up to date", stderr: "", code: 0 });
    // No timeoutMs override
    await autoUpdate(VALID_CREDS, {
      agent: "claude", spawn: spawnFn, hivemindBinaryPath: "/u/bin/hivemind", stderr: stderrMock, skipLock: true,
    });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn.mock.calls[0][2]).toBe(90_000);
  });
});

describe("autoUpdate — concurrency lock", () => {
  // The lock prevents two session-starts from running `npm install -g`
  // simultaneously and leaving the install in a partial state.

  // Use a fake HOME so the lock file lives in a tmpdir, not the real
  // ~/.deeplake/.autoupdate.lock — otherwise tests would fight with each
  // other and with whatever `hivemind autoupdate` state the dev has.
  let TMP_HOME: string;
  let ORIGINAL_HOME: string | undefined;

  beforeEach(async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    TMP_HOME = mkdtempSync(join(tmpdir(), "autoupdate-lock-"));
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(TMP_HOME, ".deeplake"), { recursive: true });
    ORIGINAL_HOME = process.env.HOME;
    process.env.HOME = TMP_HOME;
  });

  afterEach(async () => {
    process.env.HOME = ORIGINAL_HOME;
    const { rmSync } = await import("node:fs");
    rmSync(TMP_HOME, { recursive: true, force: true });
  });

  it("acquires the lock + spawns when no other autoupdate is in flight", async () => {
    const spawnFn = vi.fn().mockResolvedValue({ stdout: "is up to date", stderr: "", code: 0 });
    // skipLock omitted (default false) — exercises the real lock path
    await autoUpdate(VALID_CREDS, {
      agent: "claude", spawn: spawnFn, hivemindBinaryPath: "/u/bin/hivemind", stderr: stderrMock,
    });
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it("releases the lock after the spawn returns (next call also succeeds)", async () => {
    const spawnFn = vi.fn().mockResolvedValue({ stdout: "is up to date", stderr: "", code: 0 });
    await autoUpdate(VALID_CREDS, {
      agent: "claude", spawn: spawnFn, hivemindBinaryPath: "/u/bin/hivemind", stderr: stderrMock,
    });
    await autoUpdate(VALID_CREDS, {
      agent: "codex", spawn: spawnFn, hivemindBinaryPath: "/u/bin/hivemind", stderr: stderrMock,
    });
    // Both should have spawned — the first run released the lock for the second.
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });

  it("releases the lock even when the spawn throws", async () => {
    const failingSpawn = vi.fn().mockRejectedValue(new Error("ENOENT"));
    await autoUpdate(VALID_CREDS, {
      agent: "claude", spawn: failingSpawn, hivemindBinaryPath: "/u/bin/hivemind", stderr: stderrMock,
    });
    // After failure, lock should be released → next call can spawn.
    const okSpawn = vi.fn().mockResolvedValue({ stdout: "is up to date", stderr: "", code: 0 });
    await autoUpdate(VALID_CREDS, {
      agent: "codex", spawn: okSpawn, hivemindBinaryPath: "/u/bin/hivemind", stderr: stderrMock,
    });
    expect(okSpawn).toHaveBeenCalledTimes(1);
  });

  it("skips the spawn when another holder has the lock", async () => {
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const lockPath = join(TMP_HOME, ".deeplake", ".autoupdate.lock");
    // Pre-populate the lock — simulates another agent's session-start running.
    writeFileSync(lockPath, "99999\n");  // pid that's almost certainly not us
    const spawnFn = vi.fn();
    await autoUpdate(VALID_CREDS, {
      agent: "claude", spawn: spawnFn, hivemindBinaryPath: "/u/bin/hivemind", stderr: stderrMock,
    });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("clears a stale lock (older than LOCK_STALE_MS) and proceeds", async () => {
    const { writeFileSync, utimesSync } = await import("node:fs");
    const { join } = await import("node:path");
    const lockPath = join(TMP_HOME, ".deeplake", ".autoupdate.lock");
    writeFileSync(lockPath, "99999\n");
    // Backdate the mtime to 10 minutes ago — older than LOCK_STALE_MS (5 min).
    const tenMinAgo = (Date.now() - 10 * 60_000) / 1000;
    utimesSync(lockPath, tenMinAgo, tenMinAgo);
    const spawnFn = vi.fn().mockResolvedValue({ stdout: "is up to date", stderr: "", code: 0 });
    await autoUpdate(VALID_CREDS, {
      agent: "claude", spawn: spawnFn, hivemindBinaryPath: "/u/bin/hivemind", stderr: stderrMock,
    });
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });
});

describe("autoUpdate — default spawn close-code edge cases", () => {
  it("default spawn: subprocess that exits with code 0 + no recognized output → silent", async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "fake-hivemind-"));
    const fakeBin = join(dir, "hivemind");
    // Exits 0 but prints nothing recognizable (similar to a misbehaving binary)
    writeFileSync(fakeBin, "#!/usr/bin/env bash\necho 'something else'\nexit 0\n");
    chmodSync(fakeBin, 0o755);
    try {
      await autoUpdate(VALID_CREDS, {
        agent: "claude", hivemindBinaryPath: fakeBin, stderr: stderrMock, skipLock: true,
      });
      // No "Updated to" / "Update available" / "is up to date" → silent
      expect(stderrMock).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("default spawn: 'is up to date' output → silent (common case, no stderr noise)", async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "fake-hivemind-"));
    const fakeBin = join(dir, "hivemind");
    writeFileSync(fakeBin, "#!/usr/bin/env bash\necho 'hivemind 1.0.0 is up to date (npm latest: 1.0.0).'\n");
    chmodSync(fakeBin, 0o755);
    try {
      await autoUpdate(VALID_CREDS, {
        agent: "claude", hivemindBinaryPath: fakeBin, stderr: stderrMock, skipLock: true,
      });
      // 'is up to date' is suppressed
      expect(stderrMock).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
