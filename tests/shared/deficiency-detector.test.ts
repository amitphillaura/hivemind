import { describe, it, expect, vi } from "vitest";
import { detectDeficientSkills } from "../../src/skillify/deficiency-detector.js";

const TABLE = "sessions";

const invRow = (skill: string, sid: string) => ({
  message: { type: "tool_call", tool_name: "Skill", tool_input: JSON.stringify({ skill }), session_id: sid, timestamp: sid },
  last_update_date: sid,
});
const transcript = (skill: string, sid: string, pushback: boolean) => [
  { message: { type: "user_message", content: "do it" } },
  { message: { type: "assistant_message", content: "done" } },
  { message: { type: "tool_call", tool_name: "Skill", tool_input: JSON.stringify({ skill }), timestamp: sid } },
  { message: { type: "user_message", content: pushback ? "no that's wrong, it mocks the client" : "thanks, perfect" } },
];

function world() {
  const invs: Array<Record<string, unknown>> = [];
  const transcripts = new Map<string, Array<Record<string, unknown>>>();
  const add = (skill: string, sid: string, pushback: boolean) => {
    invs.push(invRow(skill, sid));
    transcripts.set(sid, transcript(skill, sid, pushback));
  };
  for (let i = 0; i < 10; i++) add("bad--auth", `bad${i}`, i < 5);     // 5/10 pushback → deficient
  for (let i = 0; i < 10; i++) add("good--auth", `good${i}`, false);   // 0 pushback → healthy
  for (let i = 0; i < 3; i++) add("sparse--auth", `sparse${i}`, true); // all fail but too few (min-n)
  return { invs, transcripts };
}

describe("detectDeficientSkills", () => {
  it("flags only skills with enough invocations AND a high confirmed-failure rate", async () => {
    const { invs, transcripts } = world();
    const judge = vi.fn(async (_s: string, _u: string) => '{"success":0,"confidence":0.9,"reason":"mocks the client"}');
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('"Skill"') && sql.includes("ORDER BY last_update_date")) return invs; // the invocation list
      const m = sql.match(/\/sessions\/%([^%]+)%/);                                           // a window query
      return m ? (transcripts.get(m[1]) ?? []) : [];
    });

    const { skills, deficientCount } = await detectDeficientSkills(query, TABLE, { judge });
    const bad = skills.find((s) => s.name === "bad")!;
    const good = skills.find((s) => s.name === "good")!;
    const sparse = skills.find((s) => s.name === "sparse")!;

    expect(bad).toMatchObject({ invocations: 10, anchored: 5, confirmedFailures: 5, deficient: true });
    expect(bad.failureRate).toBeCloseTo(0.5);
    expect(good).toMatchObject({ invocations: 10, anchored: 0, confirmedFailures: 0, deficient: false });
    expect(sparse).toMatchObject({ invocations: 3, confirmedFailures: 3, deficient: false }); // min-n blocks it
    expect(deficientCount).toBe(1);

    // token discipline: judge runs ONLY on anchored windows (5 bad + 3 sparse = 8), never the 10 good
    expect(judge).toHaveBeenCalledTimes(8);
  });

  it("caps the judged window at maxChars (a pasted log can't blow the judge call)", async () => {
    const huge = "L".repeat(5000);
    const skill = "bigskill--x", sid = "S1";
    const transcripts = new Map<string, Array<Record<string, unknown>>>([[sid, [
      { message: { type: "user_message", content: "do it" } },
      { message: { type: "assistant_message", content: huge } },                                  // pasted log
      { message: { type: "tool_call", tool_name: "Skill", tool_input: JSON.stringify({ skill }), timestamp: sid } },
      { message: { type: "user_message", content: "no that's wrong" } },
    ]]]);
    let judgedLen = 0;
    const judge = vi.fn(async (_s: string, user: string) => { judgedLen = user.length; return '{"success":0,"confidence":0.9,"reason":"x"}'; });
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('"Skill"') && sql.includes("ORDER BY last_update_date")) return [invRow(skill, sid)];
      const m = sql.match(/\/sessions\/%([^%]+)%/);
      return m ? (transcripts.get(m[1]) ?? []) : [];
    });
    await detectDeficientSkills(query, TABLE, { judge, minInvocations: 1, window: { maxChars: 300 } });
    expect(judgedLen).toBeGreaterThan(0);  // judge was called (anchored)
    expect(judgedLen).toBeLessThan(800);   // capped — not the ~5000-char paste
  });

  it("respects a custom threshold + min-n", async () => {
    const { invs, transcripts } = world();
    const judge = vi.fn(async (_s: string, _u: string) => '{"success":0,"confidence":0.9,"reason":"x"}');
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('"Skill"') && sql.includes("ORDER BY last_update_date")) return invs;
      const m = sql.match(/\/sessions\/%([^%]+)%/);
      return m ? (transcripts.get(m[1]) ?? []) : [];
    });
    // minInvocations 3, threshold 0.9 → only "sparse" (rate 1.0, 3 inv) qualifies; "bad" (0.5) doesn't
    const { deficientCount, skills } = await detectDeficientSkills(query, TABLE, { judge, minInvocations: 3, failureRateThreshold: 0.9 });
    expect(skills.find((s) => s.name === "sparse")!.deficient).toBe(true);
    expect(skills.find((s) => s.name === "bad")!.deficient).toBe(false);
    expect(deficientCount).toBe(1);
  });
});
