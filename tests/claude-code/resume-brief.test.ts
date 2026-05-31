import { describe, it, expect } from "vitest";
import { firstProseSentence } from "../../src/notifications/sources/resume-brief.js";

// Fixture mirrors the real wiki-summary shape: `# Session <uuid>` title, a
// `- **Key**: value` metadata block, a `## What Happened` header, then the
// prose narrative, then `## People` / `## Entities` `**Label**` rows.
const REAL_SHAPE = `# Session 00ea4740-6969-4922-a9ee-600d939abc49
- **Source**: /sessions/kamo/kamo_activeloop_hivemind_00ea4740.jsonl
- **Started**: 2026-04-10T22:40:02.632Z
- **Project**: al-projects
- **JSONL offset**: 368

## What Happened
Multi-day sprint across deeplake-claude-code-plugins and hivemind repos. Fixed latency by making async hooks, debugged module.json type issues. Current version: 0.6.25.

## People
**Kamo** — user/developer — directed work across two repos
`;

describe("firstProseSentence", () => {
  it("skips title, metadata bullets, and section headers; returns the first prose sentence", () => {
    expect(firstProseSentence(REAL_SHAPE)).toBe(
      "Multi-day sprint across deeplake-claude-code-plugins and hivemind repos.",
    );
  });

  it("does not truncate at mid-token dots (module.json, v0.6.25)", () => {
    const s = "## What Happened\nTouched module.json and shipped v0.6.25 today. Next bit.";
    // The cut must land on the sentence-ending period (after 'today.'),
    // not the dots inside module.json / v0.6.25.
    expect(firstProseSentence(s)).toBe("Touched module.json and shipped v0.6.25 today.");
  });

  it("skips **Label** rows so a People/Entities-only body yields nothing", () => {
    const s = "## People\n**Kamo** — developer\n**Emanuele** — colleague";
    expect(firstProseSentence(s)).toBe("");
  });

  it("returns '' for a boilerplate-only summary (no prose)", () => {
    const s = "# Session abc\n- **Project**: x\n- **Started**: 2026-01-01";
    expect(firstProseSentence(s)).toBe("");
  });

  it("falls back to the whole prose line when it has no sentence punctuation", () => {
    const s = "## What Happened\nrefactor the deeplog stage layer";
    expect(firstProseSentence(s)).toBe("refactor the deeplog stage layer");
  });
});
