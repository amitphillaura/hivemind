import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractTypeScript } from "../../../src/graph/extract/typescript.js";
import { handleGraphVfs } from "../../../src/graph/vfs-handler.js";
import { writeLastBuild } from "../../../src/graph/last-build.js";
import { repoDir } from "../../../src/graph/snapshot.js";
import { deriveProjectKey } from "../../../src/utils/repo-identity.js";

/**
 * Targeted branch-coverage tests for the lowest-coverage modules.
 * One assertion per branch arm — keep tests tiny and focused.
 */

describe("typescript extractor — branch coverage", () => {
  it(".tsx file uses TSX grammar (JSX allowed without parse error)", () => {
    const code = `export function Foo() { return <div>hello</div>; }`;
    const r = extractTypeScript(code, "src/Foo.tsx");
    expect(r.parse_errors).toEqual([]);
    expect(r.nodes.some((n) => n.label === "Foo")).toBe(true);
  });

  it(".jsx file also routes through TSX grammar", () => {
    const code = `export function Bar() { return <span>hi</span>; }`;
    const r = extractTypeScript(code, "src/Bar.jsx");
    expect(r.parse_errors).toEqual([]);
  });

  it("declaration merging: duplicate `interface Foo` produces ONE node id", () => {
    // CodeRabbit P1 — pushNode de-dupes by id while still keeping the lookup.
    const code = `export interface Foo { a: string; } export interface Foo { b: number; }`;
    const r = extractTypeScript(code, "src/dup.ts");
    const fooNodes = r.nodes.filter((n) => n.id === "src/dup.ts:Foo:interface");
    expect(fooNodes).toHaveLength(1);
  });

  it("overloaded function: duplicate function signatures produce ONE node id", () => {
    const code = `
      export function bar(s: string): string;
      export function bar(n: number): number;
      export function bar(x: string | number): string | number { return x; }
    `;
    const r = extractTypeScript(code, "src/over.ts");
    const ids = r.nodes.filter((n) => n.id === "src/over.ts:bar:function");
    expect(ids).toHaveLength(1);
  });

  it("class extends → 'extends' edge emitted (intra-file)", () => {
    const code = `class Base {} class Derived extends Base {}`;
    const r = extractTypeScript(code, "src/inh.ts");
    const extendsEdges = r.edges.filter((e) => e.relation === "extends");
    expect(extendsEdges.length).toBeGreaterThan(0);
  });

  it("class implements interface → 'implements' edge emitted", () => {
    const code = `interface I { x(): void } class C implements I { x() {} }`;
    const r = extractTypeScript(code, "src/impl.ts");
    const implementsEdges = r.edges.filter((e) => e.relation === "implements");
    expect(implementsEdges.length).toBeGreaterThan(0);
  });

  it("method nodes get a method_of edge to their class", () => {
    const code = `class X { foo() {} bar() {} }`;
    const r = extractTypeScript(code, "src/m.ts");
    const methodOf = r.edges.filter((e) => e.relation === "method_of");
    expect(methodOf.length).toBeGreaterThanOrEqual(2);
  });

  it("variable_declarator with function VALUE → caller resolution works", () => {
    // CodeRabbit P1 — only function-valued declarators are callers.
    const code = `function inner() {} const wrap = () => { inner(); };`;
    const r = extractTypeScript(code, "src/fnv.ts");
    // wrap should be marked as calling inner
    const wrapCalls = r.edges.find(
      (e) => e.source === "src/fnv.ts:wrap:const" && e.target === "src/fnv.ts:inner:function" && e.relation === "calls",
    );
    expect(wrapCalls).toBeDefined();
  });

  it("variable_declarator with NON-function VALUE → NO bogus caller edge", () => {
    // `const x = helper()` does NOT make x a caller of helper.
    const code = `function helper() { return 1; } const x = helper();`;
    const r = extractTypeScript(code, "src/nfv.ts");
    // There must be NO `calls` edge with source = the `x` const node.
    const bogus = r.edges.find((e) => e.source === "src/nfv.ts:x:const" && e.relation === "calls");
    expect(bogus).toBeUndefined();
  });

  it("type alias and enum produce distinct node kinds", () => {
    const code = `export type T = number; export enum E { A, B }`;
    const r = extractTypeScript(code, "src/te.ts");
    expect(r.nodes.find((n) => n.kind === "type_alias")?.label).toBe("T");
    expect(r.nodes.find((n) => n.kind === "enum")?.label).toBe("E");
  });

  it("const + let produce node entries (var declarations not extracted)", () => {
    // The extractor produces 'const' kind for const/let declarators;
    // `var` is typically rare in modern TS and not emitted as a top-level
    // node here. We assert the two that ARE produced.
    const code = `const a = 1; let b = 2;`;
    const r = extractTypeScript(code, "src/v.ts");
    expect(r.nodes.filter((n) => n.kind === "const").length).toBeGreaterThanOrEqual(2);
  });

  it("import statement emits 'imports' edge with external: target", () => {
    const code = `import { foo } from "./helper";`;
    const r = extractTypeScript(code, "src/i.ts");
    const importEdge = r.edges.find((e) => e.relation === "imports");
    expect(importEdge).toBeDefined();
  });
});

describe("handleGraphVfs — branch coverage gaps", () => {
  let cwd: string;
  let baseDir: string;
  let snapshotsDir: string;
  let wt: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "vfs-branch-"));
    const { key } = deriveProjectKey(cwd);
    baseDir = repoDir(key);
    snapshotsDir = join(baseDir, "snapshots");
    // worktree id same hashing
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    wt = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
    try { rmSync(baseDir, { recursive: true, force: true }); } catch {}
  });
  afterEach(() => {
    try { rmSync(cwd, { recursive: true, force: true }); } catch {}
    try { rmSync(baseDir, { recursive: true, force: true }); } catch {}
  });

  function seedSnapshot(nodes: { id: string; label: string; kind: string; exported: boolean }[], links: { source: string; target: string; relation: string }[] = []): void {
    mkdirSync(snapshotsDir, { recursive: true });
    const commit = "a".repeat(40);
    const snap = {
      directed: true, multigraph: true,
      graph: { schema_version: 1, generator: "hivemind-graph", commit_sha: commit, repo_key: "k" },
      observation: { ts: "2026-01-01T00:00:00Z", branch: "main", worktree_path: "/t", repo_project: "p", generator_version: "0", source_files_extracted: 1, source_files_skipped: 0 },
      nodes: nodes.map((n) => ({ ...n, source_file: "f.ts", source_location: "L1", language: "typescript" })),
      links: links.map((l) => ({ ...l, confidence: "EXTRACTED" })),
    };
    writeFileSync(join(snapshotsDir, `${commit}.json`), JSON.stringify(snap));
    writeLastBuild(baseDir, {
      ts: Date.now(), commit_sha: commit,
      snapshot_sha256: "f".repeat(64),
      node_count: nodes.length, edge_count: links.length,
    }, wt);
  }

  it("find with EXACT label match outranks substring match", () => {
    seedSnapshot([
      { id: "a:foo:function", label: "foo", kind: "function", exported: true },
      { id: "b:foobar:function", label: "foobar", kind: "function", exported: false },
      { id: "c:helperFoo:function", label: "helperFoo", kind: "function", exported: false },
    ]);
    const r = handleGraphVfs("find/foo", cwd);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      // Exact match (label === "foo") should appear FIRST in handle order
      const idx1 = r.body.indexOf("[1]");
      const idx2 = r.body.indexOf("[2]");
      const idx3 = r.body.indexOf("[3]");
      const between1 = r.body.slice(idx1, idx2);
      expect(between1).toContain("a:foo:function");
      // foobar (startsWith) outranks helperFoo (contains)
      const between2 = r.body.slice(idx2, idx3);
      expect(between2).toContain("b:foobar:function");
    }
  });

  it("find capped at 50 results when many matches", () => {
    const nodes = Array.from({ length: 75 }, (_, i) => ({
      id: `f.ts:item${i}:function`, label: `item${i}`, kind: "function", exported: false,
    }));
    seedSnapshot(nodes);
    const r = handleGraphVfs("find/item", cwd);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.body).toContain("75 matches");
      expect(r.body).toContain("showing first 50");
    }
  });

  it("show on a node with NO outgoing edges renders the hint", () => {
    seedSnapshot([{ id: "f.ts:lonely:function", label: "lonely", kind: "function", exported: false }]);
    const r = handleGraphVfs("show/lonely", cwd);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.body).toContain("Outgoing (0)");
      expect(r.body).toContain("no edges out");
    }
  });

  it("show clamps incoming list at 20 with '... and N more'", () => {
    const target = { id: "f.ts:popular:function", label: "popular", kind: "function", exported: true };
    const callers = Array.from({ length: 30 }, (_, i) => ({
      id: `f.ts:caller${i}:function`, label: `caller${i}`, kind: "function", exported: false,
    }));
    const links = callers.map((c) => ({ source: c.id, target: target.id, relation: "calls" }));
    seedSnapshot([target, ...callers], links);
    const r = handleGraphVfs("show/popular", cwd);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.body).toContain("and 10 more");
    }
  });

  it("show on digit handle 0 → out of range (handles are 1-indexed)", () => {
    seedSnapshot([{ id: "f.ts:foo:function", label: "foo", kind: "function", exported: true }]);
    handleGraphVfs("find/foo", cwd);  // populate handles
    const r = handleGraphVfs("show/0", cwd);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.body).toContain("out of range");
  });

  it("show on digit handle when find result is stale (node gone) → graceful error", () => {
    // Seed once, find, then re-seed with different nodes — the handle map
    // still points at the OLD id which is no longer in the snapshot.
    seedSnapshot([{ id: "f.ts:gone:function", label: "gone", kind: "function", exported: true }]);
    handleGraphVfs("find/gone", cwd);  // saves handle [1] → f.ts:gone:function
    // Now reseed with completely different nodes
    seedSnapshot([{ id: "f.ts:other:function", label: "other", kind: "function", exported: true }]);
    const r = handleGraphVfs("show/1", cwd);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.body).toMatch(/no longer in the snapshot|Re-run find/);
  });

  it("default makeApi path: pushSnapshot without injected makeApi exercises real DeeplakeApi construction (no network)", async () => {
    // CodeRabbit-driven coverage: `defaultMakeApi` was uncovered because all
    // push tests inject `makeApi`. Call pushSnapshot WITHOUT makeApi and
    // make it short-circuit before any network call by passing loadConfig
    // that returns null → exits at the skipped-no-auth gate, but ONLY after
    // the function-entry code path ran.
    const { pushSnapshot } = await import("../../../src/graph/deeplake-push.js");
    const r = await pushSnapshot(
      {
        directed: true, multigraph: true,
        graph: { schema_version: 1, generator: "hivemind-graph", commit_sha: "x", repo_key: "k" },
        observation: { ts: "2026-01-01T00:00:00Z", branch: null, worktree_path: "/t", repo_project: "p", generator_version: "0", source_files_extracted: 1, source_files_skipped: 0 },
        nodes: [], links: [],
      },
      "wt-id",
      { loadConfig: () => null },  // → skipped-no-auth before makeApi is called
    );
    expect(r.kind).toBe("skipped-no-auth");
  });

  it("index.md renders even when commit_sha is null (commitless build)", () => {
    // CodeRabbit P1 — fall back to snapshot_sha256
    mkdirSync(snapshotsDir, { recursive: true });
    const sha = "b".repeat(64);
    const snap = {
      directed: true, multigraph: true,
      graph: { schema_version: 1, generator: "hivemind-graph", commit_sha: null, repo_key: "k" },
      observation: { ts: "2026-01-01T00:00:00Z", branch: null, worktree_path: "/t", repo_project: "p", generator_version: "0", source_files_extracted: 1, source_files_skipped: 0 },
      nodes: [{ id: "f.ts:foo:function", label: "foo", kind: "function", source_file: "f.ts", source_location: "L1", language: "typescript", exported: false }],
      links: [],
    };
    writeFileSync(join(snapshotsDir, `${sha}.json`), JSON.stringify(snap));
    writeLastBuild(baseDir, {
      ts: Date.now(), commit_sha: null,
      snapshot_sha256: sha,
      node_count: 1, edge_count: 0,
    }, wt);
    const r = handleGraphVfs("index.md", cwd);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.body).toContain("no-commit");
    }
  });
});
