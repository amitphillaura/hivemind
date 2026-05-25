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
  goalsTableName: "hivemind_goals",
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
    // Renderer queries: listRules + listOpenGoals (two SELECTs).
    queryMock.mockResolvedValueOnce([{
      id: "row-1", rule_id: "rule-1", text: "no DROP TABLE on prod",
      scope: "team", status: "active", assigned_by: "alice@activeloop.ai",
      version: 1, created_at: "2026-05-20T10:00:00Z",
      agent: "manual", plugin_version: "0.7.99",
    }]);
    queryMock.mockResolvedValueOnce([]); // goals empty
    await runContextCommand([]);
    expect(logged.some(l => l.includes("HIVEMIND RULES"))).toBe(true);
    expect(logged.some(l => l.includes("no DROP TABLE on prod"))).toBe(true);
    // 2 SELECTs (rules + goals).
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("renders goals when present", async () => {
    queryMock.mockResolvedValueOnce([]); // rules empty
    queryMock.mockResolvedValueOnce([{
      goal_id: "g-1",
      // Owner must match VALID_CONFIG.userName ("alice@activeloop.ai")
      // via the canonical-forms guard in listOpenGoals — full / short /
      // short@%-prefix. Full email here is the exact-match form.
      owner: "alice@activeloop.ai",
      status: "in_progress",
      content: "ship the search bar",
    }]);
    await runContextCommand([]);
    expect(logged.some(l => l.includes("HIVEMIND GOALS"))).toBe(true);
    expect(logged.some(l => l.includes("ship the search bar"))).toBe(true);
  });

  it("empty state: prints diagnostic to STDERR (stdout stays empty so callers can pipe cleanly)", async () => {
    // Both rules + goals return [] → renderer returns "" → CLI prints
    // diagnostic to stderr, NOTHING to stdout. A caller doing
    // `hivemind context | otherTool` gets empty stdin (the documented
    // "nothing to inject" signal).
    queryMock.mockResolvedValueOnce([]);
    queryMock.mockResolvedValueOnce([]);
    await runContextCommand([]);
    expect(logged).toEqual([]);
    expect(erred.some(l => l.includes("(no active rules or open goals)"))).toBe(true);
  });

  it("uses the configured table names from cfg (not hardcoded)", async () => {
    loadConfigMock.mockReturnValueOnce({
      ...VALID_CONFIG,
      rulesTableName: "rules_test",
      goalsTableName: "goals_test",
    });
    queryMock.mockResolvedValueOnce([]);
    queryMock.mockResolvedValueOnce([]);
    await runContextCommand([]);
    expect(queryMock.mock.calls[0][0]).toContain(`FROM "rules_test"`);
    expect(queryMock.mock.calls[1][0]).toContain(`FROM "goals_test"`);
  });
});
