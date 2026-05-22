/**
 * Pure renderer for the SessionStart "local mined" surface — the text the
 * Claude Code hook appends to its model-visible `additionalContext` when
 * the user hasn't signed in but `hivemind skillify mine-local` has
 * produced at least one skill.
 *
 * MODEL-SAFE BY CONSTRUCTION: this output goes into the model's system
 * prompt, so it must contain only statically-authored copy. We do NOT
 * render the `insight` field here, even when a manifest entry has one:
 * `insight` originates from haiku's gate output and could be influenced
 * by adversarial session content (codex P1 prompt-injection finding).
 * The rich insight banner lives in `src/notifications/rules/local-mined.ts`
 * with `userVisibleOnly: true`, which keeps it on the user-visible
 * `systemMessage` channel only.
 *
 * Kept as a pure function (no fs reads, no env, no defaults) so unit
 * tests can drive both branches with synthetic inputs.
 */

export interface LocalMinedBannerInput {
  /** Total entries in the manifest (insight-bearing or not). */
  totalCount: number;
}

/**
 * Render the SessionStart "local mined" note. Returns an empty string
 * when there are no entries at all — the hook then emits no extra
 * block. When entries exist, renders a count-only line with a sign-in
 * CTA. The text is appended to the "Not logged in" warning block, so
 * it must lead with a newline gap.
 */
export function renderLocalMinedNote(input: LocalMinedBannerInput): string {
  const { totalCount } = input;
  if (totalCount <= 0) return "";
  const plural = totalCount === 1 ? "" : "s";
  return (
    `\n\n${totalCount} local skill${plural} from past 'hivemind skillify mine-local' run(s) live in ~/.claude/skills/. ` +
    `Run 'hivemind login' to start sharing new mining results with your team.`
  );
}
