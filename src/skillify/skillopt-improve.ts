/**
 * #4 (redesigned) — the TARGETED core: judge ONE skill against the user's reaction
 * and improve it immediately if it failed. No anchor, no counter, no org-wide sweep.
 *
 * Flow: an org skill X was invoked → the user reacted → judge X's window (the LLM is
 * the only evaluator now — a regex can't catch "you fucked up again") with the
 * just-submitted reaction appended (it lags Deeplake, so it's passed in straight from
 * the hook). If the judge says the task FAILED, read X's current body, propose a
 * bounded edit, and publish v+1 — right then. The meta-dedup stops re-publishing the
 * same edit when the next reaction re-judges the same window.
 *
 * Everything is injected (query, judge/proposer models, meta) so this is unit-tested
 * with no Deeplake / LLM.
 */
import { sqlStr, sqlIdent } from "../utils/sql.js";
import {
  parseMessage, invokedSkillRef, splitOrgSkill, windowAroundInvocation,
  type QueryFn, type SkillInvocation,
} from "./skill-invocations.js";
import { judgeSuccess } from "./success-judge.js";
import { proposeSkillEdit } from "./skill-proposer.js";
import { readCurrentSkillRow, publishImprovedSkill } from "./skill-org-publish.js";
import type { ModelCall } from "./agent-model.js";
import type { Edit } from "./skill-edits.js";

function likeEscape(s: string): string {
  return s.replace(/([\\%_])/g, "\\$1");
}

/** The LATEST invocation of `name--author` in a session (so the window targets the
 *  invocation the user is reacting to), or null if it isn't in the session. */
export async function findLatestInvocation(
  query: QueryFn, sessionsTable: string, sessionId: string, name: string, author: string,
): Promise<SkillInvocation | null> {
  const sid = sqlStr(likeEscape(sessionId));
  const rows = await query(
    `SELECT message FROM "${sqlIdent(sessionsTable)}" WHERE path LIKE '/sessions/%${sid}%' ESCAPE '\\' ORDER BY creation_date ASC`,
  );
  let found: SkillInvocation | null = null;
  for (const r of rows) {
    const m = parseMessage(r.message);
    if (!m) continue;
    if (typeof m.session_id === "string" && m.session_id !== sessionId) continue;
    const ref = invokedSkillRef(m);
    if (!ref) continue;
    const p = splitOrgSkill(ref);
    if (!p || p.name !== name || p.author !== author) continue;
    found = { sessionId, name, author, ts: typeof m.timestamp === "string" ? m.timestamp : "" }; // keep last → latest
  }
  return found;
}

export interface ImproveResult {
  judged: boolean;   // did we locate the invocation and run the judge?
  failed: boolean;   // judge verdict: task failed (success === 0)
  improved: boolean; // a new version was published
  version?: number;
  reason: string;
}

export interface ImproveOpts {
  query: QueryFn;
  sessionsTable: string;
  skillsTable: string;
  workspaceId: string;
  sessionId: string;
  skillRef: string;  // "name--author"
  reaction: string;  // the user's just-submitted prompt (the reaction)
  judge: ModelCall;
  proposerModel: ModelCall;
  collaborator?: string;
  now: string;
  prior?: (name: string, author: string) => string[];
  alreadyProposed?: (name: string, author: string, edits: Edit[]) => boolean;
  recordEdit?: (name: string, author: string, edits: Edit[]) => void;
}

export async function improveSkillIfFailed(opts: ImproveOpts): Promise<ImproveResult> {
  const none = (reason: string): ImproveResult => ({ judged: false, failed: false, improved: false, reason });
  const parts = splitOrgSkill(opts.skillRef);
  if (!parts) return none("not an org skill");

  const inv = await findLatestInvocation(opts.query, opts.sessionsTable, opts.sessionId, parts.name, parts.author);
  if (!inv) return none("invocation not found in session");

  let window = await windowAroundInvocation(opts.query, opts.sessionsTable, inv);
  // The reaction is the freshest turn (lags Deeplake), so append it from the hook payload.
  if (opts.reaction?.trim()) window += `\n\nUSER: ${opts.reaction.trim()}`;

  const verdict = await judgeSuccess(window, { model: opts.judge });
  if (verdict.success !== 0) return { judged: true, failed: false, improved: false, reason: verdict.reason };

  // Failed → improve the specific skill, right now.
  const current = await readCurrentSkillRow(opts.query, opts.skillsTable, parts.name, parts.author);
  if (!current) return { judged: true, failed: true, improved: false, reason: "skill not in org table" };

  const priorEdits = opts.prior?.(parts.name, parts.author) ?? [];
  const p = await proposeSkillEdit(current.body, [verdict.reason], { model: opts.proposerModel, priorEdits });
  if (!p.changed) return { judged: true, failed: true, improved: false, reason: "proposer made no change" };
  if (opts.alreadyProposed?.(parts.name, parts.author, p.edits)) {
    return { judged: true, failed: true, improved: false, reason: "edit already proposed (dedup)" };
  }

  const { version } = await publishImprovedSkill({
    query: opts.query, tableName: opts.skillsTable, workspaceId: opts.workspaceId,
    current, newBody: p.editedBody, collaborator: opts.collaborator, now: opts.now,
  });
  opts.recordEdit?.(parts.name, parts.author, p.edits);
  return { judged: true, failed: true, improved: true, version, reason: verdict.reason };
}
