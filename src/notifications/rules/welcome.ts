/**
 * The one v1 rule. Fires on the first session after a fresh login (each time
 * `creds.savedAt` differs from the savedAt we recorded last time we showed
 * welcome). Dedup'd via state — exactly once per re-login.
 */

import type { Rule } from "../types.js";

export const welcomeRule: Rule = {
  id: "welcome",
  trigger: "session_start",
  evaluate({ creds }) {
    if (!creds?.token) return null;
    // Personalization is optional. If creds.userName is missing (malformed
    // credentials.json — rare), drop the comma-clause rather than fall back
    // to a generic "there" that reads awkwardly. If creds.orgName is missing,
    // say "your organization" rather than expose the orgId UUID — UUIDs are
    // unreadable to humans and worse UX than the original "undefined" leak.
    const title = creds.userName
      ? `Welcome back, ${creds.userName}`
      : "Welcome back";
    const orgPhrase = creds.orgName ? `org ${creds.orgName}` : "your organization";
    const workspace = creds.workspaceId ?? "default";
    return {
      id: "welcome",
      severity: "info",
      title,
      body: `Connected to ${orgPhrase} (workspace ${workspace}).`,
      dedupKey: { savedAt: creds.savedAt },
    };
  },
};
