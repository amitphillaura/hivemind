import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireBuildLock,
  lockPath,
  releaseBuildLock,
} from "../../../src/graph/build-lock.js";

describe("build-lock — acquire/release", () => {
  let baseDir: string;
  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "build-lock-"));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("first acquire returns acquired with reason='acquired' and creates the lock file", () => {
    const r = acquireBuildLock(baseDir);
    expect(r.acquired).toBe(true);
    expect(r.reason).toBe("acquired");
    expect(existsSync(lockPath(baseDir))).toBe(true);
  });

  it("second acquire while lock is fresh returns held-by-other", () => {
    const a = acquireBuildLock(baseDir);
    expect(a.acquired).toBe(true);
    const b = acquireBuildLock(baseDir);
    expect(b.acquired).toBe(false);
    expect(b.reason).toBe("held-by-other");
  });

  it("release removes the lock file (idempotent on missing)", () => {
    acquireBuildLock(baseDir);
    expect(existsSync(lockPath(baseDir))).toBe(true);
    releaseBuildLock(baseDir);
    expect(existsSync(lockPath(baseDir))).toBe(false);
    // calling release again is safe
    releaseBuildLock(baseDir);
    expect(existsSync(lockPath(baseDir))).toBe(false);
  });

  it("after release, next acquire succeeds again", () => {
    acquireBuildLock(baseDir);
    releaseBuildLock(baseDir);
    const r = acquireBuildLock(baseDir);
    expect(r.acquired).toBe(true);
    expect(r.reason).toBe("acquired");
  });

  it("stale lock (mtime > STALE_LOCK_MS) is recovered with reason='stale-recovered'", () => {
    // Plant a stale lock directly (simulating a crashed previous holder).
    writeFileSync(lockPath(baseDir), JSON.stringify({ pid: 99999, ts: 0 }), { flag: "w" });
    // Backdate mtime by 10 minutes (well past 5-min stale threshold).
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lockPath(baseDir), tenMinAgo, tenMinAgo);

    const r = acquireBuildLock(baseDir);
    expect(r.acquired).toBe(true);
    expect(r.reason).toBe("stale-recovered");
    expect(existsSync(lockPath(baseDir))).toBe(true);
  });

  it("non-stale lock (mtime within STALE_LOCK_MS) is NOT taken over", () => {
    // Plant a lock with current mtime
    writeFileSync(lockPath(baseDir), JSON.stringify({ pid: 99999, ts: Date.now() }), { flag: "w" });
    const r = acquireBuildLock(baseDir);
    expect(r.acquired).toBe(false);
    expect(r.reason).toBe("held-by-other");
  });

  it("lock file lives at <baseDir>/.build.in-flight", () => {
    expect(lockPath(baseDir)).toBe(join(baseDir, ".build.in-flight"));
  });

  it("stale recovery is EXCLUSIVE: simulated double-recovery doesn't produce two acquired locks (codex P1)", () => {
    // Plant a stale lock.
    writeFileSync(lockPath(baseDir), JSON.stringify({ pid: 99999, ts: 0 }), { flag: "w" });
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lockPath(baseDir), tenMinAgo, tenMinAgo);

    // First recoverer succeeds.
    const a = acquireBuildLock(baseDir);
    expect(a.acquired).toBe(true);
    expect(a.reason).toBe("stale-recovered");
    // Second recoverer must NOT also acquire — the lock is now fresh in
    // its eyes, so it gets held-by-other instead of overwriting.
    const b = acquireBuildLock(baseDir);
    expect(b.acquired).toBe(false);
    expect(b.reason).toBe("held-by-other");
  });

  it("after stale recovery, the lock file is fresh (mtime is current)", () => {
    writeFileSync(lockPath(baseDir), JSON.stringify({ pid: 99999, ts: 0 }), { flag: "w" });
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lockPath(baseDir), tenMinAgo, tenMinAgo);
    const before = Date.now();
    acquireBuildLock(baseDir);
    // Lock file's mtime should be >= our 'before' timestamp (within sec precision)
    const stat = require("node:fs").statSync(lockPath(baseDir));
    expect(stat.mtime.getTime()).toBeGreaterThanOrEqual(before - 2000); // 2s slop for FS precision
  });

  it("acquire creates baseDir when missing (first-ever build path)", () => {
    // The first auto-build happens before snapshot.ts has had a chance to
    // mkdir the per-repo dir. acquireBuildLock must create it so the lock
    // can be placed; otherwise no build would ever succeed on a fresh repo.
    rmSync(baseDir, { recursive: true, force: true });
    const r = acquireBuildLock(baseDir);
    expect(r.acquired).toBe(true);
    expect(r.reason).toBe("acquired");
    expect(existsSync(lockPath(baseDir))).toBe(true);
  });

  // CodeRabbit P1 — owner-gated release.
  describe("releaseBuildLock — owner-gated", () => {
    it("release of OUR own lock unlinks the file", () => {
      acquireBuildLock(baseDir);
      expect(existsSync(lockPath(baseDir))).toBe(true);
      releaseBuildLock(baseDir);
      expect(existsSync(lockPath(baseDir))).toBe(false);
    });

    it("release of SOMEONE ELSE's lock does NOT unlink (preserves their lock)", () => {
      // Write a lock file owned by a different pid (simulating a sibling
      // process). Our release call must NOT touch it.
      writeFileSync(lockPath(baseDir), JSON.stringify({
        pid: process.pid + 99999,  // definitely not us
        ts: Date.now(),
      }));
      releaseBuildLock(baseDir);
      expect(existsSync(lockPath(baseDir))).toBe(true);
    });

    it("release on missing lock is a no-op (ENOENT swallowed)", () => {
      // No lock file exists — release should not throw.
      expect(() => releaseBuildLock(baseDir)).not.toThrow();
      expect(existsSync(lockPath(baseDir))).toBe(false);
    });

    it("release on corrupt lock file (unparseable JSON) is a no-op", () => {
      // A corrupt lock file means we can't read the pid → can't prove
      // we own it → leave it alone (the next stale-recovery will clean it).
      writeFileSync(lockPath(baseDir), "{ corrupt json");
      expect(() => releaseBuildLock(baseDir)).not.toThrow();
      expect(existsSync(lockPath(baseDir))).toBe(true);
    });

    it("release on lock with no `pid` field does NOT unlink", () => {
      writeFileSync(lockPath(baseDir), JSON.stringify({ ts: Date.now() }));
      releaseBuildLock(baseDir);
      // No pid means we can't claim ownership → file stays.
      expect(existsSync(lockPath(baseDir))).toBe(true);
    });

    it("stale-recovered lock IS owned by us (we can release it)", () => {
      // Take a lock with another pid, age it past STALE_LOCK_MS, then
      // recover. After recovery the file should belong to us, so a
      // subsequent release succeeds.
      writeFileSync(lockPath(baseDir), JSON.stringify({
        pid: process.pid + 1,
        ts: Date.now() - 1_000_000,
      }));
      utimesSync(lockPath(baseDir), Date.now() / 1000 - 10000, Date.now() / 1000 - 10000);
      const r = acquireBuildLock(baseDir);
      expect(r.acquired).toBe(true);
      expect(r.reason).toBe("stale-recovered");
      // Now we own it — release works
      releaseBuildLock(baseDir);
      expect(existsSync(lockPath(baseDir))).toBe(false);
    });
  });
});
