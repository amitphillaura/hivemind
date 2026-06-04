import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listActiveOrgSkills,
  sessionBucket,
  buildSkillsActiveInsert,
  buildSkillsActivePath,
} from "../../src/skillify/skills-active.js";
import type { PulledManifest } from "../../src/skillify/manifest.js";

/** Build a pull manifest from `(dirName, name, author)` triples (fills the rest with defaults). */
function manifestOf(...rows: Array<{ dirName: string; name: string; author: string }>): PulledManifest {
  return {
    version: 1,
    entries: rows.map(r => ({
      dirName: r.dirName,
      name: r.name,
      author: r.author,
      projectKey: "pk",
      remoteVersion: 1,
      install: "global" as const,
      installRoot: "/install/root",
      pulledAt: "2026-01-01T00:00:00.000Z",
      symlinks: [],
    })),
  };
}

describe("listActiveOrgSkills", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-active-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns only manifest-recorded (pull-managed) dirs; excludes local-only + files", () => {
    fs.mkdirSync(path.join(root, "posthog-event-smoke-testing--kamo.aghbalyan"));
    fs.mkdirSync(path.join(root, "pg-deeplake-test-crash-debugging--sasun"));
    fs.mkdirSync(path.join(root, "deploy--blue-green"));        // local-only `--` dir, NOT pulled — excluded
    fs.mkdirSync(path.join(root, "plan-confirm-then-execute")); // bare local — excluded
    fs.writeFileSync(path.join(root, "notes--x.txt"), "x");     // file, not dir — excluded
    const manifest = manifestOf(
      { dirName: "posthog-event-smoke-testing--kamo.aghbalyan", name: "posthog-event-smoke-testing", author: "kamo.aghbalyan" },
      { dirName: "pg-deeplake-test-crash-debugging--sasun", name: "pg-deeplake-test-crash-debugging", author: "sasun" },
    );

    const got = listActiveOrgSkills(root, manifest);
    expect(got).toEqual([
      { name: "pg-deeplake-test-crash-debugging", author: "sasun", version: 1 },
      { name: "posthog-event-smoke-testing", author: "kamo.aghbalyan", version: 1 },
    ]); // sorted by name; exactly the 2 manifest-recorded skills; version defaults to 1 (no SKILL.md)
    expect(got).toHaveLength(2); // local `deploy--blue-green` + bare + file all dropped
  });

  it("excludes a local-only dir whose name contains `--` when the manifest is empty (no false positive)", () => {
    fs.mkdirSync(path.join(root, "deploy--blue-green")); // org-shaped name, but never pulled
    expect(listActiveOrgSkills(root, manifestOf())).toEqual([]);
  });

  it("takes name/author from the manifest, not a dirname split (multi-`--` dir stays correct)", () => {
    fs.mkdirSync(path.join(root, "some--weird--dirname"));
    const manifest = manifestOf({ dirName: "some--weird--dirname", name: "some-skill", author: "first-last" });
    expect(listActiveOrgSkills(root, manifest)).toEqual([{ name: "some-skill", author: "first-last", version: 1 }]);
  });

  it("returns [] for a missing skills root (never throws)", () => {
    expect(listActiveOrgSkills(path.join(root, "does-not-exist"), manifestOf())).toEqual([]);
  });

  it("reads the skill version from the installed SKILL.md frontmatter (enables v1-vs-v2)", () => {
    fs.mkdirSync(path.join(root, "evolving-skill--sasun"));
    fs.writeFileSync(
      path.join(root, "evolving-skill--sasun", "SKILL.md"),
      "---\nname: evolving-skill\nversion: 5\n---\nbody",
    );
    const manifest = manifestOf({ dirName: "evolving-skill--sasun", name: "evolving-skill", author: "sasun" });
    expect(listActiveOrgSkills(root, manifest)).toEqual([{ name: "evolving-skill", author: "sasun", version: 5 }]);
  });
});

describe("sessionBucket", () => {
  it("is deterministic for the same session id", () => {
    expect(sessionBucket("abc-123")).toBe(sessionBucket("abc-123"));
  });
  it("stays within [0, buckets)", () => {
    for (const id of ["a", "b", "c", "xyz", "1874a6b2"]) {
      const b = sessionBucket(id, 2);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(2);
    }
  });
  it("assigns both buckets across many ids (not constant)", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(sessionBucket(`session-${i}`));
    expect(seen).toEqual(new Set([0, 1])); // both arms populated → real randomization
  });
});

describe("buildSkillsActivePath", () => {
  const config = { userName: "kamo", orgName: "activeloop", workspaceId: "default" };

  it("namespaces under /skills_active/, NOT /sessions/ (so summary readers exclude it)", () => {
    const p = buildSkillsActivePath(config, "S1");
    expect(p.startsWith("/skills_active/")).toBe(true);
    expect(p.startsWith("/sessions/")).toBe(false);
    // The exact filter the summary / raw-transcript readers use must NOT match this path.
    expect(p.includes("/sessions/")).toBe(false);
  });

  it("embeds the full {user, org, workspace, session} tuple", () => {
    expect(buildSkillsActivePath(config, "S1")).toBe(
      "/skills_active/kamo/kamo_activeloop_default_S1.json",
    );
  });

  it("falls back to `default` workspace when workspaceId is absent", () => {
    // covers the `?? \"default\"` branch (mirrors buildSessionPath)
    const p = buildSkillsActivePath(
      { userName: "kamo", orgName: "activeloop", workspaceId: undefined as unknown as string },
      "S1",
    );
    expect(p).toBe("/skills_active/kamo/kamo_activeloop_default_S1.json");
  });
});

describe("buildSkillsActiveInsert", () => {
  const base = {
    sessionsTable: "sessions",
    sessionPath: "/sessions/kamo/kamo_activeloop_hivemind_S1.jsonl",
    filename: "kamo_activeloop_hivemind_S1.jsonl",
    userName: "kamo",
    projectName: "hivemind",
    pluginVersion: "0.7.99",
    sessionId: "S1",
    cwd: "/home/kamo/proj",
    skills: [{ name: "pg-deeplake-test-crash-debugging", author: "sasun", version: 3 }],
    bucket: 1,
    ts: "2026-06-03T00:00:00.000Z",
  };

  it("emits exactly ONE insert into the sessions table (no second mutation)", () => {
    const sql = buildSkillsActiveInsert(base);
    expect((sql.match(/INSERT INTO/g) ?? []).length).toBe(1);
    expect((sql.match(/UPDATE /g) ?? []).length).toBe(0);
    expect(sql).toContain('INSERT INTO "sessions"');
  });

  it("writes a skills_active message with the skills, count, and bucket", () => {
    const sql = buildSkillsActiveInsert(base);
    const m = sql.match(/'(\{.*\})'::jsonb/s);
    expect(m).toBeTruthy();
    const entry = JSON.parse(m![1]);
    expect(entry.type).toBe("skills_active");
    expect(entry.session_id).toBe("S1");
    expect(entry.skills).toEqual([{ name: "pg-deeplake-test-crash-debugging", author: "sasun", version: 3 }]);
    expect(entry.skills_count).toBe(1);
    expect(entry.ab_bucket).toBe(1);
  });

  it("leaves message_embedding NULL (no daemon round-trip at SessionStart)", () => {
    const sql = buildSkillsActiveInsert(base);
    expect(sql).toMatch(/::jsonb,\s*NULL,/);
  });

  it("does NOT masquerade as a captured turn type", () => {
    const sql = buildSkillsActiveInsert(base);
    expect(sql).not.toContain('"type":"user_message"');
    expect(sql).not.toContain('"type":"tool_call"');
    expect(sql).not.toContain('"type":"assistant_message"');
  });
});
