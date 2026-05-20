/**
 * Aggregate KPI current values from the append-only `hivemind_task_events`
 * stream. `computeCurrent(task_id, kpi_id)` returns SUM(value) for the
 * given pair; the (task_id, kpi_id) lookup index created by
 * ensureTaskEventsTable keeps the SUM cheap at v1 scale.
 *
 * Why we aggregate from events rather than read the snapshot column on
 * the task row:
 *
 *   - The task row's `kpis[].current` field is a (T4 LLM gen or T6
 *     renderer) convenience snapshot, not authoritative. It's also
 *     subject to the version-bump pattern, so a stale write would shadow
 *     a fresh event.
 *   - Events are append-only — no UPDATE coalescing risk. The
 *     aggregation result reflects every event that landed.
 *   - The schema reads consistently for both single-KPI lookup
 *     (computeCurrent) and bulk batched aggregation (computeAllForTask).
 *
 * The aggregations are read-side only. Writes go through ./append.ts.
 *
 * Why we do NOT filter by `task_version` (codex review pass 2 question):
 *
 *   Events carry `task_version` for FORENSIC traceability (what version
 *   of the task was current when this event was emitted), NOT as a
 *   reset mechanism. Aggregation deliberately sums across all versions
 *   for one (task_id, kpi_id) pair so that editing a task does not
 *   reset its progress: someone who's merged 3 PRs against "ship feature
 *   X" still has 3/5 done after editing the description to "ship
 *   feature X (P0)".
 *
 *   The protection against accidental rebinding-of-old-progress is at a
 *   different layer: the SessionStart renderer (T6) and `tasks report`
 *   iterate over the LATEST version's `kpis` JSONB only. An edit that
 *   replaces the KPI set with new kpi_ids will simply not display the
 *   old events — they're orphaned in the aggregate map. An edit that
 *   keeps the same kpi_id is interpreted as "still the same KPI", and
 *   accumulating progress is the intuitive UX.
 *
 *   If a future use case wants point-in-time / forensic views ("what
 *   was the v=1 state of this KPI?"), a `computeForVersion(task_id,
 *   kpi_id, version)` helper can be added without breaking this one.
 */

import { sqlIdent, sqlStr } from "../utils/sql.js";

export type QueryFn = (sql: string) => Promise<Array<Record<string, unknown>>>;

/**
 * Compute the current value of one KPI on one task by summing every
 * event row with the matching (task_id, kpi_id) tuple. Returns 0 when
 * no events have been emitted yet — distinguishing "no events" from
 * "events sum to zero" is intentionally not a contract here, because
 * the SessionStart renderer (T6) treats both cases identically.
 */
export async function computeCurrent(
  query: QueryFn,
  tableName: string,
  taskId: string,
  kpiId: string,
): Promise<number> {
  const safe = sqlIdent(tableName);
  const rows = await query(
    `SELECT SUM(value) AS total FROM "${safe}" ` +
      `WHERE task_id = '${sqlStr(taskId)}' AND kpi_id = '${sqlStr(kpiId)}'`,
  );
  return normalizeTotal(rows[0]?.total);
}

/**
 * Compute current values for every KPI on a single task in one round
 * trip. Returns a `{ kpi_id → current }` map; KPIs with no events get
 * value 0 (caller can decide how to render "0 vs missing").
 *
 * Saves the N round-trips that the obvious `for (kpi of task.kpis)
 * computeCurrent(...)` loop would produce — important once a task has
 * 5+ KPIs and we're rendering them in a SessionStart inject block.
 */
export async function computeAllForTask(
  query: QueryFn,
  tableName: string,
  taskId: string,
): Promise<Record<string, number>> {
  const safe = sqlIdent(tableName);
  const rows = await query(
    `SELECT kpi_id, SUM(value) AS total FROM "${safe}" ` +
      `WHERE task_id = '${sqlStr(taskId)}' ` +
      `GROUP BY kpi_id`,
  );
  const out: Record<string, number> = {};
  for (const row of rows) {
    const kpiId = typeof row.kpi_id === "string" ? row.kpi_id : "";
    if (!kpiId) continue; // task-level events with NULL kpi_id are not per-KPI counters
    out[kpiId] = normalizeTotal(row.total);
  }
  return out;
}

/**
 * Compute KPI totals for MANY tasks in one round-trip. Returns
 * `{ task_id → { kpi_id → total } }`. Tasks with no events get an
 * empty inner map; KPIs with no events for an existing task get 0
 * (callers should default missing keys to 0).
 *
 * Used by the SessionStart renderer (T6) so injecting 10 tasks with
 * KPIs costs 1 SQL round-trip, not 10. The (task_id, kpi_id) lookup
 * index keeps the GROUP BY cheap.
 *
 * Edge case: empty taskIds → early-return {}, no SQL issued. Without
 * the early return we'd emit `WHERE task_id IN ()` which is invalid.
 */
export async function computeAllForTasks(
  query: QueryFn,
  tableName: string,
  taskIds: string[],
): Promise<Record<string, Record<string, number>>> {
  if (taskIds.length === 0) return {};
  const safe = sqlIdent(tableName);
  const inList = taskIds.map(id => `'${sqlStr(id)}'`).join(", ");
  const rows = await query(
    `SELECT task_id, kpi_id, SUM(value) AS total FROM "${safe}" ` +
      `WHERE task_id IN (${inList}) ` +
      `GROUP BY task_id, kpi_id`,
  );
  const out: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    const tid = typeof row.task_id === "string" ? row.task_id : "";
    const kid = typeof row.kpi_id === "string" ? row.kpi_id : "";
    if (!tid || !kid) continue;
    if (!out[tid]) out[tid] = {};
    out[tid][kid] = normalizeTotal(row.total);
  }
  return out;
}

/**
 * Normalise the SUM(value) cell into a finite number. Deeplake may
 * return either a number or a string (driver-dependent serialization);
 * null comes back when there are zero matching rows.
 */
function normalizeTotal(raw: unknown): number {
  if (raw == null) return 0;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  if (typeof raw === "string") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
