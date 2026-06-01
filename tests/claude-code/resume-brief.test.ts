import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

// Mock the network + environment boundary so pickResumeBrief's orchestration
// (query shape, dedup/placeholder windowing, the three outcomes, relative age)
// is testable offline — same approach as cli-goal.test.ts.
const queryMock = vi.fn();
vi.mock("../../src/config.js", () => ({ loadConfig: vi.fn(() => ({ tableName: "memory" })) }));
vi.mock("../../src/utils/project-name.js", () => ({ projectNameFromCwd: vi.fn(() => "proj") }));
vi.mock("../../src/deeplake-api.js", () => ({
  DeeplakeApi: class {
    constructor() { /* creds ignored under test */ }
    query(sql: string) { return queryMock(sql); }
  },
}));

import {
  extractNextSteps,
  isPlaceholderSummary,
  selectRealSummaries,
  pickResumeBrief,
} from "../../src/notifications/sources/resume-brief.js";
import { loadConfig } from "../../src/config.js";
import { projectNameFromCwd } from "../../src/utils/project-name.js";

const loadConfigMock = loadConfig as unknown as ReturnType<typeof vi.fn>;
const projectMock = projectNameFromCwd as unknown as ReturnType<typeof vi.fn>;
const CREDS = { token: "t", userName: "u", orgId: "o", workspaceId: "w", apiUrl: "https://api" } as never;

// Fixture mirrors the wiki-summary shape: `# Session` title, metadata, then
// the ## sections including the new `## Next Steps`.
function summary(opts: { next?: string; open?: string; whatHappened?: string } = {}): string {
  let s = `# Session abc\n- **Project**: indra\n\n## What Happened\n${opts.whatHappened ?? "Did stuff."}\n`;
  if (opts.open !== undefined) s += `\n## Open Questions / TODO\n${opts.open}\n`;
  if (opts.next !== undefined) s += `\n## Next Steps\n${opts.next}\n`;
  return s;
}

describe("extractNextSteps", () => {
  it("prefers the ## Next Steps section", () => {
    const s = summary({ next: "Wire the resume fallback and run tests", open: "- something else" });
    expect(extractNextSteps(s)).toBe("Wire the resume fallback and run tests");
  });

  it("falls back to ## Open Questions / TODO when Next Steps is absent (older summaries)", () => {
    const s = summary({ open: "- Verify the header parse on Windows" });
    expect(extractNextSteps(s)).toBe("Verify the header parse on Windows");
  });

  it("strips a leading bullet marker", () => {
    expect(extractNextSteps(summary({ next: "- Ship the PR" }))).toBe("Ship the PR");
  });

  it("treats an explicit 'none' Next Steps as wrapped-clean (empty)", () => {
    expect(extractNextSteps(summary({ next: "none" }))).toBe("");
    expect(extractNextSteps(summary({ next: "None." }))).toBe("");
    expect(extractNextSteps(summary({ next: "N/A" }))).toBe("");
  });

  it("returns '' when neither section is present", () => {
    expect(extractNextSteps(summary({ whatHappened: "Just chatted." }))).toBe("");
  });

  it("falls back to a bare ## Open Questions heading (no '/ TODO')", () => {
    const s = "# Session x\n## What Happened\nstuff\n\n## Open Questions\n- Check the Windows path\n";
    expect(extractNextSteps(s)).toBe("Check the Windows path");
  });

  it("treats a present-but-blank ## Next Steps as wrapped-clean — does NOT fall back to a stale TODO", () => {
    // New-format summary: the heading exists but the worker wrote no body.
    // Next Steps is authoritative when present, so this must resolve to "" even
    // though there's a stale Open Questions / TODO underneath.
    const s = summary({ next: "", open: "- stale: re-run the old migration" });
    expect(extractNextSteps(s)).toBe("");
  });

  it("still falls back to ## Open Questions / TODO only when ## Next Steps is absent", () => {
    const s = summary({ open: "- Verify header parse on Windows" }); // no Next Steps section at all
    expect(extractNextSteps(s)).toBe("Verify header parse on Windows");
  });

  it("returns '' for an empty section body", () => {
    expect(extractNextSteps(summary({ next: "" }))).toBe("");
  });

  it("returns '' when the section body is only an empty bullet marker", () => {
    // body is non-empty ("-") but every line strips to nothing → fall through
    expect(extractNextSteps(summary({ next: "-" }))).toBe("");
  });

  it("takes the first real line of a multi-line section", () => {
    expect(extractNextSteps(summary({ next: "Finish the migration\nThen write docs" })))
      .toBe("Finish the migration");
  });
});

// A SessionStart placeholder: metadata skeleton, no `## ` content section
// (the real shape that was shadowing summaries in prod).
const PLACEHOLDER =
  "# Session d3c21026\n- **Source**: /sessions/sasun/x.jsonl\n- **Started**: 2026-05-31T17:09:02.539Z\n- **Project**: hivemind\n- **Status**: in-progress\n";

describe("isPlaceholderSummary", () => {
  it("flags a SessionStart skeleton (no ## section)", () => {
    expect(isPlaceholderSummary(PLACEHOLDER)).toBe(true);
  });
  it("does not flag a real summary with ## sections", () => {
    expect(isPlaceholderSummary(summary({ open: "- do the thing" }))).toBe(false);
  });
});

describe("selectRealSummaries (windowing)", () => {
  it("skips placeholders so the walk-back reaches the real summary underneath", () => {
    const real = summary({ open: "- Re-run CI on f89e70e" });
    const rows = [
      { summary: PLACEHOLDER, path: "/s/new.md", last_update_date: "2026-06-01" },
      { summary: PLACEHOLDER, path: "/s/new2.md", last_update_date: "2026-05-31" },
      { summary: real, path: "/s/real.md", last_update_date: "2026-05-27" },
    ];
    const reals = selectRealSummaries(rows);
    expect(reals).toHaveLength(1);
    expect(extractNextSteps(reals[0].summary)).toBe("Re-run CI on f89e70e");
    expect(reals[0].date).toBe("2026-05-27");
  });

  it("dedups duplicate rows for the same session by path", () => {
    const real = summary({ open: "- ship it" });
    const rows = [
      { summary: real, path: "/s/a.md", last_update_date: "2026-05-27" },
      { summary: real, path: "/s/a.md", last_update_date: "2026-05-27" }, // duplicate
    ];
    expect(selectRealSummaries(rows)).toHaveLength(1);
  });

  it("tolerates rows with no path (can't dedup) and no summary (treated as placeholder)", () => {
    const real = summary({ open: "- do it" });
    const rows = [
      { summary: real, last_update_date: "2026-05-27" },           // no path
      { last_update_date: "2026-05-26" },                          // no summary → placeholder, skipped
      { summary: real, last_update_date: "2026-05-25" },           // no path
    ];
    expect(selectRealSummaries(rows)).toHaveLength(2);
  });

  it("returns nothing when every row is a placeholder (caller renders plain welcome, not 'wrapped clean')", () => {
    const rows = [
      { summary: PLACEHOLDER, path: "/s/1.md", last_update_date: "2026-06-01" },
      { summary: PLACEHOLDER, path: "/s/2.md", last_update_date: "2026-05-31" },
    ];
    expect(selectRealSummaries(rows)).toEqual([]);
  });

  it("caps at the lookback after filtering", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      summary: summary({ open: `- task ${i}` }),
      path: `/s/${i}.md`,
      last_update_date: `2026-05-${20 + i}`,
    }));
    expect(selectRealSummaries(rows, 5)).toHaveLength(5);
  });
});

describe("pickResumeBrief", () => {
  const real = (next: string) => `# Session x\n## What Happened\nstuff\n\n## Next Steps\n${next}\n`;
  const placeholder = "# Session x\n- **Status**: in-progress\n";

  beforeEach(() => {
    queryMock.mockReset().mockResolvedValue([]);
    loadConfigMock.mockReset().mockReturnValue({ tableName: "memory" });
    projectMock.mockReset().mockReturnValue("proj");
  });
  afterEach(() => { vi.useRealTimers(); });

  it("returns null without usable creds — the gate, no query issued", async () => {
    expect(await pickResumeBrief(null)).toBeNull();
    expect(await pickResumeBrief({ token: "", userName: "u", orgId: "o" } as never)).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns null when the cwd resolves to no project", async () => {
    projectMock.mockReturnValue("");
    expect(await pickResumeBrief(CREDS)).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns null on an invalid table identifier (never queries)", async () => {
    loadConfigMock.mockReturnValue({ tableName: "bad name!" });
    expect(await pickResumeBrief(CREDS)).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("scopes the query to project + author, newest-first", async () => {
    queryMock.mockResolvedValue([{ summary: real("Ship it"), path: "/s/a.md", last_update_date: "2026-05-30" }]);
    await pickResumeBrief(CREDS);
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("project = 'proj'");
    expect(sql).toContain("author = 'u'");
    expect(sql).toContain("ORDER BY last_update_date DESC");
  });

  it("outcome 3 — no summaries at all → null (plain welcome)", async () => {
    queryMock.mockResolvedValue([]);
    expect(await pickResumeBrief(CREDS)).toBeNull();
  });

  it("only placeholders → null (must NOT claim 'wrapped clean')", async () => {
    queryMock.mockResolvedValue([
      { summary: placeholder, path: "/s/1.md", last_update_date: "2026-06-01" },
      { summary: placeholder, path: "/s/2.md", last_update_date: "2026-05-31" },
    ]);
    expect(await pickResumeBrief(CREDS)).toBeNull();
  });

  it("outcome 1 — surfaces the next step from the most recent real summary, skipping a newer placeholder", async () => {
    queryMock.mockResolvedValue([
      { summary: placeholder, path: "/s/new.md", last_update_date: "2026-06-01" },
      { summary: real("Wire the fallback and run tests"), path: "/s/real.md", last_update_date: "2026-05-30" },
    ]);
    const b = await pickResumeBrief(CREDS);
    expect(b?.brief).toContain("Picking up on proj");
    expect(b?.brief).toContain("you left off here");
    expect(b?.brief).toContain("Wire the fallback and run tests");
  });

  it("outcome 2 — real summaries but every one wrapped clean → no CTA", async () => {
    queryMock.mockResolvedValue([
      { summary: real("none"), path: "/s/a.md", last_update_date: "2026-05-30" },
    ]);
    const b = await pickResumeBrief(CREDS);
    expect(b?.brief).toContain("wrapped up clean, nothing pending");
    expect(b?.brief).not.toContain("you left off here");
  });

  it("truncates a long next-step line to one terminal row", async () => {
    queryMock.mockResolvedValue([{ summary: real("Do " + "x".repeat(200)), path: "/s/a.md", last_update_date: "2026-05-30" }]);
    const b = await pickResumeBrief(CREDS);
    expect(b!.brief).toContain("…");
  });

  it("returns null when the query throws (withTimeout swallows to the null fallback)", async () => {
    queryMock.mockRejectedValue(new Error("net down"));
    expect(await pickResumeBrief(CREDS)).toBeNull();
  });

  it("returns null if anything in the body throws (outer guard)", async () => {
    loadConfigMock.mockImplementation(() => { throw new Error("boom"); });
    expect(await pickResumeBrief(CREDS)).toBeNull();
  });

  it("truncates a long next step on a word boundary, not mid-word", async () => {
    const longSpaced = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" "); // >120 chars, spaces throughout
    queryMock.mockResolvedValue([{ summary: real(longSpaced), path: "/s/a.md", last_update_date: "2026-05-30" }]);
    const b = await pickResumeBrief(CREDS);
    expect(b!.brief).toMatch(/word\d+…/); // cut at a space then ellipsis
  });

  it("drops the age clause when the date is missing or unparseable", async () => {
    // missing date → relativeAge sees undefined
    queryMock.mockResolvedValue([{ summary: real("Resume A"), path: "/s/a.md" }]);
    let b = await pickResumeBrief(CREDS);
    expect(b?.brief).toContain("Picking up on proj — you left off here");
    expect(b?.brief).not.toContain("(");
    // unparseable date → relativeAge sees NaN
    queryMock.mockResolvedValue([{ summary: real("Resume B"), path: "/s/b.md", last_update_date: "not-a-date" }]);
    b = await pickResumeBrief(CREDS);
    expect(b?.brief).toContain("you left off here");
    expect(b?.brief).not.toContain("(");
  });

  it("renders each relative-age bucket", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00Z"));
    const cases: Array<[string, string]> = [
      ["2026-06-01T06:00:00Z", "earlier today"],
      ["2026-05-31T12:00:00Z", "yesterday"],
      ["2026-05-29T12:00:00Z", "3 days ago"],
      ["2026-05-22T12:00:00Z", "last week"],
      ["2026-05-11T12:00:00Z", "weeks ago"],
    ];
    for (const [date, expected] of cases) {
      queryMock.mockResolvedValue([{ summary: real("Resume X"), path: "/s/a.md", last_update_date: date }]);
      const b = await pickResumeBrief(CREDS);
      expect(b?.brief).toContain(expected);
    }
  });
});
