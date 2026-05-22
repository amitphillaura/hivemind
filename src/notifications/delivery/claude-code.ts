/**
 * Claude Code SessionStart-hook delivery. Empirically validated against
 * Claude Code 2.1.131 with a multi-channel probe (see AGENT_CHANNELS.md):
 *
 *   - `systemMessage` at the JSON TOP LEVEL — surfaces in the terminal as
 *     `SessionStart:startup says: <text>`. This is the user-visible channel.
 *   - `hookSpecificOutput.additionalContext` (nested) — surfaces to the model
 *     as a `<system-reminder>` block. This is the model-visible channel.
 *   - `process.stderr.write` — captured by the harness as of 2.1.0+ but no
 *     longer rendered to the user. Don't rely on it.
 *
 * Two important nesting rules established empirically:
 *   - systemMessage MUST be top-level, not inside hookSpecificOutput. When
 *     nested, the harness silently drops it.
 *   - additionalContext from a SECOND SessionStart hook command IS delivered
 *     to the model alongside the first hook's additionalContext (they arrive
 *     in an attachment array). Earlier reports of dropped second-hook stdout
 *     (issue #13650) appear resolved in 2.1.x.
 *
 * Channel split (codex P1 prompt-injection finding):
 *   Notifications can opt into user-visible-only delivery by setting
 *   `userVisibleOnly: true`. The renderer emits the user-visible block
 *   (which carries LLM-derived prose) ONLY to `systemMessage`; the
 *   model-visible `additionalContext` carries the subset of notifications
 *   whose bodies are statically authored and safe to feed back into the
 *   model's system prompt. Without this split, an insight derived from
 *   adversarial session content could prompt-inject the next session.
 *
 * Cap: 10,000 chars per channel (per CC docs). renderNotifications output
 * stays well under that for v1 content.
 */

import type { Notification } from "../types.js";
import { renderNotifications } from "../format.js";

export function emitClaudeCode(notifications: Notification[]): void {
  // The empty-array short-circuit lives in delivery/index.ts:emit;
  // adapters are guaranteed to receive at least one notification.
  // Rendering an empty list still produces "", which the ternary
  // below handles, but the dispatcher guard keeps the contract
  // explicit and the coverage matrix tight.
  const modelSafe = notifications.filter(n => !n.userVisibleOnly);
  const modelRendered = renderNotifications(modelSafe);
  const userRendered = renderNotifications(notifications);

  // Omit additionalContext entirely when every notification in the
  // batch is user-only — there's nothing safe to send to the model.
  // Claude Code accepts a missing additionalContext field gracefully.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      ...(modelRendered ? { additionalContext: modelRendered } : {}),
    },
    systemMessage: userRendered,
  }));
}
