/**
 * Push a graph snapshot to the Deeplake `codebase` table (Phase 3 — simple).
 *
 * Pattern: SELECT-before-INSERT with drift detection.
 *   1. Bootstrap the table on first push (lazy schema).
 *   2. SELECT existing row for (org, workspace, repo, user, worktree, commit).
 *   3. If row exists with matching snapshot_sha256 → no-op (idempotent).
 *   4. If row exists with DIFFERENT snapshot_sha256 → log drift warning,
 *      DO NOT overwrite (same commit producing different content = extractor
 *      version drift; let a human investigate before clobbering history).
 *   5. If no row → INSERT.
 *
 * Phase 3 simplifications (iterate later):
 *   - No persistent retry queue. Network failures log + drop. v1.1 adds a
 *     `.push-queue.jsonl` drain.
 *   - No batch INSERT. One snapshot = one INSERT.
 *   - Best-effort: any failure short-circuits without surfacing to the
 *     build caller. The local snapshot is the source of truth; cloud is
 *     a sync target.
 *
 * Privacy: push only happens when `loadConfig()` returns auth credentials.
 * No auth → silent no-op (the user wasn't logged in; they didn't opt in).
 * Disable explicitly via `HIVEMIND_GRAPH_PUSH=0` in env.
 */

import { createHash } from "node:crypto";

import { loadConfig, type Config } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { sqlIdent, sqlStr } from "../utils/sql.js";
import type { GraphSnapshot } from "./types.js";

export type PushOutcome =
  | { kind: "skipped-no-auth" }
  | { kind: "skipped-disabled" }
  | { kind: "inserted"; commitSha: string }
  | { kind: "already-current"; commitSha: string }
  | { kind: "drift"; commitSha: string; localSha256: string; cloudSha256: string }
  | { kind: "error"; message: string };

export interface PushDeps {
  /** Override for tests; defaults to loadConfig(). Returns null when no auth. */
  loadConfig?: () => Config | null;
  /** Override for tests; defaults to constructing a real DeeplakeApi. */
  makeApi?: (config: Config) => DeeplakeApi;
}

/**
 * Push a single snapshot. Returns the outcome — callers log it but should
 * NOT block on this (push is best-effort; local snapshot is the truth).
 */
export async function pushSnapshot(
  snapshot: GraphSnapshot,
  worktreeId: string,
  deps: PushDeps = {},
): Promise<PushOutcome> {
  if (process.env.HIVEMIND_GRAPH_PUSH === "0") {
    return { kind: "skipped-disabled" };
  }
  const config = (deps.loadConfig ?? loadConfig)();
  if (config === null) {
    return { kind: "skipped-no-auth" };
  }
  const commitSha = snapshot.graph.commit_sha;
  if (commitSha === null) {
    // No commit context → can't form the identity key. Silently skip.
    return { kind: "skipped-no-auth" };
  }
  const api = (deps.makeApi ?? defaultMakeApi)(config);

  try {
    await api.ensureCodebaseTable(config.codebaseTableName);
  } catch (err) {
    return errorOutcome("ensureCodebaseTable", err);
  }

  // Compute snapshot_sha256 the same way as snapshot.ts: canonical JSON over
  // the stable fields only (excludes observation).
  const snapshotSha256 = computeSnapshotSha256(snapshot);

  // SELECT existing row for this identity key.
  const tableId = sqlIdent(config.codebaseTableName);
  const repoSlug = snapshot.graph.repo_key;
  const userId = config.userName;
  const selectSql =
    `SELECT snapshot_sha256 FROM "${tableId}" WHERE ` +
    `org_id = '${sqlStr(config.orgId)}' AND ` +
    `workspace_id = '${sqlStr(config.workspaceId)}' AND ` +
    `repo_slug = '${sqlStr(repoSlug)}' AND ` +
    `user_id = '${sqlStr(userId)}' AND ` +
    `worktree_id = '${sqlStr(worktreeId)}' AND ` +
    `commit_sha = '${sqlStr(commitSha)}'`;

  let existing: Record<string, unknown>[];
  try {
    existing = await api.query(selectSql);
  } catch (err) {
    return errorOutcome("SELECT existing", err);
  }

  if (existing.length > 0) {
    const cloudSha = String(existing[0]!.snapshot_sha256 ?? "");
    if (cloudSha === snapshotSha256) {
      return { kind: "already-current", commitSha };
    }
    // Drift: same commit, different content. Don't overwrite.
    return {
      kind: "drift",
      commitSha,
      localSha256: snapshotSha256,
      cloudSha256: cloudSha,
    };
  }

  // INSERT a fresh row. snapshot_jsonb stores the canonical bytes — same
  // as what writeSnapshot writes to disk, ensuring server-side consumers
  // see byte-identical content to local readers.
  const canonical = canonicalJSON(snapshot);
  const observation = snapshot.observation;
  const insertSql =
    `INSERT INTO "${tableId}" (` +
    "org_id, workspace_id, repo_slug, user_id, worktree_id, commit_sha, " +
    "parent_sha, branch, ts, pushed_by, " +
    "snapshot_sha256, snapshot_jsonb, node_count, edge_count, " +
    "generator, generator_version, schema_version" +
    `) VALUES (` +
    `'${sqlStr(config.orgId)}', ` +
    `'${sqlStr(config.workspaceId)}', ` +
    `'${sqlStr(repoSlug)}', ` +
    `'${sqlStr(userId)}', ` +
    `'${sqlStr(worktreeId)}', ` +
    `'${sqlStr(commitSha)}', ` +
    `'${sqlStr(snapshot.graph.commit_sha ?? "")}', ` + // parent_sha placeholder — Phase 1.5 doesn't compute it; v1.6 reads git rev-parse HEAD~1
    `'${sqlStr(observation.branch ?? "")}', ` +
    `'${sqlStr(observation.ts)}', ` +
    `'${sqlStr(userId)}', ` +
    `'${sqlStr(snapshotSha256)}', ` +
    `'${sqlStr(canonical)}', ` +
    `${snapshot.nodes.length}, ` +
    `${snapshot.links.length}, ` +
    `'${sqlStr(snapshot.graph.generator)}', ` +
    `'${sqlStr(observation.generator_version)}', ` +
    `${snapshot.graph.schema_version})`;

  try {
    await api.query(insertSql);
    return { kind: "inserted", commitSha };
  } catch (err) {
    return errorOutcome("INSERT", err);
  }
}

function defaultMakeApi(config: Config): DeeplakeApi {
  return new DeeplakeApi(
    config.token,
    config.apiUrl,
    config.orgId,
    config.workspaceId,
    config.tableName,
  );
}

function errorOutcome(stage: string, err: unknown): PushOutcome {
  const message = err instanceof Error ? err.message : String(err);
  return { kind: "error", message: `${stage}: ${message}` };
}

/**
 * Mirror of computeSnapshotSha256 from snapshot.ts — kept local to avoid a
 * cross-module dep that would pull writeSnapshot's I/O into the push path.
 * Both functions MUST produce identical bytes for the same input; covered
 * by tests/shared/graph/push.test.ts.
 */
function computeSnapshotSha256(snapshot: GraphSnapshot): string {
  const stable = {
    directed: snapshot.directed,
    multigraph: snapshot.multigraph,
    graph: snapshot.graph,
    nodes: snapshot.nodes,
    links: snapshot.links,
  };
  return createHash("sha256").update(canonicalJSON(stable)).digest("hex");
}

function canonicalJSON(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}
