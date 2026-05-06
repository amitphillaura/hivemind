/**
 * Per-agent delivery dispatch. Each adapter receives a rendered plain-text
 * notification block and writes it in whatever shape that agent's harness
 * surfaces to the user without concatenating into the existing memory/hivemind
 * block.
 *
 * Today only Claude Code has a real adapter. Other agents (Codex, Cursor,
 * Hermes, Pi, openclaw) will be added one at a time — each addition is:
 *   1. New file `src/notifications/delivery/<agent>.ts` exporting an emit
 *   2. Add the agent string to the `Agent` union in `../types.ts`
 *   3. Wire it into the ADAPTERS map below
 *
 * See `../AGENT_CHANNELS.md` for the research on per-agent harness
 * behavior — that's the forward reference for what each new adapter
 * needs to do.
 */

import type { Agent } from "../types.js";
import { emitClaudeCode } from "./claude-code.js";

export type EmitFn = (rendered: string) => void;

const ADAPTERS: Record<Agent, EmitFn> = {
  "claude-code": emitClaudeCode,
};

export function emit(agent: Agent, rendered: string): void {
  if (!rendered) return;
  ADAPTERS[agent](rendered);
}
