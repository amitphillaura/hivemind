import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CLI handler tests for `hivemind context`. Mocks config + DeeplakeApi
 * at the network boundary. The renderer is independently tested in
 * tests/shared/context-renderer.test.ts; here we just verify the CLI
 * shape (login gating, output channel, empty-state behaviour).
 */

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
    query(sql: string) { return queryMock(sql); }
  },
}));

import { runContextCommand } from "../../src/commands/context.js";
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
  tasksTableName: "hivemind_tasks",
  taskEventsTableName: "hivemind_task_events",
  memoryPath: "/tmp/mem",
};

let logged: string[] = [];
let erred: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logged = [];
  erred = [];
  queryMock.mockReset().mockResolvedValue([]);
  loadConfigMock.mockReset().mockReturnValue(VALID_CONFIG);
  logSpy = vi.spyOn(console, "log").mockImplementation((...a: any[]) => { logged.push(a.join(" ")); });
  errSpy = vi.spyOn(console, "error").mockImplementation((...a: any[]) => { erred.push(a.join(" ")); });
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`__EXIT_${code ?? 0}__`);
  }) as any);
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
});

function expectExit(code: number, fn: () => unknown): Promise<void> {
  return expect(fn).rejects.toThrow(new RegExp(`__EXIT_${code}__`));
}

// ── help ────────────────────────────────────────────────────────────────────

describe("runContextCommand — help", () => {
  it("prints usage on --help", async () => {
    await runContextCommand(["--help"]);
    expect(logged.some(l => l.includes("hivemind context"))).toBe(true);
    expect(logged.some(l => l.includes("SessionStart"))).toBe(true);
    // No query when only printing usage.
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("prints usage on -h / help alias", async () => {
    await runContextCommand(["-h"]);
    expect(logged.some(l => l.includes("hivemind context"))).toBe(true);
    logged.length = 0;
    await runContextCommand(["help"]);
    expect(logged.some(l => l.includes("hivemind context"))).toBe(true);
  });
});

// ── login gating ────────────────────────────────────────────────────────────

describe("runContextCommand — requires login", () => {
  it("exits 2 with a clear message when loadConfig returns null", async () => {
    loadConfigMock.mockReturnValueOnce(null);
    await expectExit(2, () => runContextCommand([]));
    expect(erred.some(l => l.includes("Not logged in"))).toBe(true);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

// ── output ──────────────────────────────────────────────────────────────────

describe("runContextCommand — output", () => {
  it("prints the rendered block to stdout when there's something to show", async () => {
    // Renderer queries: listRules, listTasks team, listTasks mine,
    // computeAllForTasks (skipped if no tasks).
    queryMock.mockResolvedValueOnce([{
      id: "row-1", rule_id: "rule-1", text: "no DROP TABLE on prod",
      scope: "team", status: "active", assigned_by: "alice@activeloop.ai",
      version: 1, created_at: "2026-05-20T10:00:00Z",
      agent: "manual", plugin_version: "0.7.99",
    }]);
    queryMock.mockResolvedValueOnce([]);   // team tasks empty
    queryMock.mockResolvedValueOnce([]);   // mine tasks empty
    await runContextCommand([]);
    expect(logged.some(l => l.includes("HIVEMIND RULES"))).toBe(true);
    expect(logged.some(l => l.includes("no DROP TABLE on prod"))).toBe(true);
    // 3 SELECTs total (rules + team + mine; events skipped because tasks empty).
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  it("empty state: prints diagnostic to STDERR (stdout stays empty so callers can pipe cleanly)", async () => {
    // All three reads return [] → renderer returns "" → CLI prints
    // diagnostic to stderr, NOTHING to stdout. A caller doing
    // `hivemind context | otherTool` gets empty stdin (the documented
    // signal that there's nothing to inject).
    queryMock.mockResolvedValueOnce([]);
    queryMock.mockResolvedValueOnce([]);
    queryMock.mockResolvedValueOnce([]);
    await runContextCommand([]);
    expect(logged).toEqual([]);
    expect(erred.some(l => l.includes("(no active rules or visible tasks)"))).toBe(true);
  });

  it("uses the configured table names from cfg (not hardcoded)", async () => {
    loadConfigMock.mockReturnValueOnce({
      ...VALID_CONFIG,
      rulesTableName: "rules_test",
      tasksTableName: "tasks_test",
      taskEventsTableName: "events_test",
    });
    queryMock.mockResolvedValueOnce([]);
    queryMock.mockResolvedValueOnce([]);
    queryMock.mockResolvedValueOnce([]);
    await runContextCommand([]);
    // First query should target the configured rules table.
    expect(queryMock.mock.calls[0][0]).toContain(`FROM "rules_test"`);
    expect(queryMock.mock.calls[1][0]).toContain(`FROM "tasks_test"`);
    expect(queryMock.mock.calls[2][0]).toContain(`FROM "tasks_test"`);
  });
});
