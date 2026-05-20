import { describe, expect, it, vi } from "vitest";
import { renderContextBlock } from "../../src/hooks/shared/context-renderer.js";

/**
 * Tests for the shared SessionStart context renderer.
 *
 * The renderer composes listRules + listTasks + computeAllForTasks
 * behind a single QueryFn. We mock the QueryFn at the network
 * boundary (same pattern as the other module tests). Each test
 * scripts the SELECTs in their expected order:
 *
 *   1. listRules    → SELECT id, rule_id, ... FROM "hivemind_rules" ORDER BY ...
 *   2. listTasks    → SELECT id, task_id, ... FROM "hivemind_tasks" ORDER BY ...
 *   3. computeAllForTasks → SELECT task_id, kpi_id, SUM(value) ... (skipped if no tasks)
 */
function mockQuery(script: Array<(sql: string) => unknown>) {
  const calls: string[] = [];
  let step = 0;
  const query = vi.fn(async (sql: string) => {
    calls.push(sql);
    if (step < script.length) {
      const out = script[step++](sql);
      return Array.isArray(out) ? (out as Array<Record<string, unknown>>) : [];
    }
    return [];
  });
  return { calls, query };
}

const TABLES = {
  rulesTable: "hivemind_rules",
  tasksTable: "hivemind_tasks",
  taskEventsTable: "hivemind_task_events",
};

function fakeRule(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-r", rule_id: "rule-1", text: "no DROP TABLE",
    scope: "team", status: "active", assigned_by: "alice@activeloop.ai",
    version: 1, created_at: "2026-05-20T10:00:00Z",
    agent: "manual", plugin_version: "0.7.99",
    ...overrides,
  };
}

const SAMPLE_KPI = {
  kpi_id: "k_pr",
  name: "PRs merged",
  target: 5,
  unit: "count",
  generated_by: "manual",
  generated_at: "2026-05-20T10:00:00Z",
};

function fakeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-t", task_id: "task-1", text: "ship feature X",
    scope: "team", status: "active",
    assigned_to: "alice@activeloop.ai", assigned_by: "alice@activeloop.ai",
    kpis: JSON.stringify([SAMPLE_KPI]),
    version: 1, created_at: "2026-05-20T10:00:00Z",
    agent: "manual", plugin_version: "0.7.99",
    ...overrides,
  };
}

// ── empty / graceful-degradation paths ─────────────────────────────────────

describe("renderContextBlock — empty + degradation", () => {
  it("returns '' when no rules and no tasks exist (nothing to inject)", async () => {
    const { calls, query } = mockQuery([
      () => [],   // listRules
      () => [],   // listTasks
    ]);
    const out = await renderContextBlock(query, { ...TABLES, currentUser: "alice@activeloop.ai" });
    expect(out).toBe("");
    // No computeAllForTasks query — taskIds was [], early-return.
    expect(calls).toHaveLength(2);
  });

  it("swallows missing-table errors and returns '' (SessionStart MUST NOT fail)", async () => {
    const { query } = mockQuery([
      () => { throw new Error(`relation "hivemind_rules" does not exist`); },
    ]);
    const out = await renderContextBlock(query, { ...TABLES, currentUser: "alice@activeloop.ai" });
    expect(out).toBe("");
  });

  it("swallows any error (network, parse, etc.) and returns ''", async () => {
    const { query } = mockQuery([
      () => { throw new Error("network timeout"); },
    ]);
    const out = await renderContextBlock(query, { ...TABLES, currentUser: "alice@activeloop.ai" });
    expect(out).toBe("");
  });

  it("invokes the optional log callback on error", async () => {
    const log = vi.fn();
    const { query } = mockQuery([
      () => { throw new Error("network timeout"); },
    ]);
    await renderContextBlock(query, { ...TABLES, currentUser: "alice@activeloop.ai" }, { log });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("network timeout");
  });
});

// ── rules section ──────────────────────────────────────────────────────────

describe("renderContextBlock — rules section", () => {
  it("renders rules section with full rule_id and text (no truncation regression)", async () => {
    const { query } = mockQuery([
      () => [fakeRule({ rule_id: "rule-aaaa-bbbb-cccc", text: "never DROP TABLE on prod" })],
      () => [],
    ]);
    const out = await renderContextBlock(query, { ...TABLES, currentUser: "alice@activeloop.ai" });
    expect(out).toContain("=== HIVEMIND RULES (1 active) ===");
    expect(out).toContain("- rule-aaaa-bbbb-cccc: never DROP TABLE on prod");
  });

  it("caps to maxRules and shows 'X more' truncation hint", async () => {
    const rules = Array.from({ length: 15 }, (_, i) =>
      fakeRule({ rule_id: `rule-${i}`, text: `rule ${i}`, created_at: `2026-05-20T10:${String(i).padStart(2, "0")}:00Z` }),
    );
    const { query } = mockQuery([
      () => rules,
      () => [],
    ]);
    const out = await renderContextBlock(query, { ...TABLES, currentUser: "alice@activeloop.ai" });
    expect(out).toContain("(5 more — run 'hivemind rules list' to see all)");
    // Header shows the COUNT SHOWN, not the total — keeps the header
    // honest about what's in the block right now.
    expect(out).toContain("=== HIVEMIND RULES (10 active) ===");
  });

  it("respects the maxRules option override", async () => {
    const rules = [fakeRule({ rule_id: "r1" }), fakeRule({ rule_id: "r2" }), fakeRule({ rule_id: "r3" })];
    const { query } = mockQuery([
      () => rules,
      () => [],
    ]);
    const out = await renderContextBlock(
      query,
      { ...TABLES, currentUser: "alice@activeloop.ai" },
      { maxRules: 2 },
    );
    expect(out).toContain("=== HIVEMIND RULES (2 active) ===");
    expect(out).toContain("(1 more");
  });

  it("does NOT emit the rules section when zero active rules exist (tasks still render)", async () => {
    const { query } = mockQuery([
      () => [],                              // listRules
      () => [fakeTask()],                    // listTasks
      () => [{ task_id: "task-1", kpi_id: "k_pr", total: 2 }], // computeAllForTasks
    ]);
    const out = await renderContextBlock(query, { ...TABLES, currentUser: "alice@activeloop.ai" });
    expect(out).not.toContain("HIVEMIND RULES");
    expect(out).toContain("HIVEMIND TASKS");
  });
});

// ── tasks section ──────────────────────────────────────────────────────────

describe("renderContextBlock — tasks section + visibility filter", () => {
  it("renders team tasks (any assignee) AND me-tasks (assigned to current user only)", async () => {
    const tasks = [
      fakeTask({ task_id: "team-a", scope: "team", assigned_to: "alice@activeloop.ai" }),
      fakeTask({ task_id: "team-b", scope: "team", assigned_to: "bob@activeloop.ai" }),
      fakeTask({ task_id: "me-a",   scope: "me",   assigned_to: "alice@activeloop.ai" }),
      fakeTask({ task_id: "me-b",   scope: "me",   assigned_to: "bob@activeloop.ai" }),
    ];
    const { query } = mockQuery([
      () => [],
      () => tasks,
      () => [], // no events
    ]);
    const out = await renderContextBlock(query, { ...TABLES, currentUser: "alice@activeloop.ai" });
    expect(out).toContain("team-a");
    expect(out).toContain("team-b"); // team task assigned to bob — alice still sees it (visibility)
    expect(out).toContain("me-a");
    // me-b is bob's personal task — alice MUST NOT see it
    expect(out).not.toContain("me-b");
  });

  it("highlights team tasks assigned to the current user with ★YOU", async () => {
    const { query } = mockQuery([
      () => [],
      () => [
        fakeTask({ task_id: "yours",  scope: "team", assigned_to: "alice@activeloop.ai" }),
        fakeTask({ task_id: "theirs", scope: "team", assigned_to: "bob@activeloop.ai" }),
      ],
      () => [],
    ]);
    const out = await renderContextBlock(query, { ...TABLES, currentUser: "alice@activeloop.ai" });
    expect(out).toMatch(/team\] yours:.*★YOU/);
    expect(out).not.toMatch(/team\] theirs:.*★YOU/);
  });

  it("renders KPI lines with computed current/target/unit", async () => {
    const { query } = mockQuery([
      () => [],
      () => [
        fakeTask({ task_id: "T1", kpis: JSON.stringify([SAMPLE_KPI, {
          kpi_id: "k_lines", name: "Lines reviewed", target: 200, unit: "lines",
          generated_by: "manual", generated_at: "2026-05-20T10:00:00Z",
        }]) }),
      ],
      () => [
        { task_id: "T1", kpi_id: "k_pr",    total: 3 },
        { task_id: "T1", kpi_id: "k_lines", total: 75 },
      ],
    ]);
    const out = await renderContextBlock(query, { ...TABLES, currentUser: "alice@activeloop.ai" });
    expect(out).toContain("PRs merged: 3/5 count");
    expect(out).toContain("Lines reviewed: 75/200 lines");
  });

  it("KPI with no events shows 0/target (not '?/target' — events stream is authoritative)", async () => {
    const { query } = mockQuery([
      () => [],
      () => [fakeTask()],
      () => [],
    ]);
    const out = await renderContextBlock(query, { ...TABLES, currentUser: "alice@activeloop.ai" });
    expect(out).toContain("PRs merged: 0/5 count");
  });

  it("task with no KPIs emits no '|' separator on the line", async () => {
    // Use a different assigned_to so the ★YOU highlight doesn't
    // appear (would change the line ending and the line-anchored
    // regex below would need extra slack). The KPI-line presence/
    // absence test is what this case is actually pinning.
    const { query } = mockQuery([
      () => [],
      () => [fakeTask({ kpis: "[]", assigned_to: "bob@activeloop.ai" })],
      () => [],
    ]);
    const out = await renderContextBlock(query, { ...TABLES, currentUser: "alice@activeloop.ai" });
    // No KPIs → no " | ..." suffix on the task line.
    expect(out).toMatch(/team\] task-1: ship feature X$/m);
  });

  it("caps tasks to maxTasks and shows 'X more' truncation hint", async () => {
    const visibleTasks = Array.from({ length: 13 }, (_, i) =>
      fakeTask({
        task_id: `t${i}`,
        scope: "team",
        kpis: "[]",
        created_at: `2026-05-20T10:${String(i).padStart(2, "0")}:00Z`,
      }),
    );
    const { query } = mockQuery([
      () => [],
      () => visibleTasks,
      () => [], // no events
    ]);
    const out = await renderContextBlock(query, { ...TABLES, currentUser: "alice@activeloop.ai" });
    expect(out).toContain("=== HIVEMIND TASKS (10 active) ===");
    expect(out).toContain("(3 more — run 'hivemind tasks list' to see all)");
  });

  it("computeAllForTasks is called with the SHOWN task ids only (not the over-fetched set)", async () => {
    const visibleTasks = Array.from({ length: 12 }, (_, i) =>
      fakeTask({
        task_id: `t${i}`,
        scope: "team",
        created_at: `2026-05-20T10:${String(i).padStart(2, "0")}:00Z`,
      }),
    );
    const { calls, query } = mockQuery([
      () => [],
      () => visibleTasks,
      () => [],
    ]);
    await renderContextBlock(query, { ...TABLES, currentUser: "alice@activeloop.ai" }, { maxTasks: 5 });
    // 3rd call is the events aggregate — it should target exactly the
    // 5 displayed task ids, not the 12 fetched.
    const eventsSql = calls[2];
    expect(eventsSql).toContain("task_id IN (");
    // 5 ids → 4 commas
    const inListMatch = eventsSql.match(/task_id IN \(([^)]+)\)/);
    expect(inListMatch?.[1].split(",")).toHaveLength(5);
  });
});

// ── HOW-TO footer ──────────────────────────────────────────────────────────

describe("renderContextBlock — HOW-TO footer", () => {
  it("emits the HOW-TO block when there's anything to show", async () => {
    const { query } = mockQuery([
      () => [fakeRule()],
      () => [],
    ]);
    const out = await renderContextBlock(query, { ...TABLES, currentUser: "alice@activeloop.ai" });
    expect(out).toContain("=== HIVEMIND HOW-TO ===");
    expect(out).toContain("'hivemind tasks progress");
    expect(out).toContain("'hivemind rules list'");
  });

  it("omits the HOW-TO block when there's nothing to show (no banner without content)", async () => {
    const { query } = mockQuery([
      () => [],
      () => [],
    ]);
    const out = await renderContextBlock(query, { ...TABLES, currentUser: "alice@activeloop.ai" });
    expect(out).toBe("");
  });
});