/**
 * LLM-driven KPI generator for `hivemind tasks add`.
 *
 * Takes a task text body and returns 1-3 Kpi objects the agent
 * should track to mark the task done. The output flows through
 * stringifyKpis (./kpi-validator.ts) before storage, so any
 * malformed item from the LLM is dropped — we never persist a
 * shape the renderer would silently throw away.
 *
 * Failure modes (all return [] rather than throwing):
 *
 *   - ANTHROPIC_API_KEY missing → return [] (no LLM call attempted);
 *     the user can still record progress manually via
 *     `hivemind tasks progress`.
 *   - HIVEMIND_KPI_LLM=disable → return [] (explicit opt-out).
 *   - LLM call timeout (default 10s) → return [].
 *   - LLM returns malformed JSON or unparseable shape → one retry
 *     with a stricter prompt; if that also fails, return [].
 *   - Any other error → return [].
 *
 * Returning [] on failure means `insertTask` keeps working even when
 * the LLM path is broken. Users see no KPIs and can fill them in
 * later. The eval suite (tests/evals/kpi-generation.eval.ts) tracks
 * generation quality across canonical inputs; this runtime is
 * paranoid about failure modes.
 */

import type { Kpi } from "./kpi-validator.js";
import { parseKpis } from "./kpi-validator.js";

const DEFAULT_MODEL = process.env.HIVEMIND_KPI_MODEL ?? "claude-sonnet-4-6";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_KPIS = 3;

/**
 * Anthropic SDK shape this module depends on. We type the dep against
 * a minimal interface so tests can inject a fake without pulling in
 * the full SDK type tree — and so a future SDK API change only breaks
 * THIS file, not callers.
 */
export interface AnthropicLike {
  messages: {
    create(args: {
      model: string;
      max_tokens: number;
      system?: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
    }): Promise<{
      content: Array<{ type: string; text?: string }>;
    }>;
  };
}

export interface GenerateKpisInput {
  /** Task text body — the LLM converts this into KPI definitions. */
  text: string;
  /** Optional override for the Anthropic client (tests + DI). */
  client?: AnthropicLike;
  /** Override the model id. Default: HIVEMIND_KPI_MODEL or 'claude-sonnet-4-6'. */
  model?: string;
  /** Override the timeout. Default 10s. */
  timeoutMs?: number;
  /** Optional logger for `[kpi-gen] …` lines (e.g. capture.ts's logger). */
  log?: (msg: string) => void;
}

/**
 * Generate KPIs from a task text. Returns [] on ANY failure (see
 * module docstring). Caller — insertTask — passes the returned array
 * straight to stringifyKpis, which already drops malformed items.
 */
export async function generateKpis(input: GenerateKpisInput): Promise<Kpi[]> {
  const log = input.log ?? (() => { /* nothing */ });

  // Explicit opt-out: HIVEMIND_KPI_LLM=disable skips the call even
  // when the API key is present. Useful for benchmarks and offline
  // dev.
  if (process.env.HIVEMIND_KPI_LLM === "disable") {
    log("kpi-gen: HIVEMIND_KPI_LLM=disable, skipping");
    return [];
  }

  // No API key → no call. Tests inject `input.client` so this gate
  // only blocks real network calls in production.
  if (!input.client && !process.env.ANTHROPIC_API_KEY) {
    log("kpi-gen: no ANTHROPIC_API_KEY, skipping");
    return [];
  }

  const model = input.model ?? DEFAULT_MODEL;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let client: AnthropicLike;
  if (input.client) {
    client = input.client;
  } else {
    try {
      const sdkMod = await import("@anthropic-ai/sdk");
      // The SDK default-exports a class; instantiating it pulls
      // ANTHROPIC_API_KEY from env automatically.
      const Ctor = (sdkMod as { default: new () => AnthropicLike }).default;
      client = new Ctor();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`kpi-gen: SDK import failed: ${msg}`);
      return [];
    }
  }

  // First attempt with the standard prompt; on parse failure, ONE retry
  // with a stricter "JSON only, no prose" prompt. Only retry when the
  // first failure is plausibly fixable by a different prompt (empty
  // content, unparseable text). Skip the retry on network/timeout/SDK
  // errors — a second call would just burn another timeout window.
  // CodeRabbit on PR #193 surfaced the wasted-retry cost.
  const first = await callOnce(client, model, input.text, /* strict */ false, timeoutMs, log);
  if (first.kpis.length > 0) return first.kpis;
  if (!first.retryable) return [];

  log("kpi-gen: first pass returned []; retrying with stricter prompt");
  const second = await callOnce(client, model, input.text, /* strict */ true, timeoutMs, log);
  return second.kpis;
}

/**
 * One LLM call + parse. `retryable` is true only when the failure mode
 * is "the LLM produced output we couldn't shape into KPIs" — a stricter
 * prompt might fix that. It's false for network/timeout/SDK exceptions,
 * which a retry would just repeat.
 */
interface CallResult { kpis: Kpi[]; retryable: boolean; }

async function callOnce(
  client: AnthropicLike,
  model: string,
  taskText: string,
  strict: boolean,
  timeoutMs: number,
  log: (msg: string) => void,
): Promise<CallResult> {
  const system = buildSystemPrompt(strict);
  const userMsg = `Task: ${taskText}\n\nReturn the KPIs as a JSON array.`;

  try {
    const result = await withTimeout(
      client.messages.create({
        model,
        max_tokens: 1024,
        system,
        messages: [{ role: "user", content: userMsg }],
      }),
      timeoutMs,
    );
    const text = extractText(result);
    if (!text) {
      log("kpi-gen: LLM returned empty content");
      return { kpis: [], retryable: true };
    }
    const json = stripCodeFence(text);
    return { kpis: parseAndShape(json, model), retryable: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`kpi-gen: LLM call failed: ${msg}`);
    return { kpis: [], retryable: false };
  }
}

/**
 * Wrap a promise with a hard timeout. Mirrors the AbortSignal pattern
 * the Anthropic SDK supports natively, but works against the minimal
 * AnthropicLike interface (which doesn't expose AbortSignal).
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); },
    );
  });
}

function buildSystemPrompt(strict: boolean): string {
  const base = [
    "You are generating KPI definitions for an engineering task.",
    "Return 1-3 KPIs that measure DONE-ness of the task.",
    "Each KPI is a JSON object with these EXACT fields:",
    `  - kpi_id     (short stable id, e.g. "k_pr_merged")`,
    `  - name       (human-readable, e.g. "PRs merged")`,
    `  - target     (positive integer)`,
    `  - unit       (short, e.g. "count", "lines", "tests")`,
    `  - generated_by (string, just put the model id you are)`,
    `  - generated_at (ISO 8601 timestamp)`,
    "Output a JSON array. Do NOT include any field other than the six above.",
    "Do NOT include keys like 'current', 'progress', or 'status' — those are computed from events.",
  ];
  if (strict) {
    base.push("CRITICAL: Output ONLY the JSON array. No prose, no markdown fences, no explanation. Start with '[' and end with ']'.");
  }
  return base.join("\n");
}

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
  for (const block of result.content) {
    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return "";
}

/**
 * Strip leading ```json / ```jsonc / ``` fences the LLM sometimes
 * emits despite the strict prompt. Tolerant — if no fence is
 * present, return the input unchanged.
 */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^```(?:json|jsonc)?\s*\n([\s\S]*?)\n```$/);
  if (fenceMatch) return fenceMatch[1].trim();
  return trimmed;
}

/**
 * Parse the LLM output as a JSON array of KPI candidates, route each
 * through parseKpis for shape validation + truncation to MAX_KPIS.
 * Returns [] on parse failure rather than throwing.
 */
function parseAndShape(json: string, generatedBy: string): Kpi[] {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];

  // Stamp generated_by + generated_at if the LLM didn't (defensive —
  // the prompt asks for them but cheap to backfill before validation
  // so a valid-but-incomplete output isn't dropped).
  const nowIso = new Date().toISOString();
  const stamped = arr.map(item => {
    if (typeof item !== "object" || item === null) return item;
    const obj = item as Record<string, unknown>;
    if (typeof obj.generated_by !== "string" || obj.generated_by.length === 0) {
      obj.generated_by = generatedBy;
    }
    if (typeof obj.generated_at !== "string" || obj.generated_at.length === 0) {
      obj.generated_at = nowIso;
    }
    return obj;
  });

  const validated = parseKpis(stamped);
  return validated.slice(0, MAX_KPIS);
}

/** Test-only exports for fixture verification. */
export const _internal = {
  buildSystemPrompt,
  stripCodeFence,
  parseAndShape,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  MAX_KPIS,
};
