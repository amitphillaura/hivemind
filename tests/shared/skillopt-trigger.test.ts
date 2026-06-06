import { describe, it, expect, vi } from "vitest";
import { markSkillPending, runEventTrigger, judgeWindow, DEFAULT_JUDGE_WINDOW, type SkillOptState } from "../../src/skillify/skillopt-trigger.js";

describe("markSkillPending (org-skill gate + K-message window)", () => {
  function harness(initial: SkillOptState = {}) {
    let state = initial;
    return { load: () => state, save: (s: SkillOptState) => { state = s; }, env: {} as NodeJS.ProcessEnv, get: () => state };
  }

  it("opens a K-message judgment window for an ORG skill", () => {
    const h = harness();
    expect(markSkillPending("s1", "posthog--kamo", h)).toBe(true);
    expect(h.get().pending).toEqual({ s1: { skill: "posthog--kamo", budget: DEFAULT_JUDGE_WINDOW } });
  });

  it("ignores bare local and plugin skills (org skills only)", () => {
    const h = harness();
    expect(markSkillPending("s1", "bareskill", h)).toBe(false);
    expect(markSkillPending("s1", "hivemind:memory", h)).toBe(false);
    expect(h.get().pending ?? {}).toEqual({});
  });

  it("the newest org-skill call supersedes the pending one and resets the budget", () => {
    const h = harness({ pending: { s1: { skill: "a--u", budget: 1 } } });
    markSkillPending("s1", "b--u", h);
    expect(h.get().pending?.s1).toEqual({ skill: "b--u", budget: DEFAULT_JUDGE_WINDOW });
  });

  it("returns false for empty session/skill", () => {
    expect(markSkillPending("", "x--a")).toBe(false);
    expect(markSkillPending("s1", "")).toBe(false);
  });
});

describe("runEventTrigger", () => {
  function harness(over: { state?: SkillOptState; env?: NodeJS.ProcessEnv; canFire?: () => boolean } = {}) {
    let state = over.state ?? { pending: { s1: { skill: "posthog--kamo", budget: 3 } } };
    const spawnWorker = vi.fn();
    const run = (sessionId: string, reaction: string, opts: { agent?: string } = {}) =>
      runEventTrigger(sessionId, reaction, {
        ...opts,
        deps: {
          env: over.env ?? ({} as NodeJS.ProcessEnv),
          load: () => state,
          save: (s) => { state = s; },
          spawnWorker,
          canFire: over.canFire ?? (() => true),
        },
      });
    return { run, spawnWorker, get: () => state };
  }

  it("spawns the worker with session+skill+reaction+agent, decrements the budget", () => {
    const { run, spawnWorker, get } = harness();
    const r = run("s1", "no you fucked up, mocking hides the bug", { agent: "codex" });
    expect(r).toEqual({ fired: true, reason: "spawned" });
    expect(spawnWorker).toHaveBeenCalledWith("s1", "posthog--kamo", "no you fucked up, mocking hides the bug", "codex");
    expect(get().pending?.s1.budget).toBe(2); // 3 → 2
  });

  it("closes the window when the budget is exhausted", () => {
    const { run, get } = harness({ state: { pending: { s1: { skill: "x--a", budget: 1 } } } });
    run("s1", "still broken");
    expect(get().pending?.s1).toBeUndefined(); // cleared
  });

  it("does NOTHING when no skill is pending for the session", () => {
    const { run, spawnWorker } = harness({ state: {} });
    expect(run("s1", "anything")).toEqual({ fired: false, reason: "no-skill" });
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("respects the kill switch, recursion guard, and logged-out state", () => {
    expect(harness({ env: { HIVEMIND_SKILLOPT_DISABLED: "1" } as never }).run("s1", "x").reason).toBe("disabled");
    expect(harness({ env: { HIVEMIND_SKILLOPT_WORKER: "1" } as never }).run("s1", "x").reason).toBe("in-worker");
    const lo = harness({ canFire: () => false });
    expect(lo.run("s1", "x")).toEqual({ fired: false, reason: "no-creds" });
    expect(lo.spawnWorker).not.toHaveBeenCalled();
  });
});

describe("judgeWindow", () => {
  it("defaults to 3, env-overridable, rejects garbage/non-positive", () => {
    expect(judgeWindow({} as NodeJS.ProcessEnv)).toBe(3);
    expect(judgeWindow({ HIVEMIND_SKILLOPT_JUDGE_WINDOW: "5" } as never)).toBe(5);
    expect(judgeWindow({ HIVEMIND_SKILLOPT_JUDGE_WINDOW: "0" } as never)).toBe(3);
    expect(judgeWindow({ HIVEMIND_SKILLOPT_JUDGE_WINDOW: "x" } as never)).toBe(3);
  });
});
