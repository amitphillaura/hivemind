import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKpis, type AnthropicLike, _internal } from "../../src/tasks/kpi-generator.js";

/**
 * Unit tests for the LLM KPI generator. We inject a fake AnthropicLike
 * client via the `client` option so no network call ever fires; the
 * eval suite (tests/evals/kpi-generation.eval.ts) is the place to test
 * real LLM behavior.
 */

function fakeClient(responses: Array<string | Error>): AnthropicLike {
  let step = 0;
  return {
    messages: {
      create: vi.fn(async () => {
        if (step >= responses.length) {
          throw new Error(`fakeClient ran out of scripted responses (step ${step})`);
        }
        const r = responses[step++];
        if (r instanceof Error) throw r;
        return { content: [{ type: "text", text: r }] };
      }),
    },
  };
}

const VALID_KPI = {
  kpi_id: "k_pr",
  name: "PRs merged",
  target: 5,
  unit: "count",
  generated_by: "claude-sonnet-4-6",
  generated_at: "2026-05-20T10:00:00.000Z",
};

beforeEach(() => {
  delete process.env.HIVEMIND_KPI_LLM;
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  delete process.env.HIVEMIND_KPI_LLM;
  delete process.env.ANTHROPIC_API_KEY;
});

// ── opt-outs ────────────────────────────────────────────────────────────────

describe("generateKpis — opt-outs", () => {
  it("returns [] when HIVEMIND_KPI_LLM=disable, even if API key is set", async () => {
    process.env.HIVEMIND_KPI_LLM = "disable";
    process.env.ANTHROPIC_API_KEY = "fake";
    const out = await generateKpis({ text: "ship feature X" });
    expect(out).toEqual([]);
  });

  it("returns [] when no API key and no injected client (no network attempt)", async () => {
    // env vars cleared in beforeEach; no client passed.
    const out = await generateKpis({ text: "ship feature X" });
    expect(out).toEqual([]);
  });

  it("calls log with a 'skipping' message on opt-out (debuggable)", async () => {
    const log = vi.fn();
    process.env.HIVEMIND_KPI_LLM = "disable";
    await generateKpis({ text: "x", log });
    expect(log.mock.calls.some(c => String(c[0]).includes("HIVEMIND_KPI_LLM=disable"))).toBe(true);
  });
});

// ── happy path ─────────────────────────────────────────────────────────────

describe("generateKpis — happy path", () => {
  it("parses a valid JSON array of KPIs from the LLM response", async () => {
    const client = fakeClient([JSON.stringify([VALID_KPI])]);
    const out = await generateKpis({ text: "ship feature X", client });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kpi_id: "k_pr", name: "PRs merged", target: 5 });
  });

  it("strips ```json fences before parsing (LLM sometimes adds them)", async () => {
    const fenced = "```json\n" + JSON.stringify([VALID_KPI]) + "\n```";
    const client = fakeClient([fenced]);
    const out = await generateKpis({ text: "x", client });
    expect(out).toHaveLength(1);
  });

  it("caps the returned KPIs to MAX_KPIS (3)", async () => {
    const lots = JSON.stringify(Array.from({ length: 7 }, (_, i) => ({
      ...VALID_KPI, kpi_id: `k_${i}`, name: `KPI ${i}`,
    })));
    const client = fakeClient([lots]);
    const out = await generateKpis({ text: "x", client });
    expect(out).toHaveLength(_internal.MAX_KPIS);
  });

  it("stamps generated_by + generated_at when the LLM omits them", async () => {
    const partial = JSON.stringify([{
      kpi_id: "k_pr", name: "PRs merged", target: 5, unit: "count",
      // no generated_by, no generated_at
    }]);
    const client = fakeClient([partial]);
    const out = await generateKpis({ text: "x", client, model: "custom-model" });
    expect(out).toHaveLength(1);
    expect(out[0].generated_by).toBe("custom-model");
    expect(out[0].generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("drops items that don't match the canonical Kpi shape", async () => {
    const mixed = JSON.stringify([
      VALID_KPI,
      { kpi_id: "bad", name: "" },              // empty name
      { kpi_id: "bad", target: "five" },        // wrong type
    ]);
    const client = fakeClient([mixed]);
    const out = await generateKpis({ text: "x", client });
    expect(out).toHaveLength(1);
    expect(out[0].kpi_id).toBe("k_pr");
  });
});

// ── failure modes ──────────────────────────────────────────────────────────

describe("generateKpis — failure modes (all return [])", () => {
  it("returns [] on LLM-returned malformed JSON, retries once with stricter prompt, gives up on second failure", async () => {
    const client = fakeClient(["not even close to json", "still not json"]);
    const out = await generateKpis({ text: "x", client });
    expect(out).toEqual([]);
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  it("RECOVERS when the strict-retry returns valid JSON", async () => {
    const client = fakeClient([
      "I'm going to give you KPIs now: " + JSON.stringify([VALID_KPI]),  // first attempt: prose + JSON → JSON.parse fails
      JSON.stringify([VALID_KPI]),                                         // strict attempt: clean JSON
    ]);
    const out = await generateKpis({ text: "x", client });
    expect(out).toHaveLength(1);
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  it("returns [] after ONE LLM call when the first attempt throws (network/timeout/SDK error — no retry)", async () => {
    // Contract change (PR #193 / CodeRabbit): retrying on network errors
    // adds latency + cost without changing the outcome. Only parse-style
    // failures (empty content, unparseable text) trigger the strict
    // retry — see callOnce's `retryable` flag in src/tasks/kpi-generator.ts.
    const client = fakeClient([new Error("rate limited"), new Error("rate limited")]);
    const out = await generateKpis({ text: "x", client });
    expect(out).toEqual([]);
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it("RETRIES once on parse failure but skips retry after a thrown error in the retry pass", async () => {
    // Symmetric regression guard: if the first attempt is parse-style
    // (so we DO enter the retry) but the retry itself throws, the
    // result is still [] — and we should not loop forever.
    const client = fakeClient([
      "not json at all",
      new Error("connection reset"),
    ]);
    const out = await generateKpis({ text: "x", client });
    expect(out).toEqual([]);
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  it("returns [] when the LLM returns a non-array (object, scalar, etc.)", async () => {
    const client = fakeClient([
      JSON.stringify({ kpi: VALID_KPI }),  // not an array
      JSON.stringify(42),
    ]);
    const out = await generateKpis({ text: "x", client });
    expect(out).toEqual([]);
  });

  it("returns [] when the LLM returns empty content blocks", async () => {
    const client: AnthropicLike = {
      messages: {
        create: vi.fn(async () => ({ content: [] })),
      },
    };
    const out = await generateKpis({ text: "x", client });
    expect(out).toEqual([]);
    expect(client.messages.create).toHaveBeenCalledTimes(2); // first + strict retry
  });

  it("returns [] when the call times out", async () => {
    const client: AnthropicLike = {
      messages: {
        // Never resolves → triggers timeout. Each generateKpis call
        // attempts twice (initial + strict retry), each with its own
        // timer. Use a very short timeoutMs so the test doesn't hang.
        create: vi.fn(() => new Promise<never>(() => { /* never resolves */ })),
      },
    };
    const out = await generateKpis({ text: "x", client, timeoutMs: 10 });
    expect(out).toEqual([]);
  });
});

// ── prompt construction (defense in depth) ──────────────────────────────────

describe("buildSystemPrompt", () => {
  it("includes all 6 required KPI fields in the standard prompt", () => {
    const prompt = _internal.buildSystemPrompt(false);
    for (const field of ["kpi_id", "name", "target", "unit", "generated_by", "generated_at"]) {
      expect(prompt).toContain(field);
    }
    expect(prompt).toContain("1-3 KPIs");
    // Strict-mode marker NOT present in non-strict variant
    expect(prompt).not.toContain("CRITICAL");
  });

  it("adds a CRITICAL: JSON-only banner in the strict (retry) prompt", () => {
    const prompt = _internal.buildSystemPrompt(true);
    expect(prompt).toContain("CRITICAL");
    expect(prompt).toContain("ONLY the JSON array");
  });
});

describe("stripCodeFence", () => {
  it("strips ```json fences", () => {
    expect(_internal.stripCodeFence("```json\n[]\n```")).toBe("[]");
  });
  it("strips ```jsonc fences", () => {
    expect(_internal.stripCodeFence("```jsonc\n[]\n```")).toBe("[]");
  });
  it("strips bare ``` fences", () => {
    expect(_internal.stripCodeFence("```\n[]\n```")).toBe("[]");
  });
  it("returns the input unchanged when no fence is present", () => {
    expect(_internal.stripCodeFence("[]")).toBe("[]");
    expect(_internal.stripCodeFence("  [{}]  ")).toBe("[{}]");
  });
});
