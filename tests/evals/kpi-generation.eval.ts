import { describe, it, expect } from "vitest";
import { generateKpis } from "../../src/tasks/kpi-generator.js";

/**
 * Manual LLM eval suite — see tests/evals/README.md.
 *
 * Skipped under `npm test` (the default vitest discovery only picks
 * up `**\/*.test.ts`). Run with:
 *
 *   ANTHROPIC_API_KEY=sk-... npx vitest run tests/evals \
 *     --include 'tests/evals/**\/*.eval.ts'
 *
 * Pass criterion: "no catastrophic regressions" — each case prints
 * its KPIs and a minimal sanity assertion (1-3 KPIs returned, all
 * with positive integer targets, all with non-empty names/units).
 * Read the printed output and use judgment for prompt quality.
 *
 * Skipped automatically when ANTHROPIC_API_KEY is unset, so accidentally
 * including this file in a normal run doesn't fail or hit the network.
 */

const SKIP = !process.env.ANTHROPIC_API_KEY;
const maybe = SKIP ? describe.skip : describe;

interface EvalCase {
  name: string;
  text: string;
  /** Sanity bounds — too lax to catch quality regressions, just
   *  prevents obvious failure (e.g. zero KPIs returned). */
  expect: {
    minKpis: number;
    maxKpis: number;
    /** Loose substring hints; case-insensitive. At least one KPI's
     *  name should contain at least one of these. */
    nameHints?: string[];
  };
}

const CASES: EvalCase[] = [
  {
    name: "ship a feature",
    text: "Ship the new search bar on the dashboard, including loading state and empty state.",
    expect: { minKpis: 1, maxKpis: 3, nameHints: ["pr", "merge", "ship", "deploy", "feature", "search"] },
  },
  {
    name: "review N PRs",
    text: "Review 5 pull requests from the data team this week.",
    expect: { minKpis: 1, maxKpis: 3, nameHints: ["review", "pr", "approval"] },
  },
  {
    name: "investigate bug",
    text: "Investigate why the wiki-worker is timing out on 1% of session-ends.",
    expect: { minKpis: 1, maxKpis: 3, nameHints: ["investigation", "root cause", "report", "fix", "session"] },
  },
  {
    name: "write docs",
    text: "Write a getting-started guide for the new hivemind tasks CLI.",
    expect: { minKpis: 1, maxKpis: 3, nameHints: ["page", "section", "doc", "guide", "screenshot"] },
  },
  {
    name: "vague task",
    text: "Make things better.",
    // The model should still produce SOMETHING reasonable rather than
    // failing or returning gibberish. We accept anything 1-3.
    expect: { minKpis: 1, maxKpis: 3 },
  },
];

maybe("KPI generation eval (LIVE LLM)", () => {
  for (const c of CASES) {
    it(`generates 1-3 sensible KPIs for: ${c.name}`, async () => {
      const kpis = await generateKpis({ text: c.text });
      // Print so reviewer can eyeball quality
      console.log(`\n--- ${c.name} ---`);
      console.log(`task: ${c.text}`);
      for (const k of kpis) {
        console.log(`  ${k.name}: target=${k.target} ${k.unit} (id=${k.kpi_id})`);
      }
      expect(kpis.length).toBeGreaterThanOrEqual(c.expect.minKpis);
      expect(kpis.length).toBeLessThanOrEqual(c.expect.maxKpis);
      for (const k of kpis) {
        expect(k.name.length).toBeGreaterThan(0);
        expect(k.unit.length).toBeGreaterThan(0);
        expect(Number.isInteger(k.target) && k.target > 0).toBe(true);
      }
      if (c.expect.nameHints) {
        const hay = kpis.map(k => k.name.toLowerCase()).join(" ");
        const ok = c.expect.nameHints.some(h => hay.includes(h.toLowerCase()));
        if (!ok) {
          console.warn(`  ⚠ none of name hints matched: [${c.expect.nameHints.join(", ")}] vs "${hay}"`);
        }
        // Soft assertion: warn but don't fail; LLMs sometimes pick
        // synonyms outside the hint list.
      }
    }, 30_000);
  }
});
