/**
 * Deficiency detector — the core of the engine's "which skills are bad" step.
 *
 * For each org-skill invocation: window the transcript around it, run the FREE
 * level-1 anchor (user pushback?), and only if anchored spend a level-2 judge
 * call (was the task actually accomplished?). A "confirmed failure" requires BOTH
 * — high precision, so we never churn a good skill. Aggregate per skill: a skill
 * is deficient if it has enough invocations AND a high confirmed-failure rate.
 *
 * Token discipline: the judge runs ONLY on anchored windows (a fraction), on a
 * windowed slice (not whole sessions). Everything injectable (query + judge model)
 * so the whole orchestration is unit-tested with zero live Deeplake / LLM.
 *
 * The ≥5 fire gate lives with the caller (worker): we just return deficientCount.
 */
import {
  listSkillInvocations, windowedTurns, elide, type QueryFn, type SkillInvocation,
} from "./skill-invocations.js";
import { detectAnchor } from "./session-anchor.js";
import { judgeSuccess, type ModelCall } from "./success-judge.js";

export interface SkillDeficiency {
  name: string;
  author: string;
  invocations: number;        // org-skill invocations examined
  anchored: number;           // had a level-1 anchor → judged
  confirmedFailures: number;  // anchor AND judge said success=0
  failureRate: number;        // confirmedFailures / invocations
  deficient: boolean;         // failureRate >= threshold AND invocations >= minInvocations
  examples: string[];         // a few failure reasons (for the proposer)
}

export interface DetectorConfig {
  minInvocations?: number;       // min-n per skill before we trust the rate (default 8)
  failureRateThreshold?: number; // confirmed-failure rate to flag deficient (default 0.4)
  window?: { before?: number; after?: number; maxChars?: number };
  judge?: ModelCall;             // injected; default = real claude judge
  sinceIso?: string;             // lookback bound
  limit?: number;                // cap invocation rows pulled
}

const skillKey = (name: string, author: string) => `${name}--${author}`;

export interface ScoreConfig {
  window?: { before?: number; after?: number; maxChars?: number };
  judge?: ModelCall;
}

/**
 * Score a set of invocations: window each, run the free anchor, and judge ONLY the
 * anchored ones. Shared by the detector (per-skill deficiency) and the edit gate
 * (a skill's failure rate in a time window).
 */
export async function scoreInvocations(
  query: QueryFn,
  sessionsTable: string,
  invocations: SkillInvocation[],
  cfg: ScoreConfig = {},
): Promise<{ anchored: number; confirmed: number; examples: string[] }> {
  let anchored = 0;
  let confirmed = 0;
  const examples: string[] = [];
  for (const inv of invocations) {
    const turns = await windowedTurns(query, sessionsTable, inv, cfg.window);
    const anchor = detectAnchor(turns);
    if (!anchor.anchored) continue; // free filter — no judge call
    anchored++;
    const window = elide(turns.map((t) => `${t.role}: ${t.text}`).join("\n\n"), cfg.window?.maxChars ?? 4000);
    const verdict = await judgeSuccess(window, { model: cfg.judge });
    if (verdict.success === 0) {
      confirmed++;
      if (examples.length < 3) examples.push(verdict.reason || anchor.evidence);
    }
  }
  return { anchored, confirmed, examples };
}

export interface DetectionResult {
  skills: SkillDeficiency[];
  deficientCount: number;
}

export async function detectDeficientSkills(
  query: QueryFn,
  sessionsTable: string,
  cfg: DetectorConfig = {},
): Promise<DetectionResult> {
  const minInvocations = cfg.minInvocations ?? 8;
  const threshold = cfg.failureRateThreshold ?? 0.4;

  const invocations = await listSkillInvocations(query, sessionsTable, { sinceIso: cfg.sinceIso, limit: cfg.limit });

  const groups = new Map<string, SkillInvocation[]>();
  for (const inv of invocations) {
    const k = skillKey(inv.name, inv.author);
    const arr = groups.get(k);
    if (arr) arr.push(inv); else groups.set(k, [inv]);
  }

  const skills: SkillDeficiency[] = [];
  for (const list of groups.values()) {
    const { anchored, confirmed, examples } = await scoreInvocations(query, sessionsTable, list, cfg);
    const failureRate = list.length ? confirmed / list.length : 0;
    skills.push({
      name: list[0].name,
      author: list[0].author,
      invocations: list.length,
      anchored,
      confirmedFailures: confirmed,
      failureRate,
      deficient: list.length >= minInvocations && failureRate >= threshold,
      examples,
    });
  }

  skills.sort((a, b) => b.failureRate - a.failureRate || b.invocations - a.invocations);
  return { skills, deficientCount: skills.filter((s) => s.deficient).length };
}
