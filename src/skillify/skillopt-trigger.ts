/**
 * Event-driven, user-side firing of the SkillOpt loop. Replaces the old weekly
 * SessionStart time-throttle entirely — firing is driven by REAL bad-skill signal.
 *
 * Flow (all hook-side, never blocking):
 *   PreToolUse(Skill, ORG skill only) → markSkillPending(session, X)   — opens a K-message
 *                                                                         judgment window for X
 *   UserPromptSubmit (the reaction)   → runEventTrigger(session, prompt) — spawn the worker to
 *                                                                          judge X against the reaction
 *
 * The spawned worker judges X's window (the LLM is the only evaluator — a regex can't
 * catch "you fucked up again") with the just-submitted reaction passed in, and improves X
 * immediately if it failed. Each org-skill call opens a window of K user messages
 * (default 3); the worker is fired on each until the budget is spent. A session that never
 * invokes an org skill never opens a window, so it never spawns anything — zero overhead.
 *
 * Opt-out: HIVEMIND_SKILLOPT_DISABLED=1.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log as _log } from "../utils/debug.js";
import { getStateDir } from "./state-dir.js";
import { splitOrgSkill } from "./skill-invocations.js";
import { loadConfig } from "../config.js";

const log = (m: string) => _log("skillopt-trigger", m);

/** Creds check — same as the worker (loadConfig accepts file OR env creds). */
function defaultHasCreds(): boolean {
  try { return Boolean(loadConfig()?.token); } catch { return false; }
}

/** How many user messages after a skill call to keep judging it (the reaction may not be
 *  the immediate next turn — "clarify, then push back"). Default 3, env-tunable. */
export const DEFAULT_JUDGE_WINDOW = 3;
export function judgeWindow(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.HIVEMIND_SKILLOPT_JUDGE_WINDOW);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_JUDGE_WINDOW;
}

/** Cap the pending map so it can't grow unbounded across a long-lived install. */
const MAX_SESSIONS = 200;
/** Reaction text passed to the worker via env — bounded so a pasted log can't bloat argv. */
const MAX_REACTION = 8000;

function stateFile(): string {
  return path.join(getStateDir(), "skillopt", "state.json");
}

export interface PendingSkill { skill: string; budget: number }
export interface SkillOptState {
  /** sessionId -> the skill awaiting judgment + remaining message budget. */
  pending?: Record<string, PendingSkill>;
}

export function loadState(file: string = stateFile()): SkillOptState {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as SkillOptState; } catch { return {}; }
}

export function saveState(s: SkillOptState, file: string = stateFile()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, file);
  } catch { /* swallow — hooks must never fail */ }
}

function prune(m: Record<string, PendingSkill>): Record<string, PendingSkill> {
  const keys = Object.keys(m);
  if (keys.length <= MAX_SESSIONS) return m;
  const out: Record<string, PendingSkill> = {};
  for (const k of keys.slice(keys.length - MAX_SESSIONS)) out[k] = m[k];
  return out;
}

export interface MarkDeps {
  load?: () => SkillOptState;
  save?: (s: SkillOptState) => void;
  env?: NodeJS.ProcessEnv;
}

/**
 * Open (or reset) a K-message judgment window for an ORG skill the session just
 * invoked. Called from PreToolUse on `Skill` tool_use. Org skills only — a bare local
 * skill or plugin (`hivemind:...`) is ignored. The newest org-skill call supersedes the
 * pending one for that session (the next reaction is to the most recent skill). Returns
 * true if a window is now open.
 */
export function markSkillPending(sessionId: string, skillRef: string, deps: MarkDeps = {}): boolean {
  if (!sessionId || !skillRef) return false;
  if (!splitOrgSkill(skillRef)) return false; // not an org skill → not our concern
  const state = (deps.load ?? loadState)();
  const pending = prune({ ...(state.pending ?? {}), [sessionId]: { skill: skillRef, budget: judgeWindow(deps.env ?? process.env) } });
  (deps.save ?? saveState)({ ...state, pending });
  return true;
}

export interface TriggerDeps {
  env?: NodeJS.ProcessEnv;
  load?: () => SkillOptState;
  save?: (s: SkillOptState) => void;
  spawnWorker?: (sessionId: string, skill: string, reaction: string, agent?: string) => void;
  canFire?: () => boolean;
}

export interface FireResult {
  fired: boolean;
  reason?: "disabled" | "in-worker" | "no-skill" | "no-creds" | "spawned";
}

/**
 * On a user reaction, fire the worker to judge the session's pending skill against it.
 * Non-blocking. No pending skill → no-op (the common case). Decrements the message budget
 * and closes the window when it's spent.
 */
export function runEventTrigger(
  sessionId: string,
  reaction: string,
  opts: { agent?: string; deps?: TriggerDeps } = {},
): FireResult {
  const deps = opts.deps ?? {};
  const env = deps.env ?? process.env;
  if (env.HIVEMIND_SKILLOPT_DISABLED === "1") return { fired: false, reason: "disabled" };
  if (env.HIVEMIND_SKILLOPT_WORKER === "1") return { fired: false, reason: "in-worker" }; // recursion guard
  if (!sessionId) return { fired: false, reason: "no-skill" };
  const state = (deps.load ?? loadState)();
  const p = state.pending?.[sessionId];
  if (!p) return { fired: false, reason: "no-skill" }; // no org skill awaiting judgment
  if (!(deps.canFire ?? defaultHasCreds)()) return { fired: false, reason: "no-creds" };

  // Spend one message of the budget; close the window when exhausted.
  const pending = { ...(state.pending ?? {}) };
  if (p.budget - 1 <= 0) delete pending[sessionId];
  else pending[sessionId] = { ...p, budget: p.budget - 1 };
  (deps.save ?? saveState)({ ...state, pending });

  (deps.spawnWorker ?? spawnWorker)(sessionId, p.skill, reaction ?? "", opts.agent);
  return { fired: true, reason: "spawned" };
}

/** Spawn the detached targeted worker (judge skill X against the reaction). Swallowed. */
function spawnWorker(sessionId: string, skill: string, reaction: string, agent?: string): void {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const entry = path.join(here, "skillopt-worker.js"); // bundled alongside this module
    const child = spawn(process.execPath, [entry], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        HIVEMIND_SKILLOPT_WORKER: "1",
        HIVEMIND_SKILLOPT_SESSION: sessionId,
        HIVEMIND_SKILLOPT_SKILL: skill,
        HIVEMIND_SKILLOPT_REACTION: (reaction ?? "").slice(0, MAX_REACTION),
        ...(agent ? { HIVEMIND_SKILLOPT_AGENT: agent } : {}),
      },
    });
    child.unref();
    log(`spawned skillopt worker for ${skill} in ${sessionId}${agent ? ` (agent=${agent})` : ""}`);
  } catch (e: unknown) {
    log(`spawn failed (swallowed): ${(e as Error)?.message ?? e}`);
  }
}
