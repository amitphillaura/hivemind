import { describe, it, expect, vi } from "vitest";
import { parseVerdict, judgeSuccess } from "../../src/skillify/success-judge.js";

describe("parseVerdict", () => {
  it("parses a clean JSON verdict", () => {
    expect(parseVerdict('{"success":0,"confidence":0.9,"reason":"mocks the client"}'))
      .toEqual({ success: 0, confidence: 0.9, reason: "mocks the client" });
  });
  it("tolerates ```json fences and surrounding prose", () => {
    const raw = "Here is my judgment:\n```json\n{\"success\": 1, \"confidence\": 0.8, \"reason\": \"ok\"}\n```\nDone.";
    expect(parseVerdict(raw)).toEqual({ success: 1, confidence: 0.8, reason: "ok" });
  });
  it("treats success false/\"0\" as failure and clamps confidence", () => {
    expect(parseVerdict('{"success":false,"confidence":2,"reason":"x"}')).toMatchObject({ success: 0, confidence: 1 });
    expect(parseVerdict('{"success":"0","confidence":-1,"reason":"x"}')).toMatchObject({ success: 0, confidence: 0 });
  });
  it("is conservative (success=1) on unparseable output", () => {
    expect(parseVerdict("the model rambled with no json")).toMatchObject({ success: 1, confidence: 0 });
  });
});

describe("judgeSuccess", () => {
  it("returns the judged verdict from the injected model", async () => {
    const model = vi.fn(async (_system: string, _user: string) => '{"success":0,"confidence":0.95,"reason":"no flush, event never sends"}');
    const v = await judgeSuccess("USER: do X\n\nASSISTANT: mocked it", { model });
    expect(v.success).toBe(0);
    expect(model).toHaveBeenCalledOnce();
    // the judge must be told to ignore mood (anti-sycophancy) + asked for JSON
    expect(model.mock.calls[0][0]).toMatch(/praised-but-wrong|Ignore whether the user/i);
  });

  it("is conservative (success=1) when the model call throws — a flaky judge can't manufacture failure", async () => {
    const v = await judgeSuccess("USER: x\n\nASSISTANT: y", { model: vi.fn(async () => { throw new Error("boom"); }) });
    expect(v.success).toBe(1);
    expect(v.reason).toContain("judge failed");
  });

  it("short-circuits an empty window without calling the model", async () => {
    const model = vi.fn(async () => "{}");
    const v = await judgeSuccess("   ", { model });
    expect(v.success).toBe(1);
    expect(model).not.toHaveBeenCalled();
  });
});
