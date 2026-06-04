/**
 * Skill attribution for measurement: record, per session, which ORG-SHARED skills
 * were available in context at SessionStart, plus a deterministic A/B bucket.
 *
 * Why: skill value can only be validated by comparing sessions that had a skill vs
 * those that didn't (observational / randomized A/B). Today nothing records which
 * skills were in context — skill injection lives in the SessionStart system prompt,
 * not in captured turns — so attribution is impossible. This adds the missing label.
 *
 * Scope: ORG skills only. Pulled org skills land at `~/.claude/skills/<name>--<author>/`
 * (see pull.ts); local-only mined skills are bare-named and intentionally excluded —
 * a single-author local skill has no cross-user value to measure.
 *
 * Pure + side-effect-free here (disk read + SQL string build); the network INSERT is
 * done by the caller (session-start.ts) which already holds the gated DeeplakeApi.
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { sqlStr } from "../utils/sql.js";
import { loadManifest, type PulledManifest } from "./manifest.js";

export interface ActiveSkill {
  name: string;
  author: string;
  version: number;
}

/** Read `version:` from a SKILL.md frontmatter; defaults to 1 if absent/unreadable. */
function readSkillVersion(skillsRoot: string, dir: string): number {
  try {
    const body = fs.readFileSync(path.join(skillsRoot, dir, "SKILL.md"), "utf8");
    const m = body.match(/^version:\s*(\d+)/m);
    return m ? Number(m[1]) : 1;
  } catch {
    return 1;
  }
}

export function defaultSkillsRoot(): string {
  return path.join(homedir(), ".claude", "skills");
}

/**
 * List org-shared skills currently installed on disk under `skillsRoot`.
 *
 * Identity (name + author) comes from the pull manifest — the authoritative
 * record of what `skillify pull` installed from the org — NOT from splitting
 * the `<name>--<author>` directory name. That `--` pattern is a legitimate
 * naming style for local-only variant skills (e.g. `deploy--blue-green`), so
 * inferring "org skill" + a fabricated author from the dirname alone produces
 * false positives that would pollute every attribution row (the same reason
 * `unpull` consults the manifest instead of the dirname — see manifest.ts).
 *
 * Only directories present on disk AND recorded in the manifest are returned;
 * local-only dirs (manifest-absent) are excluded. The version is read from the
 * installed SKILL.md so v1-vs-v2 reflects what's actually in context.
 */
export function listActiveOrgSkills(
  skillsRoot: string = defaultSkillsRoot(),
  manifest: PulledManifest = loadManifest(),
): ActiveSkill[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  // dirName → authoritative {name, author} for every pull-managed entry.
  const pulled = new Map<string, { name: string; author: string }>();
  for (const e of manifest.entries) pulled.set(e.dirName, { name: e.name, author: e.author });

  const out: ActiveSkill[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const meta = pulled.get(e.name);
    if (!meta) continue; // not pull-managed (local-only / unrelated) → excluded
    out.push({
      name: meta.name,
      author: meta.author,
      version: readSkillVersion(skillsRoot, e.name), // installed version → enables v1-vs-v2
    });
  }
  // Sort by name, then author, so two org skills sharing a name (different
  // authors) serialize deterministically regardless of filesystem entry order.
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.author.localeCompare(b.author));
}

/** Deterministic, stateless per-session A/B bucket (FNV-1a over session_id). */
export function sessionBucket(sessionId: string, buckets = 2): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h | 0) % buckets;
}

/**
 * Path namespace for attribution rows. Deliberately NOT under `/sessions/` (cf.
 * buildSessionPath) so the summary / raw-transcript readers — which filter
 * `path LIKE '/sessions/%'` (see virtual-table-query.ts, deeplake-fs.ts) — never treat
 * an attribution row as transcript content. For an otherwise-empty session that would
 * make SessionEnd run the summarizer on only this JSON; for a normal session it would
 * pollute the transcript with the active-skill list. Measurement queries select by
 * message content (`type = "skills_active"`), not by path, so a distinct prefix is free.
 */
export function buildSkillsActivePath(
  config: { userName: string; orgName: string; workspaceId: string },
  sessionId: string,
): string {
  const workspace = config.workspaceId ?? "default";
  return `/skills_active/${config.userName}/${config.userName}_${config.orgName}_${workspace}_${sessionId}.json`;
}

export interface SkillsActiveInsertArgs {
  sessionsTable: string;
  sessionPath: string;
  filename: string;
  userName: string;
  projectName: string;
  pluginVersion: string;
  sessionId: string;
  cwd?: string;
  skills: ActiveSkill[];
  bucket: number;
  ts: string;
}

/**
 * Build the single INSERT for a `skills_active` attribution row. Mirrors capture.ts's
 * sessions-table insert exactly, with `message_embedding` NULL (no daemon round-trip at
 * SessionStart) and a distinct `message.type = "skills_active"`.
 */
export function buildSkillsActiveInsert(a: SkillsActiveInsertArgs): string {
  const entry = {
    id: crypto.randomUUID(),
    session_id: a.sessionId,
    cwd: a.cwd,
    hook_event_name: "SessionStart",
    timestamp: a.ts,
    type: "skills_active",
    skills: a.skills,
    skills_count: a.skills.length,
    ab_bucket: a.bucket,
  };
  const line = JSON.stringify(entry);
  const jsonForSql = line.replace(/'/g, "''");
  return (
    `INSERT INTO "${a.sessionsTable}" (id, path, filename, message, message_embedding, author, size_bytes, project, description, agent, plugin_version, creation_date, last_update_date) ` +
    `VALUES ('${crypto.randomUUID()}', '${sqlStr(a.sessionPath)}', '${sqlStr(a.filename)}', '${jsonForSql}'::jsonb, NULL, '${sqlStr(a.userName)}', ` +
    `${Buffer.byteLength(line, "utf-8")}, '${sqlStr(a.projectName)}', 'skills_active', 'claude_code', '${sqlStr(a.pluginVersion)}', '${a.ts}', '${a.ts}')`
  );
}
