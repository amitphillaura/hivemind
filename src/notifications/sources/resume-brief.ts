/**
 * Resume brief — the signed-in payoff that the first-run signup brief
 * promises. Where cold-start-brief.ts fires ONCE for anonymous users off
 * local jsonl, this fires every session for a logged-in user and answers
 * "where did I leave off?" from their captured Hivemind summaries.
 *
 * It is the gated half of the pair: it only ever runs when creds are
 * present (the caller passes null-or-creds), so the "sign in and future
 * sessions start with what you've learned" promise is literally what this
 * delivers. No creds → this never runs → no payoff. That IS the gate.
 *
 * Source: the `memory` table (one row per session summary, written by the
 * wiki worker). We take the most recent summary for the CURRENT project
 * authored by the current user, and surface its first meaningful line as
 * the resume pointer.
 *
 * High-precision-or-silent: returns null when there's no prior summary for
 * this project (e.g. the user's genuine first signed-in session, or they're
 * in a fresh repo). The caller falls back to the plain welcome — never a
 * broken "where you left off" with nothing behind it.
 *
 * Failure mode: any error (network/auth/missing table) returns null. The
 * banner renders as a normal welcome; the SessionStart hook is unaffected.
 */

import type { Credentials } from "../../commands/auth-creds.js";
import { DeeplakeApi } from "../../deeplake-api.js";
import { loadConfig } from "../../config.js";
import { sqlStr, sqlIdent } from "../../utils/sql.js";
import { projectNameFromCwd } from "../../utils/project-name.js";
import { log as _log } from "../../utils/debug.js";

const log = (m: string) => _log("notifications-resume-brief", m);

/** Max length of the surfaced "left off" line — one terminal row at typical
 *  widths. Long summary headers get cut at a word boundary with an ellipsis. */
const MAX_LINE_CHARS = 120;

/** Hard cap on the summary lookup. DeeplakeApi.query retries ~3.5s on an
 *  unreachable endpoint; the SessionStart hook budget is 5s and fetchOrgStats
 *  already spends up to 1.5s before us. Race the query against this so a slow
 *  or down backend degrades to a plain welcome instead of stalling the hook. */
const QUERY_TIMEOUT_MS = 1_500;

/** Resolve to `fallback` if `p` hasn't settled within `ms`. The timer is
 *  unref'd so a pending query can't keep the process alive past the hook. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    if (typeof t.unref === "function") t.unref();
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(fallback); },
    );
  });
}

export interface ResumeBrief {
  brief: string;
}

/** The first substantive prose sentence of a summary.
 *
 * Wiki summaries open with boilerplate that is useless as a resume pointer:
 * a `# Session <uuid>` title, a `- **Started/Ended/Project**:` metadata
 * block, and `## Section` headers — and the template varies across plugin
 * versions (only ~20% use a `## What Happened` header), so we can't key on
 * one section name. Instead we skip every non-prose line — headings,
 * bullets, and `**Label**` lines (the People/Entities sections) — and return
 * the first real sentence of the first prose paragraph (the "what happened"
 * narrative). Returns "" when nothing qualifies.
 *
 * Sentence cut requires whitespace/end after the `.!?` so mid-token dots
 * (`module.json`, `v0.6.25`) don't truncate the sentence early. */
export function firstProseSentence(summary: string): string {
  for (const raw of summary.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;                  // # title / ## section
    if (line.startsWith("-") || line.startsWith("*")) continue; // bullets / metadata
    if (line.startsWith("**")) continue;                 // **Label** — value rows
    const m = line.match(/^.*?[.!?](\s|$)/);
    return (m ? m[0] : line).trim();
  }
  return "";
}

function truncate(s: string, max = MAX_LINE_CHARS): string {
  const clean = s.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > max / 2 ? slice.slice(0, lastSpace) : slice;
  return cut.trimEnd() + "…";
}

/** "3 days ago" / "yesterday" / "earlier today" from an ISO-ish timestamp.
 *  Returns "" when the timestamp is missing/unparseable so the caller can
 *  drop the clause rather than render "(Invalid Date)". */
function relativeAge(iso: string | undefined): string {
  if (!iso) return "";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return "earlier today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  return `${Math.floor(days / 7)} weeks ago`;
}

/**
 * Build the resume brief for a signed-in user, or null when there's
 * nothing to resume. Only called with non-null creds — the creds gate
 * lives in the caller (primary-banner), which routes anonymous users to
 * the signup brief instead.
 */
export async function pickResumeBrief(
  creds: Credentials | null | undefined,
): Promise<ResumeBrief | null> {
  if (!creds?.token || !creds.userName || !creds.orgId) return null;

  const project = projectNameFromCwd(process.cwd());
  if (!project) return null;

  try {
    const cfg = loadConfig();
    // sqlIdent throws on anything outside [A-Za-z_][A-Za-z0-9_]*. The table
    // name comes from HIVEMIND_TABLE (loadConfig) and is interpolated into
    // FROM "${table}" below — sqlStr only escapes string LITERALS, not
    // identifiers, so a name containing a double-quote could break out of
    // the quoted identifier. Validate it; on a bad value, log and bail to a
    // plain welcome rather than run an attacker-shaped query.
    let table: string;
    try {
      table = sqlIdent(cfg?.tableName ?? "memory");
    } catch (e: unknown) {
      log(`invalid table identifier "${cfg?.tableName}": ${(e as Error).message}`);
      return null;
    }
    const api = new DeeplakeApi(
      creds.token,
      creds.apiUrl ?? "https://api.deeplake.ai",
      creds.orgId,
      creds.workspaceId ?? "default",
      table,
    );

    // Most recent summary for THIS project by THIS user. summary != ''
    // skips placeholder rows; ORDER BY last_update_date DESC takes the
    // latest. LIMIT 1 — we only need the one resume pointer.
    const rows = await withTimeout(
      api.query(
        `SELECT summary, project, last_update_date FROM "${table}" ` +
          `WHERE project = '${sqlStr(project)}' AND author = '${sqlStr(creds.userName)}' ` +
          `AND summary <> '' ORDER BY last_update_date DESC LIMIT 1`,
      ),
      QUERY_TIMEOUT_MS,
      null,
    );
    if (!rows || rows.length === 0) {
      log(`silent (no prior summary for project=${project})`);
      return null;
    }

    const summary = typeof rows[0].summary === "string" ? rows[0].summary : "";
    const line = truncate(firstProseSentence(summary));
    if (line.length < 8) return null; // no usable prose (boilerplate-only summary)

    const age = relativeAge(rows[0].last_update_date as string | undefined);
    const when = age ? ` (${age})` : "";

    const brief =
      `Picking up on ${project}${when} — last time you left off here:\n` +
      `   📌 ${line}\n` +
      `   Ask me for the full thread whenever you're ready.`;

    log(`fired (project=${project})`);
    return { brief };
  } catch (e: unknown) {
    log(`pickResumeBrief: ${(e as Error).message}`);
    return null;
  }
}
