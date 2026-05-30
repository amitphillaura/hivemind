/**
 * Cold-start brief — the proactive 3-4 sentence Hivemind banner shown ONCE,
 * on a user's very first session, giving them one specific, recognizable,
 * evidence-backed insight mined from their pre-Hivemind local Claude history
 * (~/.claude/projects/*.jsonl) — before they've typed anything.
 *
 * Scope (deliberately narrow — the recurring/returning brief and the
 * Hivemind-summaries source are a separate task):
 *   - Fires only on the FIRST run (no prior state file). Every later session
 *     is silent here; the banner falls back to its normal "Welcome back".
 *   - Mines only local jsonls. No Hivemind API calls.
 *
 * Signals (priority order; first to clear its bar wins):
 *   1. recall-seeking openers — the user typed "what was I doing / continue
 *      from / todo list" as a session's first prompt (they reached for the
 *      memory Hivemind provides, before it existed).
 *   2. abandoned thread — a session ended on a TODO-ish handoff that no later
 *      session resumed.
 *   3. dominant project — N% of sessions on one project.
 *
 * Quality guarantees:
 *   - High-precision-or-silent: returns null if nothing clears the bar.
 *   - Every snippet is trimmed to a sentence/clause boundary — never
 *     mid-word, never a dangling fragment.
 *
 * Failure mode: any unexpected error returns null — the welcome banner is
 * unaffected.
 */

import { existsSync, readdirSync, statSync, writeFileSync, readFileSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import type { Credentials } from "../../commands/auth-creds.js";
import { log as _log } from "../../utils/debug.js";

const log = (m: string) => _log("notifications-cold-start-brief", m);

// ─── Config ─────────────────────────────────────────────────────────────
const WINDOW_DAYS_CAP = 60;
// Internal budget kept well under the SessionStart hook's 5s timeout so the
// hook always emits + persists state rather than being killed mid-scan.
const HARD_TIMEOUT_MS = 3500;
// We only need each session's first + last human prompt, so we read a chunk
// from each END of the jsonl instead of the whole file (some are 100k+ rows).
const HEAD_TAIL_BYTES = 32 * 1024;
const RECALL_MIN_HITS = 3;
const ABANDONED_MIN_HITS = 1;

const PROJECTS_DIR = () => join(homedir(), ".claude", "projects");
const STATE_FILE = () => join(homedir(), ".claude", ".hivemind_brief_state.json");

// ─── Types ──────────────────────────────────────────────────────────────
type SignalKind = "recall" | "abandoned" | "volume" | "quiet";

interface SessionMeta {
  firstTs: Date;
  lastTs: Date;
  project: string;
  firstMessage?: string;
  lastMessage?: string;
}

interface Signal {
  kind: SignalKind;
  description: string;
  project?: string;
  date?: string;
  count?: number;
}

/** Result of a fired cold-start brief. `firstRun` is always true today (the
 *  brief only fires on first contact) but is surfaced so the banner can pick
 *  "Hey <name>" over "Welcome back". */
export interface ColdStartBrief {
  brief: string;
  firstRun: boolean;
}

// ─── Pattern matchers ───────────────────────────────────────────────────
const RECALL_RE = new RegExp(
  "\\b(" +
    "what (was|were) (i|we) (doing|working)|" +
    "where (did|was) (i|we) (leave|left|stop)|" +
    "continue from|pick.{0,20}(up|back|where)|" +
    "remind me|what'?s (my|the) (todo|status|state|progress)|" +
    "what'?s (open|pending|left|next)|" +
    "recap|summari[sz]e (my|the|last|recent)|" +
    "todo list|catch me up|where (am|are) (i|we)|" +
    "what (have|did) (i|we) (done|been doing)|" +
    "read (my|the) last \\d+ sessions" +
  ")\\b",
  "i",
);

const ABANDON_RE = /(next time|next session|todo[: ]|still need|left off|come back to|pick this up|finish.*later|continue.*tomorrow)/i;

// ─── State ──────────────────────────────────────────────────────────────
/** Minimum gap between anonymous re-nudges. Signed-in users fire once ever;
 *  anonymous users (the install→sign-in conversion target) get re-surfaced
 *  no more than once per this window until they sign in — firing every
 *  session would be a nag, never re-firing would waste the conversion. */
const RENUDGE_MS = 24 * 60 * 60 * 1000;

function hasState(): boolean {
  return existsSync(STATE_FILE());
}

/** Epoch-ms of the last brief, or null if no state / unparseable. */
function lastBriefMs(): number | null {
  try {
    if (!existsSync(STATE_FILE())) return null;
    const raw = JSON.parse(readFileSync(STATE_FILE(), "utf-8")) as { lastBriefTs?: unknown };
    const t = typeof raw?.lastBriefTs === "string" ? Date.parse(raw.lastBriefTs) : NaN;
    return Number.isNaN(t) ? null : t;
  } catch {
    return null;
  }
}

function writeState(sessionsScanned: number, isFirstRun: boolean): void {
  try {
    writeFileSync(
      STATE_FILE(),
      JSON.stringify({
        lastBriefTs: new Date().toISOString(),
        fireReason: isFirstRun ? "first_run" : "renudge",
        sessionsScanned,
      }),
    );
  } catch (e: unknown) {
    log(`writeState failed: ${(e as Error).message}`);
  }
}

// ─── Text utilities ─────────────────────────────────────────────────────
function parseTs(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Trim text to a clean boundary at or before `maxLen`. Prefers a sentence
 * end (. ! ?), then a clause break (, ; :), then a word boundary — never
 * cuts mid-word and never leaves a dangling opener. Strips surrounding
 * quotes and collapses whitespace/markdown noise.
 */
function cleanSnippet(raw: string, maxLen = 150): string {
  let s = raw
    .replace(/[`*_#>]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^["'\s]+/, "")
    .trim();
  s = s.replace(/"/g, "'");
  if (s.length <= maxLen) return stripDanglingOpener(s);

  const window = s.slice(0, maxLen);
  const sentenceEnd = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  if (sentenceEnd >= maxLen * 0.5) return stripDanglingOpener(window.slice(0, sentenceEnd + 1).trim());

  const clauseEnd = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "));
  if (clauseEnd >= maxLen * 0.5) return stripDanglingOpener(window.slice(0, clauseEnd).trim() + "…");

  const lastSpace = window.lastIndexOf(" ");
  const cut = lastSpace > 0 ? window.slice(0, lastSpace) : window;
  return stripDanglingOpener(cut.trim() + "…");
}

function stripDanglingOpener(s: string): string {
  let out = s;
  const opens = (out.match(/\(/g) || []).length;
  const closes = (out.match(/\)/g) || []).length;
  if (opens > closes) out = out.replace(/\s*\([^)]*$/, "");
  return out.replace(/[\s,;:(]+$/, "").trim();
}

function deriveProjectLabel(projDirName: string, cwdSeen: string | undefined): string {
  if (cwdSeen) {
    const seg = cwdSeen.split(/[/\\]/).filter(Boolean);
    return seg[seg.length - 1] || projDirName;
  }
  const parts = projDirName.split("-");
  return parts[parts.length - 1] || projDirName;
}

// ─── Local-jsonl mining ────────────────────────────────────────────────
/** Read up to `bytes` from the start and (if larger) the end of a file.
 *  Bounds per-file work regardless of file size — jsonl sessions can be
 *  100k+ rows, but the first/last human prompt live near the two ends. */
function readHeadTail(path: string, bytes: number): { head: string; tail: string } | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = statSync(path).size;
    const headLen = Math.min(bytes, size);
    const headBuf = Buffer.allocUnsafe(headLen);
    readSync(fd, headBuf, 0, headLen, 0);
    let tail = "";
    if (size > bytes) {
      const tailLen = Math.min(bytes, size);
      const tailBuf = Buffer.allocUnsafe(tailLen);
      readSync(fd, tailBuf, 0, tailLen, size - tailLen);
      tail = tailBuf.toString("utf-8");
    }
    return { head: headBuf.toString("utf-8"), tail };
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch {/* ignore */}
  }
}

interface UserRow { ts: Date; content: string; cwd?: string }

/** Parse complete jsonl lines from a chunk into user-message rows. Partial
 *  first/last lines (from a mid-file byte cut) fail JSON.parse and are
 *  skipped — exactly what we want. */
function parseUserRows(chunk: string): UserRow[] {
  const rows: UserRow[] = [];
  for (const line of chunk.split("\n")) {
    if (!line) continue;
    let row: { type?: string; isSidechain?: boolean; message?: { content?: unknown }; timestamp?: string; cwd?: string };
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type !== "user" || row.isSidechain) continue;
    const c = row.message?.content;
    if (typeof c !== "string") continue;
    const ts = parseTs(row.timestamp);
    if (!ts) continue;
    rows.push({ ts, content: c, cwd: row.cwd });
  }
  return rows;
}

function loadLocalSession(path: string, cutoff: Date): SessionMeta | null {
  let mtime: Date;
  try {
    mtime = statSync(path).mtime;
  } catch { return null; }
  if (mtime < cutoff) return null;

  const ht = readHeadTail(path, HEAD_TAIL_BYTES);
  if (!ht) return null;

  const headRows = parseUserRows(ht.head);
  const tailRows = ht.tail ? parseUserRows(ht.tail) : headRows;
  if (headRows.length === 0) return null;

  const first = headRows[0];
  const last = (tailRows.length > 0 ? tailRows[tailRows.length - 1] : headRows[headRows.length - 1]);
  const projectCwd = first.cwd ?? last.cwd;
  if (last.ts < cutoff) return null;

  const projDirName = path.split(/[/\\]/).slice(-2, -1)[0] ?? "unknown";
  return {
    firstTs: first.ts,
    lastTs: last.ts,
    project: deriveProjectLabel(projDirName, projectCwd),
    firstMessage: first.content,
    lastMessage: last.content,
  };
}

function mineLocal(cutoff: Date): SessionMeta[] {
  const out: SessionMeta[] = [];
  const deadline = Date.now() + HARD_TIMEOUT_MS;
  const base = PROJECTS_DIR();
  if (!existsSync(base)) return out;
  let projDirs: string[];
  try { projDirs = readdirSync(base); } catch { return out; }
  for (const d of projDirs) {
    if (Date.now() > deadline) break;
    let files: string[];
    try { files = readdirSync(join(base, d)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      if (Date.now() > deadline) break;
      const s = loadLocalSession(join(base, d, f), cutoff);
      if (s) out.push(s);
    }
  }
  return out;
}

// ─── Signal extraction ──────────────────────────────────────────────────
function pickSignal(sessions: SessionMeta[]): Signal {
  if (sessions.length === 0) return { kind: "quiet", description: "nothing in window" };

  const sorted = [...sessions].sort((a, b) => b.lastTs.getTime() - a.lastTs.getTime());

  const projCount = new Map<string, SessionMeta[]>();
  for (const s of sorted) {
    const arr = projCount.get(s.project) ?? [];
    arr.push(s);
    projCount.set(s.project, arr);
  }
  const topProj = [...projCount.entries()].sort((a, b) => b[1].length - a[1].length)[0];

  // 1. Recall-seeking — the johg "I tried to build my own recall" story.
  const recallHits = sorted.filter((s) => s.firstMessage && RECALL_RE.test(s.firstMessage.slice(0, 800)));
  if (recallHits.length >= RECALL_MIN_HITS) {
    const distinctDays = new Set(recallHits.map((s) => s.firstTs.toISOString().slice(0, 10))).size;
    const oneDay = distinctDays < 3 ? recallHits[0].firstTs.toISOString().slice(0, 10) : undefined;
    return {
      kind: "recall",
      description: oneDay
        ? `on ${oneDay} you spent the day trying to build your own todo/continuity layer on ${recallHits[0].project} — it didn't quite land`
        : `${recallHits.length} of your sessions on ${recallHits[0].project} opened with you asking the agent to recall what you were doing`,
      project: recallHits[0].project,
      date: oneDay,
      count: recallHits.length,
    };
  }

  // 2. Abandoned thread — last human message was a handoff nobody resumed.
  const abandoned = sorted.filter((s) => s.lastMessage && ABANDON_RE.test(s.lastMessage));
  if (abandoned.length >= ABANDONED_MIN_HITS) {
    const a = abandoned[0];
    const oneLine = cleanSnippet(a.lastMessage ?? "", 130);
    if (oneLine.length >= 8) {
      return {
        kind: "abandoned",
        description: `your last session on ${a.project} ended with "${oneLine}" and no later session picked it up`,
        project: a.project,
        date: a.lastTs.toISOString().slice(0, 10),
        count: abandoned.length,
      };
    }
  }

  // 3. Dominant project.
  if (topProj && topProj[1].length / sorted.length >= 0.5) {
    const pct = Math.round((topProj[1].length / sorted.length) * 100);
    return {
      kind: "volume",
      description: `${pct}% of your sessions have been on ${topProj[0]}`,
      project: topProj[0],
      count: topProj[1].length,
    };
  }

  return { kind: "quiet", description: `nothing worth flagging across ${sorted.length} sessions` };
}

// ─── Render — hard 3-4 sentence cap ─────────────────────────────────────
function renderBrief(sessions: SessionMeta[], signal: Signal, authed: boolean): string | null {
  if (sessions.length === 0 || signal.kind === "quiet") return null;

  // Generic, privacy-safe copy. The mined signal is used only as a GATE
  // (is there enough recent local history to warrant a brief?) — we do NOT
  // quote the user's private sessions back at them. A verbatim snippet on
  // first contact reads as surveillance; "I found context" conveys the
  // value without it.
  return authed
    ? "I found context from your recent sessions — from now on I'll keep it, so your next session picks up where you left off."
    : "I found context from your recent sessions. Sign in to save it, so future sessions start with what you've already learned.";
}

// ─── Public entry point ────────────────────────────────────────────────
/**
 * Returns the cold-start brief (and first-run flag), or null.
 *
 * The CTA and firing cadence depend on sign-in state:
 *   • Signed in  — onboarding brief, fires exactly ONCE ever (then
 *                  resume-brief takes over on later sessions). CTA is a
 *                  plain "future sessions resume" promise (no login needed).
 *   • Anonymous  — the install→sign-in conversion nudge. Fires on first run,
 *                  then re-surfaces no more than once per RENUDGE_MS until
 *                  they sign in. CTA drives `hivemind login`.
 *
 * `firstRun` is true only on genuine first contact (no prior state) so the
 * caller can pick "Hey <name>" over "Welcome back".
 */
export async function pickColdStartBrief(
  creds: Credentials | null | undefined,
): Promise<ColdStartBrief | null> {
  try {
    const authed = !!creds?.token;
    const hadState = hasState();

    if (authed) {
      // Onboarding fires once; after that, resume-brief is the surface.
      if (hadState) return null;
    } else {
      // Anonymous re-nudge: respect the 24h gap so we don't nag every
      // session, but keep trying until the conversion lands.
      const last = lastBriefMs();
      if (last !== null && Date.now() - last < RENUDGE_MS) return null;
    }

    const cutoff = new Date(Date.now() - WINDOW_DAYS_CAP * 86_400_000);
    const sessions = mineLocal(cutoff);
    const signal = pickSignal(sessions);
    const brief = renderBrief(sessions, signal, authed);

    if (!brief) {
      log(`silent (signal=${signal.kind}, sessions=${sessions.length})`);
      return null;
    }

    writeState(sessions.length, !hadState);
    log(`fired (authed=${authed}, first=${!hadState}, signal=${signal.kind})`);
    return { brief, firstRun: !hadState };
  } catch (e: unknown) {
    log(`unexpected error: ${(e as Error).message}`);
    return null;
  }
}
