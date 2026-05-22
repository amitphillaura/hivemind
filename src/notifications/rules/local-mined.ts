/**
 * Surfaces locally-mined skills to fresh, not-signed-in users — the
 * user-visible half of the "wow effect" pair. The not-logged-in branch of
 * session-start.ts already injects the same content into `additionalContext`
 * so the MODEL sees it; this rule turns it into a `systemMessage` so the
 * USER sees it in their terminal too, exactly like the welcome line shown
 * right after `hivemind login`.
 *
 * Two branches:
 *   1. A recent manifest entry carries an `insight` string → render the
 *      concrete-insight banner (the gate's quantified finding + the
 *      minted skill name + sign-in CTA). This is the conversion surface —
 *      a real pattern from the user's own work, not an abstract count.
 *   2. No insight available (legacy manifest, gate didn't emit one) →
 *      fall back to the legacy "🎉 N skills mined" copy. Behavior on
 *      pre-insight manifests is unchanged.
 *
 * Suppression: stays silent once creds are present (logged-in users see
 * the welcome rule instead) or when the manifest is absent / empty.
 *
 * Dedup: insight branch keys on skill_name + created_at so a new insight
 * refires next session; count branch keys on the integer count so an
 * incrementing N refires too.
 */

import type { Rule } from "../types.js";

/**
 * Maximum length for the rendered insight line. Picked empirically:
 * ~90 chars fits two terminal-line-wraps at typical widths, which keeps
 * the banner compact. Long gate outputs (haiku tends to over-explain)
 * get cut at a word boundary with an ellipsis so the cut doesn't land
 * mid-word.
 */
const MAX_INSIGHT_CHARS = 90;

function truncateInsight(raw: string): string {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (cleaned.length <= MAX_INSIGHT_CHARS) return cleaned;
  const slice = cleaned.slice(0, MAX_INSIGHT_CHARS - 1);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > MAX_INSIGHT_CHARS / 2 ? lastSpace : MAX_INSIGHT_CHARS - 1;
  return slice.slice(0, cut).trimEnd() + "…";
}

export const localMinedRule: Rule = {
  id: "local-mined-surfaced",
  trigger: "session_start",
  evaluate({ creds, localSkillsCount, latestInsightEntry }) {
    if (creds?.token) return null;
    if (typeof localSkillsCount !== "number" || localSkillsCount <= 0) return null;

    // Concrete-insight branch — the surface the install→signup-conversion
    // play is built around. Only fires when the manifest has an entry
    // whose insight is non-empty (getLatestInsightEntry already filters
    // empty/whitespace, but the rule double-checks since a malformed
    // entry could slip a non-string through at the type-system boundary).
    const insight = typeof latestInsightEntry?.insight === "string"
      ? latestInsightEntry.insight.trim()
      : "";
    if (latestInsightEntry && insight.length > 0) {
      const name = latestInsightEntry.skill_name;
      // Three indented, emoji-prefixed lines: what we found, the artifact,
      // the action. Each line is independently scannable so the user
      // doesn't have to read prose to extract the takeaway. format.ts
      // prepends 🐝 to the title; the title itself stays icon-free.
      return {
        id: "local-mined-surfaced",
        severity: "info",
        title: `Hivemind found a pattern in your past sessions`,
        body:
          `   📌 ${truncateInsight(insight)}\n` +
          `   ✨ Skill \`${name}\` ready to catch it next time\n` +
          `   🔐 Run \`hivemind login\` to share with your team`,
        // Dedup on the entry's identity so a new insight refires next
        // session, while a re-run with the same entry still dedupes.
        dedupKey: { skill_name: name, created_at: latestInsightEntry.created_at },
        // The body carries LLM-derived insight prose: keep it OUT of
        // the model-visible additionalContext channel. Without this
        // flag, an adversarial session could influence haiku into
        // emitting imperative text that prompt-injects future sessions
        // (codex P1). The user still sees this notification in their
        // terminal via systemMessage; the model just doesn't.
        userVisibleOnly: true,
      };
    }

    // Fallback — legacy "N skills mined" copy. Preserves the existing
    // user experience for manifests written before the insight field
    // landed, and for users whose gate calls didn't produce an insight.
    const noun = localSkillsCount === 1 ? "skill" : "skills";
    return {
      id: "local-mined-surfaced",
      severity: "info",
      title: `🎉 ${localSkillsCount} ${noun} mined from your local sessions`,
      body: `Run 'hivemind login' to share new mining results with your team.`,
      dedupKey: { count: localSkillsCount },
    };
  },
};
