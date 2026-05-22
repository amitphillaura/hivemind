/**
 * Unit tests for src/skillify/local-mined-banner.ts — the model-safe
 * count renderer consumed by the Claude Code SessionStart hook's
 * `additionalContext`.
 *
 * IMPORTANT: renderLocalMinedNote is deliberately count-only. The rich
 * concrete-insight banner is delivered exclusively on the user-visible
 * `systemMessage` channel by the notifications rule; LLM-derived
 * insight prose must never reach the model-visible additionalContext
 * to avoid a self-prompt-injection path (codex P1). These tests
 * encode that invariant.
 */

import { describe, it, expect } from "vitest";
import { renderLocalMinedNote } from "../../src/skillify/local-mined-banner.js";

describe("renderLocalMinedNote (model-safe count surface)", () => {
  it("returns empty string when no entries exist", () => {
    // No banner at all when nothing's been mined — the surrounding hook
    // would otherwise emit an unhelpful "0 skills" line.
    expect(renderLocalMinedNote({ totalCount: 0 })).toBe("");
  });

  it("renders the legacy count surface with the sign-in CTA", () => {
    const out = renderLocalMinedNote({ totalCount: 5 });
    expect(out).toContain("5 local skills from past 'hivemind skillify mine-local'");
    expect(out).toContain("hivemind login");
  });

  it("uses singular noun for exactly one entry", () => {
    const out = renderLocalMinedNote({ totalCount: 1 });
    expect(out).toContain("1 local skill from past");
    expect(out).not.toContain("1 local skills");
  });

  it("starts with a blank-line separator so it appends cleanly to the warning block", () => {
    // The hook appends this to a "Not logged in" line — without the
    // leading "\n\n" the banner glues onto the warning sentence and
    // becomes unreadable.
    const out = renderLocalMinedNote({ totalCount: 1 });
    expect(out.startsWith("\n\n")).toBe(true);
  });

  it("MUST NOT mention any insight content (security invariant)", () => {
    // Regression guard for codex P1: this function is consumed by
    // session-start.js → additionalContext (model-visible). It must
    // never include LLM-derived prose, skill names from gate output,
    // or anything else that could carry adversarial content. The
    // signature was explicitly narrowed to drop the insightEntry
    // parameter — assert the rendered output never trips known
    // insight-branch markers either.
    const out = renderLocalMinedNote({ totalCount: 7 });
    expect(out).not.toContain("found a pattern");
    expect(out).not.toContain("📌");
    expect(out).not.toContain("✨");
    expect(out).not.toContain("Minted skill");
    expect(out).not.toContain("claude -p");
  });
});
