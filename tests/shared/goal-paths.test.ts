import { describe, expect, it } from "vitest";

import {
  classifyPath,
  composeGoalPath,
  composeKpiPath,
  decomposeGoalPath,
  decomposeKpiPath,
} from "../../src/shell/goal-paths.js";

/**
 * Pure classifier — no I/O, no DB — but it's the dispatch boundary
 * between the goals/kpis tables and the generic memory table inside
 * the VFS. A regression here silently routes goal writes back into the
 * memory table (no `WHERE goal_id` queryability ever) so the
 * cross-agent rollout starts losing rows without any explicit error.
 *
 * Coverage in trunk pre-PR #193: 34.1% statements, 33.3% functions.
 */

describe("classifyPath", () => {
  describe("goal paths", () => {
    it("classifies the canonical mount-relative form", () => {
      expect(classifyPath("/goal/alice/opened/uuid.md")).toBe("goal");
      expect(classifyPath("/goal/alice/in_progress/uuid.md")).toBe("goal");
      expect(classifyPath("/goal/alice/closed/uuid.md")).toBe("goal");
    });

    it("classifies the /memory/ host-FS form (Bash `echo > ~/.deeplake/memory/...`)", () => {
      expect(classifyPath("/home/emanuele/.deeplake/memory/goal/alice/opened/uuid.md")).toBe("goal");
      // .deeplake/memory/... arriving from inside the shell with HOME=mount=/
      expect(classifyPath("/.deeplake/memory/goal/alice/opened/uuid.md")).toBe("goal");
    });

    it("classifies the test-mount /memory/ form", () => {
      expect(classifyPath("/memory/goal/alice/closed/uuid.md")).toBe("goal");
    });

    it("rejects an unknown status (treated as plain memory write)", () => {
      // Critical for safety: a typo'd status must NOT route into the
      // goals table — that would create a row with an invalid status
      // value that the SessionStart renderer can't filter.
      expect(classifyPath("/goal/alice/wat/uuid.md")).toBe("memory");
    });

    it("rejects missing .md extension", () => {
      expect(classifyPath("/goal/alice/opened/uuid")).toBe("memory");
      expect(classifyPath("/goal/alice/opened/uuid.txt")).toBe("memory");
    });

    it("rejects wrong segment count", () => {
      expect(classifyPath("/goal/alice/opened.md")).toBe("memory"); // 3 segs
      expect(classifyPath("/goal/alice/opened/uuid/extra.md")).toBe("memory"); // 5 segs
      expect(classifyPath("/goal")).toBe("memory");
    });
  });

  describe("kpi paths", () => {
    it("classifies the canonical mount-relative form", () => {
      expect(classifyPath("/kpi/g-uuid/k-prs.md")).toBe("kpi");
    });

    it("classifies the /memory/ host-FS form", () => {
      expect(classifyPath("/home/emanuele/.deeplake/memory/kpi/g-uuid/k-prs.md")).toBe("kpi");
    });

    it("rejects missing .md", () => {
      expect(classifyPath("/kpi/g-uuid/k-prs")).toBe("memory");
    });

    it("rejects wrong segment count", () => {
      expect(classifyPath("/kpi/g-uuid")).toBe("memory");
      expect(classifyPath("/kpi/g-uuid/k-prs/extra.md")).toBe("memory");
    });
  });

  describe("memory paths", () => {
    it("treats anything outside goal/ and kpi/ as memory", () => {
      expect(classifyPath("/summaries/alice/abc.md")).toBe("memory");
      expect(classifyPath("/foo/bar.md")).toBe("memory");
      expect(classifyPath("/")).toBe("memory");
      expect(classifyPath("/memory")).toBe("memory");
    });

    it("returns memory for empty / whitespace-only paths after normalization", () => {
      expect(classifyPath("")).toBe("memory");
      expect(classifyPath("/")).toBe("memory");
      expect(classifyPath("//")).toBe("memory");
    });

    it("strips trailing slashes consistently", () => {
      expect(classifyPath("/goal/alice/opened/uuid.md/")).toBe("goal");
      expect(classifyPath("/kpi/g/k.md/")).toBe("kpi");
    });
  });
});

describe("decomposeGoalPath", () => {
  it("extracts owner / status / goal_id from a canonical path", () => {
    expect(decomposeGoalPath("/goal/alice/opened/abc-123.md")).toEqual({
      owner: "alice",
      status: "opened",
      goal_id: "abc-123",
    });
  });

  it("handles the host-FS /memory/ prefix the same way", () => {
    expect(decomposeGoalPath("/home/emanuele/.deeplake/memory/goal/alice/closed/uuid.md")).toEqual({
      owner: "alice",
      status: "closed",
      goal_id: "uuid",
    });
  });

  it("strips the .md extension from the goal_id", () => {
    const parts = decomposeGoalPath("/goal/o/in_progress/11111111-2222-3333-4444-555555555555.md");
    expect(parts.goal_id).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("throws on a non-goal path so callers can't accidentally treat memory rows as goals", () => {
    expect(() => decomposeGoalPath("/summaries/alice/abc.md")).toThrow(/Not a goal path/);
    expect(() => decomposeGoalPath("/kpi/g/k.md")).toThrow(/Not a goal path/);
  });

  it("throws on an invalid status (no row should ever land with status='wat')", () => {
    expect(() => decomposeGoalPath("/goal/alice/wat/uuid.md")).toThrow(/Invalid goal status/);
  });

  it("throws when the leaf is missing .md", () => {
    expect(() => decomposeGoalPath("/goal/alice/opened/uuid")).toThrow(/must end with \.md/);
  });
});

describe("decomposeKpiPath", () => {
  it("extracts goal_id / kpi_id from a canonical path", () => {
    expect(decomposeKpiPath("/kpi/g-uuid/k-prs.md")).toEqual({
      goal_id: "g-uuid",
      kpi_id: "k-prs",
    });
  });

  it("handles the host-FS /memory/ prefix", () => {
    expect(decomposeKpiPath("/home/x/.deeplake/memory/kpi/g/k.md")).toEqual({
      goal_id: "g",
      kpi_id: "k",
    });
  });

  it("throws on non-kpi paths", () => {
    expect(() => decomposeKpiPath("/goal/o/opened/uuid.md")).toThrow(/Not a kpi path/);
    expect(() => decomposeKpiPath("/summaries/x.md")).toThrow(/Not a kpi path/);
  });

  it("throws when the leaf is missing .md", () => {
    expect(() => decomposeKpiPath("/kpi/g/k")).toThrow(/must end with \.md/);
  });
});

describe("compose round-trip", () => {
  it("composeGoalPath ↔ decomposeGoalPath is identity for valid parts", () => {
    const original = { owner: "alice@activeloop.ai", status: "in_progress" as const, goal_id: "u-1" };
    const p = composeGoalPath(original);
    expect(p).toBe("/goal/alice@activeloop.ai/in_progress/u-1.md");
    expect(decomposeGoalPath(p)).toEqual(original);
  });

  it("composeKpiPath ↔ decomposeKpiPath is identity", () => {
    const original = { goal_id: "g-1", kpi_id: "k-prs" };
    const p = composeKpiPath(original);
    expect(p).toBe("/kpi/g-1/k-prs.md");
    expect(decomposeKpiPath(p)).toEqual(original);
  });

  it("composed paths always classify as their kind", () => {
    expect(classifyPath(composeGoalPath({ owner: "x", status: "opened", goal_id: "u" }))).toBe("goal");
    expect(classifyPath(composeKpiPath({ goal_id: "g", kpi_id: "k" }))).toBe("kpi");
  });
});
