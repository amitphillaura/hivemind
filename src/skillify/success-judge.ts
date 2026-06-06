/**
 * Success-judge — reward level 2. Given a windowed transcript slice, asks the
 * model the ONE question that resists sycophancy: was the user's task actually
 * accomplished CORRECTLY? (Ignore whether the user seemed happy — a praised-but-
 * wrong answer is a failure.) Returns success 0|1 + confidence + reason.
 *
 * Runs on the USER's own agent (claude -p) — cost lands on the user, so the
 * default model is cheap and this is only ever called on anchor-flagged windows
 * (level 1), never on every session.
 *
 * The model call is injected (ModelCall) so the judging logic is unit-tested with
 * zero real LLM calls; the default shells out to `claude -p`, all tools denied.
 *
 * Conservative on failure: an unparseable/errored/empty judgment returns
 * success=1 (do NOT count as a failure), so a flaky judge can never manufacture
 * deficiency — it can only fail to detect (which the next run catches).
 */
import { claudeModel, type ModelCall } from "./claude-model.js";

export type { ModelCall };

export interface SuccessVerdict {
  success: 0 | 1;
  confidence: number; // 0..1
  reason: string;
}

const SYSTEM =
  "You are a strict engineering reviewer. Judge ONLY whether the user's task was " +
  "actually accomplished CORRECTLY in this session slice. Ignore whether the user " +
  "seemed happy or polite — a praised-but-wrong answer is a FAILURE. Reply with " +
  'ONLY a JSON object: {"success": 0 or 1, "confidence": 0.0-1.0, "reason": ' +
  '"<=200 chars citing concrete evidence"}.';

function buildUserPrompt(window: string): string {
  return `Session slice (USER/ASSISTANT turns around a skill invocation):\n\n${window}\n\n` +
    "Did the user's task get accomplished correctly? JSON only.";
}

function extractJson(raw: string): Record<string, unknown> | null {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)) as Record<string, unknown>; } catch { return null; }
}

/** Parse a model response into a verdict; unparseable → conservative success=1. */
export function parseVerdict(raw: string): SuccessVerdict {
  const j = extractJson(raw);
  if (!j) return { success: 1, confidence: 0, reason: "unparseable judge output" };
  const fail = j.success === 0 || j.success === "0" || j.success === false;
  const confidence = typeof j.confidence === "number" ? Math.max(0, Math.min(1, j.confidence)) : 0.5;
  const reason = typeof j.reason === "string" ? j.reason.slice(0, 240) : "";
  return { success: fail ? 0 : 1, confidence, reason };
}

export async function judgeSuccess(window: string, opts: { model?: ModelCall } = {}): Promise<SuccessVerdict> {
  if (!window.trim()) return { success: 1, confidence: 0, reason: "empty window" };
  const model = opts.model ?? claudeModel("haiku"); // cheap default; judge only runs on anchored windows
  try {
    return parseVerdict(await model(SYSTEM, buildUserPrompt(window)));
  } catch (e: unknown) {
    return { success: 1, confidence: 0, reason: `judge failed: ${(e as Error)?.message ?? String(e)}` };
  }
}
