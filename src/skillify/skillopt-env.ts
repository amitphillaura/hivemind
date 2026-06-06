/**
 * SkillOpt env-var names — single source of truth. The trigger WRITES these onto the
 * spawned worker's env and the worker READS them back; the agent-model overrides share
 * the same prefix. Keeping the literals here stops the writer and reader from drifting
 * (a typo in one place would silently break the hand-off). Raised by @efenocchi on PR #240.
 */
export const SKILLOPT_ENV = {
  /** User-set kill switch: "1" disables the whole trigger. */
  DISABLED: "HIVEMIND_SKILLOPT_DISABLED",
  /** Recursion guard the trigger sets on the spawned worker so the worker can't re-arm. */
  WORKER: "HIVEMIND_SKILLOPT_WORKER",
  /** Worker inputs, handed trigger → worker via the child env. */
  SESSION: "HIVEMIND_SKILLOPT_SESSION",
  SKILL: "HIVEMIND_SKILLOPT_SKILL",
  REACTION: "HIVEMIND_SKILLOPT_REACTION",
  TOOL_USE_ID: "HIVEMIND_SKILLOPT_TOOL_USE_ID",
  /** Which agent's CLI runs the judge/proposer (claude_code/codex/hermes/cursor/pi). */
  AGENT: "HIVEMIND_SKILLOPT_AGENT",
  /** K-message judgment-window size override. */
  JUDGE_WINDOW: "HIVEMIND_SKILLOPT_JUDGE_WINDOW",
} as const;

/** Shared prefix for the dynamic per-agent scorer overrides (model/provider). */
export const SKILLOPT_ENV_PREFIX = "HIVEMIND_SKILLOPT_";

/**
 * Per-agent, per-role model override names, most- to least-specific:
 * HIVEMIND_SKILLOPT_<AGENT>_<ROLE>_MODEL, then HIVEMIND_SKILLOPT_<AGENT>_MODEL.
 */
export function modelEnvNames(agent: string, role: string): [string, string] {
  const A = agent.toUpperCase();
  return [`${SKILLOPT_ENV_PREFIX}${A}_${role.toUpperCase()}_MODEL`, `${SKILLOPT_ENV_PREFIX}${A}_MODEL`];
}

/** Per-agent provider override name: HIVEMIND_SKILLOPT_<AGENT>_PROVIDER. */
export function providerEnvName(agent: string): string {
  return `${SKILLOPT_ENV_PREFIX}${agent.toUpperCase()}_PROVIDER`;
}
