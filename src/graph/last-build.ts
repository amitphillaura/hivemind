/**
 * Last-build state file (Phase 1.5).
 *
 * Written by writeSnapshot after each successful build:
 *   ~/.hivemind/graphs/<repo-key>/.last-build.json
 *     { ts: epoch_ms, commit_sha: string | null, snapshot_sha256: string }
 *
 * Read by the Stop hook to gate auto-rebuilds on:
 *   - rate limit (now - ts >= TICK_INTERVAL_MS)
 *   - new commit (HEAD != commit_sha)
 *   - source file diff (git diff --name-only ... -- '<src-globs>' | wc -l >= 1)
 *
 * Best-effort I/O: a missing or corrupt file is treated as "never built";
 * write failures are swallowed so a cache problem can't break the build.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface LastBuildState {
  /** Epoch milliseconds. */
  ts: number;
  /** HEAD commit at build time. null when not in a git repo. */
  commit_sha: string | null;
  /** Content fingerprint of the snapshot that was written (NOT including observation). */
  snapshot_sha256: string;
}

export function lastBuildPath(baseDir: string): string {
  return join(baseDir, ".last-build.json");
}

/**
 * Persist last-build state. Atomic via temp+rename in the same directory.
 * Errors are swallowed: a failure to write the state file should NOT roll
 * back a successful snapshot write (the snapshot is the source of truth).
 */
export function writeLastBuild(baseDir: string, state: LastBuildState): void {
  const path = lastBuildPath(baseDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, path);
  } catch {
    // best-effort
  }
}

/**
 * Load last-build state. Returns null on missing file, parse failure, or
 * shape mismatch — caller treats null as "never built".
 */
export function readLastBuild(baseDir: string): LastBuildState | null {
  const path = lastBuildPath(baseDir);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const o = parsed as Partial<LastBuildState>;
  if (typeof o.ts !== "number") return null;
  if (o.commit_sha !== null && typeof o.commit_sha !== "string") return null;
  if (typeof o.snapshot_sha256 !== "string") return null;
  return { ts: o.ts, commit_sha: o.commit_sha, snapshot_sha256: o.snapshot_sha256 };
}
