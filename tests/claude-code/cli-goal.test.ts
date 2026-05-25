import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CLI handler tests for `hivemind goal` / `hivemind kpi`.
 *
 * Path B (CLI) is the only goal-write path that cursor / hermes / pi can
 * reach (their plugin hooks can't rewrite Write tool calls — see
 * src/commands/goal.ts header), so any regression in argparse, "not
 * logged in" gating, SQL shape, or escaping silently breaks team-wide
 * goal visibility from those three agents.
 *
 * Mocks DeeplakeApi at the network boundary (per CLAUDE.md testing
 * philosophy) so every test captures the exact SQL the CLI would send.
 *
 * Coverage: goal.ts in trunk was at 1.8% / 0% functions pre-PR #193.
 */

const ensureGoalsTableMock = vi.fn();
const ensureKpisTableMock = vi.fn();
const queryMock = vi.fn();

vi.mock("../../src/config.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("../../src/deeplake-api.js", () => ({
  DeeplakeApi: class {
    constructor(
      _token: string,
      _apiUrl: string,
      _orgId: string,
      _workspaceId: string,
      _tableName: string,
    ) { /* nothing */ }
    ensureGoalsTable(name: string) { return ensureGoalsTableMock(name); }
    ensureKpisTable(name: string) { return ensureKpisTableMock(name); }
    query(sql: string) { return queryMock(sql); }
  },
}));

import { runGoalCommand, runKpiCommand } from "../../src/commands/goal.js";
import { loadConfig } from "../../src/config.js";
const loadConfigMock = loadConfig as unknown as ReturnType<typeof vi.fn>;

const VALID_CONFIG = {
  token: "tok",
  orgId: "org",
  orgName: "OrgName",
  userName: "alice@activeloop.ai",
  workspaceId: "ws",
  apiUrl: "https://api",
  tableName: "memory",
  sessionsTableName: "sessions",
  skillsTableName: "skills",
  rulesTableName: "hivemind_rules",
  goalsTableName: "hivemind_goals_test",
  kpisTableName: "hivemind_kpis_test",
  memoryPath: "/tmp/mem",
};

let stdout: string[] = [];
let stderr: string[] = [];
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdout = [];
  stderr = [];
  ensureGoalsTableMock.mockReset().mockResolvedValue(undefined);
  ensureKpisTableMock.mockReset().mockResolvedValue(undefined);
  queryMock.mockReset().mockResolvedValue([]);
  loadConfigMock.mockReset().mockReturnValue(VALID_CONFIG);
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  }) as any);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  }) as any);
  // process.exit must throw so async functions stop on the first exit() —
  // catch in tests with expectExit(). Mirrors tests/claude-code/cli-rules.test.ts.
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`__EXIT_${code ?? 0}__`);
  }) as any);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  exitSpy.mockRestore();
});

function expectExit(code: number, fn: () => unknown): Promise<void> {
  return expect(fn).rejects.toThrow(new RegExp(`__EXIT_${code}__`));
}

// Concatenated stdout/stderr for substring matching, since each .write call
// is one entry in the array but the CLI doesn't guarantee one entry per line.
const allOut = () => stdout.join("");
const allErr = () => stderr.join("");

// ── help / no-arg / unknown ─────────────────────────────────────────────────

describe("runGoalCommand — help & unknown sub", () => {
  it("prints goal usage with no subcommand", async () => {
    await runGoalCommand([]);
    expect(allOut()).toContain("hivemind goal — manage team goals");
    expect(ensureGoalsTableMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("prints goal usage with --help", async () => {
    await runGoalCommand(["--help"]);
    expect(allOut()).toContain("hivemind goal add");
  });

  it("exits 1 on unknown subcommand", async () => {
    await expectExit(1, () => runGoalCommand(["wat"]));
    expect(allErr()).toContain("unknown goal subcommand: wat");
  });
});

describe("runKpiCommand — help & unknown sub", () => {
  it("prints kpi usage with no subcommand", async () => {
    await runKpiCommand([]);
    expect(allOut()).toContain("hivemind kpi — manage goal KPIs");
  });

  it("exits 1 on unknown subcommand", async () => {
    await expectExit(1, () => runKpiCommand(["wat"]));
    expect(allErr()).toContain("unknown kpi subcommand: wat");
  });
});

// ── login gating ────────────────────────────────────────────────────────────

describe("runGoalCommand — requires login", () => {
  it("exits 1 with a 'not logged in' message when loadConfig returns null", async () => {
    loadConfigMock.mockReturnValue(null);
    await expectExit(1, () => runGoalCommand(["add", "ship it"]));
    expect(allErr()).toMatch(/not logged in/i);
    // critical: no DDL, no query when un-authed (would 401 + leak the
    // attempt across orgs if it slipped through)
    expect(ensureGoalsTableMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("list also gates on login", async () => {
    loadConfigMock.mockReturnValue(null);
    await expectExit(1, () => runGoalCommand(["list"]));
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("done also gates on login", async () => {
    loadConfigMock.mockReturnValue(null);
    await expectExit(1, () => runGoalCommand(["done", "abc"]));
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("kpi add also gates on login", async () => {
    loadConfigMock.mockReturnValue(null);
    await expectExit(1, () => runKpiCommand(["add", "g", "k", "5", "PRs"]));
    expect(queryMock).not.toHaveBeenCalled();
  });
});

// ── goal add ────────────────────────────────────────────────────────────────

describe("runGoalCommand — add", () => {
  it("issues exactly one INSERT into the configured goals table, with v=1 + opened + manual agent", async () => {
    await runGoalCommand(["add", "ship the goals feature"]);
    expect(ensureGoalsTableMock).toHaveBeenCalledExactlyOnceWith("hivemind_goals_test");
    expect(queryMock).toHaveBeenCalledTimes(1);
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toMatch(/^INSERT INTO "hivemind_goals_test" \(id, goal_id, owner, status, content, version, created_at, agent, plugin_version\)/);
    expect(sql).toContain("'opened'");
    expect(sql).toContain("'alice@activeloop.ai'");
    expect(sql).toContain("'manual'");
    expect(sql).toContain("E'ship the goals feature'");
    expect(sql).toContain(", 1, ");
    // emits the goal_id (UUID v4) to stdout so the agent can pipe it
    expect(allOut().trim()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("joins multiple positional args into one text (shell word-splitting fallback)", async () => {
    await runGoalCommand(["add", "ship", "the", "goals"]);
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("E'ship the goals'");
  });

  it("exits 1 when text is missing", async () => {
    await expectExit(1, () => runGoalCommand(["add"]));
    expect(allErr()).toContain("usage: hivemind goal add");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("exits 1 when text is whitespace-only (no row inserted)", async () => {
    await expectExit(1, () => runGoalCommand(["add", "   "]));
    expect(allErr()).toContain("usage: hivemind goal add");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("escapes single quotes in the goal text (SQL injection guard)", async () => {
    await runGoalCommand(["add", "Levon's first goal"]);
    const sql = queryMock.mock.calls[0][0] as string;
    // sqlStr() doubles the single quote: 'Levon''s first goal'
    expect(sql).toContain("E'Levon''s first goal'");
  });
});

// ── goal list ───────────────────────────────────────────────────────────────

describe("runGoalCommand — list", () => {
  it("default scope is --mine: WHERE owner = current_user, no all-clause", async () => {
    queryMock.mockResolvedValueOnce([
      { goal_id: "g1", owner: "alice@activeloop.ai", status: "opened", content: "first goal\nbody" },
    ]);
    await runGoalCommand(["list"]);
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain(`WHERE owner = 'alice@activeloop.ai'`);
    expect(sql).toContain('FROM "hivemind_goals_test"');
    expect(sql).toContain("ORDER BY created_at DESC LIMIT 50");
    // tab-separated row: goal_id\towner\tstatus\tfirst-line-of-content
    expect(allOut()).toContain("g1\talice@activeloop.ai\topened\tfirst goal\n");
  });

  it("--all drops the WHERE owner filter so every team member's goal shows", async () => {
    queryMock.mockResolvedValueOnce([
      { goal_id: "g1", owner: "alice@activeloop.ai", status: "opened", content: "mine" },
      { goal_id: "g2", owner: "bob@activeloop.ai", status: "closed", content: "his" },
    ]);
    await runGoalCommand(["list", "--all"]);
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).not.toContain("WHERE owner");
    // both rows
    expect(allOut()).toContain("g1\t");
    expect(allOut()).toContain("g2\t");
  });

  it("prints '(no goals)' on empty result", async () => {
    queryMock.mockResolvedValueOnce([]);
    await runGoalCommand(["list"]);
    expect(allOut()).toContain("(no goals)");
  });

  it("trims the content to the first line so multi-line goals don't break the TSV", async () => {
    queryMock.mockResolvedValueOnce([
      { goal_id: "g1", owner: "alice@activeloop.ai", status: "opened", content: "short summary\nlong\nbody here" },
    ]);
    await runGoalCommand(["list"]);
    expect(allOut()).toContain("\tshort summary\n");
    expect(allOut()).not.toContain("long");
  });

  it("exits 1 with the API error message on query failure", async () => {
    queryMock.mockRejectedValueOnce(new Error("net down"));
    await expectExit(1, () => runGoalCommand(["list"]));
    expect(allErr()).toContain("hivemind goal list: net down");
  });
});

// ── goal done / progress ────────────────────────────────────────────────────

describe("runGoalCommand — done & progress", () => {
  it("`done` UPDATEs status=closed by goal_id", async () => {
    await runGoalCommand(["done", "11111111-2222-3333-4444-555555555555"]);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toMatch(/^UPDATE "hivemind_goals_test" SET status = 'closed'/);
    expect(sql).toContain(`WHERE goal_id = '11111111-2222-3333-4444-555555555555'`);
    expect(allOut()).toContain("11111111-2222-3333-4444-555555555555 -> closed");
  });

  it("`progress` accepts opened / in_progress / closed", async () => {
    await runGoalCommand(["progress", "abc", "in_progress"]);
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain(`SET status = 'in_progress'`);
    expect(sql).toContain(`WHERE goal_id = 'abc'`);
  });

  it("`progress` rejects any other status (no UPDATE issued)", async () => {
    await expectExit(1, () => runGoalCommand(["progress", "abc", "frozen"]));
    expect(allErr()).toContain("invalid status: frozen");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("`done` without an id prints usage + exits 1", async () => {
    await expectExit(1, () => runGoalCommand(["done"]));
    expect(allErr()).toContain("usage: hivemind goal done");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("`progress` without a status prints usage + exits 1", async () => {
    await expectExit(1, () => runGoalCommand(["progress", "abc"]));
    expect(allErr()).toContain("usage: hivemind goal progress");
    expect(queryMock).not.toHaveBeenCalled();
  });
});

// ── kpi add ─────────────────────────────────────────────────────────────────

describe("runKpiCommand — add", () => {
  it("INSERTs a v1 row into the KPIs table with content carrying name/target/unit", async () => {
    await runKpiCommand(["add", "g-uuid", "k-prs", "5", "PRs", "Pull requests shipped"]);
    expect(ensureKpisTableMock).toHaveBeenCalledExactlyOnceWith("hivemind_kpis_test");
    expect(queryMock).toHaveBeenCalledTimes(1);
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toMatch(/^INSERT INTO "hivemind_kpis_test" \(id, goal_id, kpi_id, content, version, created_at, agent, plugin_version\)/);
    expect(sql).toContain("'g-uuid'");
    expect(sql).toContain("'k-prs'");
    expect(sql).toContain("'manual'");
    expect(sql).toContain(", 1, ");
    // content body — source builds it with real "\n" (template literal)
    expect(sql).toContain("Pull requests shipped\n\n- target: 5\n- current: 0\n- unit: PRs");
    expect(allOut()).toContain("g-uuid/k-prs");
  });

  it("defaults the human-readable name to kpi_id when no [name] is given", async () => {
    await runKpiCommand(["add", "g-uuid", "k-prs", "5", "PRs"]);
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("k-prs\n\n- target: 5\n- current: 0\n- unit: PRs");
  });

  it("rejects non-positive integer targets (silent skip would create a /-1 KPI)", async () => {
    await expectExit(1, () => runKpiCommand(["add", "g", "k", "0", "x"]));
    expect(allErr()).toContain("invalid target: 0");
    expect(queryMock).not.toHaveBeenCalled();

    await expectExit(1, () => runKpiCommand(["add", "g", "k", "-3", "x"]));
    expect(allErr()).toContain("invalid target: -3");

    await expectExit(1, () => runKpiCommand(["add", "g", "k", "abc", "x"]));
    expect(allErr()).toContain("invalid target: abc");
  });

  it("rejects missing args with the usage line", async () => {
    await expectExit(1, () => runKpiCommand(["add", "g", "k", "5"]));
    expect(allErr()).toContain("usage: hivemind kpi add");
    expect(queryMock).not.toHaveBeenCalled();
  });
});

// ── kpi list ────────────────────────────────────────────────────────────────

describe("runKpiCommand — list", () => {
  it("SELECTs by goal_id, prints kpi_id + first content line as TSV", async () => {
    queryMock.mockResolvedValueOnce([
      { kpi_id: "k1", content: "PRs shipped\n\n- target: 5" },
      { kpi_id: "k2", content: "Lines reviewed\n\n- target: 100" },
    ]);
    await runKpiCommand(["list", "g-uuid"]);
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain(`WHERE goal_id = 'g-uuid'`);
    expect(sql).toContain("ORDER BY created_at ASC LIMIT 50");
    expect(allOut()).toContain("k1\tPRs shipped\n");
    expect(allOut()).toContain("k2\tLines reviewed\n");
  });

  it("prints '(no kpis)' on empty result", async () => {
    queryMock.mockResolvedValueOnce([]);
    await runKpiCommand(["list", "g-uuid"]);
    expect(allOut()).toContain("(no kpis)");
  });

  it("exits 1 with usage when goal_id is missing", async () => {
    await expectExit(1, () => runKpiCommand(["list"]));
    expect(allErr()).toContain("usage: hivemind kpi list");
  });

  it("exits 1 with the API error message on query failure", async () => {
    queryMock.mockRejectedValueOnce(new Error("read timeout"));
    await expectExit(1, () => runKpiCommand(["list", "g-uuid"]));
    expect(allErr()).toContain("hivemind kpi list: read timeout");
  });
});

// ── kpi bump ────────────────────────────────────────────────────────────────

describe("runKpiCommand — bump", () => {
  it("reads current content, rewrites the `- current: N` line, then UPDATEs", async () => {
    queryMock
      .mockResolvedValueOnce([
        { content: "PRs shipped\n\n- target: 5\n- current: 2\n- unit: PRs" },
      ])
      // UPDATE — empty result
      .mockResolvedValueOnce([]);
    await runKpiCommand(["bump", "g-uuid", "k-prs", "1"]);
    expect(queryMock).toHaveBeenCalledTimes(2);
    const select = queryMock.mock.calls[0][0] as string;
    expect(select).toMatch(/^SELECT content FROM "hivemind_kpis_test"/);
    expect(select).toContain(`WHERE goal_id = 'g-uuid' AND kpi_id = 'k-prs'`);
    const update = queryMock.mock.calls[1][0] as string;
    expect(update).toMatch(/^UPDATE "hivemind_kpis_test"/);
    expect(update).toContain("- current: 3");
    // make sure we didn't mistakenly clobber target / unit
    expect(update).toContain("- target: 5");
    expect(update).toContain("- unit: PRs");
    expect(allOut()).toContain("g-uuid/k-prs +1");
  });

  it("handles negative deltas (bump -2 should decrement)", async () => {
    queryMock
      .mockResolvedValueOnce([{ content: "x\n\n- current: 10\n- unit: count" }])
      .mockResolvedValueOnce([]);
    await runKpiCommand(["bump", "g", "k", "-2"]);
    const update = queryMock.mock.calls[1][0] as string;
    expect(update).toContain("- current: 8");
  });

  it("exits 1 when the KPI row doesn't exist (no UPDATE issued)", async () => {
    queryMock.mockResolvedValueOnce([]); // SELECT returns nothing
    await expectExit(1, () => runKpiCommand(["bump", "g", "k", "1"]));
    expect(allErr()).toContain("kpi not found: g/k");
    // SELECT was issued once but no UPDATE
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("exits 1 when the content has no `current:` line (no UPDATE issued)", async () => {
    queryMock.mockResolvedValueOnce([
      { content: "PRs shipped\n\n- target: 5\n- unit: PRs" }, // missing `current:`
    ]);
    await expectExit(1, () => runKpiCommand(["bump", "g", "k", "1"]));
    expect(allErr()).toContain("could not find 'current:' line");
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("rejects non-numeric delta", async () => {
    await expectExit(1, () => runKpiCommand(["bump", "g", "k", "lots"]));
    expect(allErr()).toContain("invalid delta: lots");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("exits 1 with usage when args are missing", async () => {
    await expectExit(1, () => runKpiCommand(["bump", "g", "k"]));
    expect(allErr()).toContain("usage: hivemind kpi bump");
  });
});

// ── negative SQL patterns: UPDATE coalescing guard ──────────────────────────

describe("goal/kpi CLI — does NOT issue back-to-back UPDATEs on the same row", () => {
  // Backend coalesces two rapid UPDATEs against the same row, silently
  // dropping one (see CLAUDE.md "UPDATE coalescing" note). The CLI must
  // never split a single logical mutation into two UPDATEs.
  it("`goal done` issues at most one UPDATE", async () => {
    await runGoalCommand(["done", "abc"]);
    const updates = queryMock.mock.calls.filter(c => /^UPDATE\b/.test(c[0]));
    expect(updates).toHaveLength(1);
  });

  it("`kpi bump` issues one SELECT + one UPDATE — never a second UPDATE on a side column", async () => {
    queryMock
      .mockResolvedValueOnce([{ content: "x\n\n- current: 1\n- unit: y" }])
      .mockResolvedValueOnce([]);
    await runKpiCommand(["bump", "g", "k", "1"]);
    const updates = queryMock.mock.calls.filter(c => /^UPDATE\b/.test(c[0]));
    expect(updates).toHaveLength(1);
    // sanity: SELECT preceded UPDATE
    expect(/^SELECT/.test(queryMock.mock.calls[0][0])).toBe(true);
  });
});
