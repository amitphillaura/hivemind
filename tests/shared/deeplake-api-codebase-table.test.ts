import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeeplakeApi } from "../../src/deeplake-api.js";
import { CODEBASE_COLUMNS } from "../../src/deeplake-schema.js";

/**
 * Branch-focused tests for `ensureCodebaseTable` — the codebase-graph PR's
 * new method on DeeplakeApi. Covers each decision point in the
 * bootstrap → heal → index sequence:
 *
 *   1. Table NOT in listTables  → CREATE TABLE runs, then heal + index.
 *   2. Table IS  in listTables  → no CREATE TABLE, but heal + index still run.
 *   3. healSchema sees a missing column → ALTER TABLE ADD COLUMN runs.
 *   4. healSchema sees all columns present → no ALTER.
 *   5. Multiple missing columns → one ALTER per missing column.
 *   6. ensureLookupIndex targets the 6-key identity composite.
 *
 * Mock at the network boundary (fetch) — same pattern as
 * tests/shared/deeplake-api.test.ts. Every call (GET /tables for listTables,
 * POST /tables/query for SQL) is captured; assertions count + shape-match.
 *
 * Wire shapes (confirmed by reading src/deeplake-api.ts):
 *   - listTables  → GET  ${apiUrl}/workspaces/${ws}/tables
 *                  response: { tables: [{ table_name: string }] }
 *   - SQL query   → POST ${apiUrl}/workspaces/${ws}/tables/query
 *                  body:     { query: string }
 *                  response: { columns: string[], rows: unknown[][] } | null
 */

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

let markerDir: string;

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function tablesListResponse(tables: string[]): ReturnType<typeof jsonResponse> {
  return jsonResponse({ tables: tables.map((t) => ({ table_name: t })) });
}

function rowsResponse(columns: string[], rows: unknown[][]): ReturnType<typeof jsonResponse> {
  return jsonResponse({ columns, rows });
}

function infoSchemaRows(columnNames: string[]): ReturnType<typeof jsonResponse> {
  return rowsResponse(
    ["column_name"],
    columnNames.map((c) => [c]),
  );
}

function emptyOk(): ReturnType<typeof jsonResponse> {
  return jsonResponse({ rows: [], columns: [] });
}

function makeApi(table = "memory") {
  return new DeeplakeApi("tok", "https://api.test", "org1", "ws1", table);
}

/**
 * Capture every SQL string that was POSTed to /tables/query. Only the
 * POST calls have a body — listTables is a GET. Order is preserved.
 */
function capturedSql(): string[] {
  return mockFetch.mock.calls
    .filter((call) => {
      const opts = call[1] as { method?: string; body?: string } | undefined;
      return opts?.method === "POST" && typeof opts.body === "string";
    })
    .map((call) => {
      const body = (call[1] as { body: string }).body;
      return (JSON.parse(body) as { query: string }).query;
    });
}

beforeEach(() => {
  mockFetch.mockReset();
  // Fresh marker dir per test so ensureLookupIndex always runs (no stale fresh marker).
  markerDir = mkdtempSync(join(tmpdir(), "hivemind-codebase-marker-"));
  process.env.HIVEMIND_INDEX_MARKER_DIR = markerDir;
});

afterEach(() => {
  delete process.env.HIVEMIND_INDEX_MARKER_DIR;
  rmSync(markerDir, { recursive: true, force: true });
});

describe("ensureCodebaseTable — create branch", () => {
  it("table NOT in listTables → CREATE TABLE runs, then heal + index", async () => {
    mockFetch
      .mockResolvedValueOnce(tablesListResponse(["memory", "sessions"]))     // listTables: no codebase
      .mockResolvedValueOnce(emptyOk())                                       // createTableWithRetry
      .mockResolvedValueOnce(infoSchemaRows(CODEBASE_COLUMNS.map((c) => c.name)))  // healSchema: all cols present
      .mockResolvedValueOnce(emptyOk());                                      // ensureLookupIndex: CREATE INDEX

    const api = makeApi();
    await api.ensureCodebaseTable("codebase");

    const sql = capturedSql();
    const create = sql.find((s) => /CREATE TABLE IF NOT EXISTS/i.test(s) && s.includes('"codebase"'));
    expect(create).toBeDefined();
    // CREATE TABLE wires the codebase schema (identity + payload columns)
    expect(create).toContain("org_id");
    expect(create).toContain("commit_sha");
    expect(create).toContain("snapshot_sha256");
    expect(create).toContain("USING deeplake");

    // information_schema lookup uses the right table_name + workspace
    expect(sql.some((s) => s.includes("information_schema.columns") && s.includes("'codebase'") && s.includes("'ws1'"))).toBe(true);

    // CREATE INDEX targets the 6-key composite
    const idx = sql.find((s) => /CREATE INDEX/i.test(s));
    expect(idx).toBeDefined();
    expect(idx).toContain('"org_id"');
    expect(idx).toContain('"worktree_id"');
    expect(idx).toContain('"commit_sha"');
  });
});

describe("ensureCodebaseTable — already-exists branch", () => {
  it("table IS in listTables → no CREATE TABLE, only heal + index", async () => {
    mockFetch
      .mockResolvedValueOnce(tablesListResponse(["memory", "codebase"]))     // listTables: codebase present
      .mockResolvedValueOnce(infoSchemaRows(CODEBASE_COLUMNS.map((c) => c.name)))  // healSchema: all present
      .mockResolvedValueOnce(emptyOk());                                      // ensureLookupIndex

    const api = makeApi();
    await api.ensureCodebaseTable("codebase");

    const sql = capturedSql();
    expect(sql.find((s) => /CREATE TABLE/i.test(s))).toBeUndefined();
    expect(sql.some((s) => s.includes("information_schema.columns"))).toBe(true);
    expect(sql.some((s) => /CREATE INDEX/i.test(s))).toBe(true);
  });
});

describe("ensureCodebaseTable — heal branch", () => {
  it("missing column → ALTER TABLE ADD COLUMN runs for the missing one", async () => {
    const present = CODEBASE_COLUMNS.filter((c) => c.name !== "snapshot_sha256").map((c) => c.name);
    mockFetch
      .mockResolvedValueOnce(tablesListResponse(["codebase"]))   // table exists
      .mockResolvedValueOnce(infoSchemaRows(present))             // missing 1 col
      .mockResolvedValueOnce(emptyOk())                           // ALTER
      .mockResolvedValueOnce(emptyOk());                          // CREATE INDEX

    const api = makeApi();
    await api.ensureCodebaseTable("codebase");

    const sql = capturedSql();
    const alters = sql.filter((s) => /ALTER TABLE/i.test(s));
    expect(alters).toHaveLength(1);
    expect(alters[0]).toContain("snapshot_sha256");
    expect(alters[0]).toContain("ADD COLUMN");
  });

  it("all columns present → zero ALTER statements", async () => {
    mockFetch
      .mockResolvedValueOnce(tablesListResponse(["codebase"]))
      .mockResolvedValueOnce(infoSchemaRows(CODEBASE_COLUMNS.map((c) => c.name)))
      .mockResolvedValueOnce(emptyOk());

    const api = makeApi();
    await api.ensureCodebaseTable("codebase");

    const sql = capturedSql();
    expect(sql.find((s) => /ALTER TABLE/i.test(s))).toBeUndefined();
  });

  it("multiple missing columns → one ALTER per missing column", async () => {
    const dropped = ["snapshot_sha256", "node_count", "edge_count"];
    const present = CODEBASE_COLUMNS.filter((c) => !dropped.includes(c.name)).map((c) => c.name);
    mockFetch
      .mockResolvedValueOnce(tablesListResponse(["codebase"]))
      .mockResolvedValueOnce(infoSchemaRows(present))
      .mockResolvedValueOnce(emptyOk())  // ALTER 1
      .mockResolvedValueOnce(emptyOk())  // ALTER 2
      .mockResolvedValueOnce(emptyOk())  // ALTER 3
      .mockResolvedValueOnce(emptyOk()); // CREATE INDEX

    const api = makeApi();
    await api.ensureCodebaseTable("codebase");

    const sql = capturedSql();
    const alters = sql.filter((s) => /ALTER TABLE/i.test(s));
    expect(alters).toHaveLength(3);
    for (const col of dropped) {
      expect(alters.some((a) => a.includes(col))).toBe(true);
    }
  });
});

describe("ensureCodebaseTable — index branch", () => {
  it("CREATE INDEX targets the 6-key identity (org, ws, repo_slug, user, worktree, commit)", async () => {
    mockFetch
      .mockResolvedValueOnce(tablesListResponse(["codebase"]))
      .mockResolvedValueOnce(infoSchemaRows(CODEBASE_COLUMNS.map((c) => c.name)))
      .mockResolvedValueOnce(emptyOk());

    const api = makeApi();
    await api.ensureCodebaseTable("codebase");

    const sql = capturedSql();
    const idx = sql.find((s) => /CREATE INDEX/i.test(s));
    expect(idx).toBeDefined();
    for (const col of ["org_id", "workspace_id", "repo_slug", "user_id", "worktree_id", "commit_sha"]) {
      expect(idx).toContain(`"${col}"`);
    }
    // Index name shape: idx_<table>_codebase_identity
    expect(idx).toMatch(/idx_codebase_codebase_identity/);
  });
});

describe("ensureCodebaseTable — table-name escaping", () => {
  it("non-default table name flows through sqlIdent + sqlStr", async () => {
    mockFetch
      .mockResolvedValueOnce(tablesListResponse([]))                                  // missing
      .mockResolvedValueOnce(emptyOk())                                                // CREATE
      .mockResolvedValueOnce(infoSchemaRows(CODEBASE_COLUMNS.map((c) => c.name)))      // heal: all cols
      .mockResolvedValueOnce(emptyOk());                                               // INDEX

    const api = makeApi();
    await api.ensureCodebaseTable("codebase_test");

    const sql = capturedSql();
    expect(sql.some((s) => /CREATE TABLE/i.test(s) && s.includes('"codebase_test"'))).toBe(true);
    expect(sql.some((s) => s.includes("'codebase_test'"))).toBe(true);           // info_schema literal
    expect(sql.some((s) => /CREATE INDEX/i.test(s) && s.includes('"codebase_test"'))).toBe(true);
  });
});
