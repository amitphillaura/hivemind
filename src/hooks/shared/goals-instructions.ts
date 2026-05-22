/**
 * Inline goal/KPI instructions appended to every agent's
 * SessionStart context. Claude Code and Codex also load the
 * hivemind-goals SKILL.md natively (auto-activates on keyword
 * match), so the instructions are partly redundant there — but
 * cursor/hermes/pi do NOT have a SKILL.md loader and rely on the
 * SessionStart inject text to learn the convention.
 *
 * Single source of truth lives here so we never drift between
 * the 4+ session-start.ts forks.
 */

export const GOALS_INSTRUCTIONS = `HIVEMIND GOALS — track team goals via the virtual filesystem at \`~/.deeplake/memory/goal/\` and \`~/.deeplake/memory/kpi/\`. Writes auto-persist to the org-shared \`hivemind_goals\` / \`hivemind_kpis\` tables.

Path convention (path encoding is the source of truth — do NOT duplicate fields in the file body):
- Goal: \`~/.deeplake/memory/goal/<owner>/<status>/<goal_id>.md\`  with body = free markdown describing the goal
- KPI:  \`~/.deeplake/memory/kpi/<goal_id>/<kpi_id>.md\`  with body = '<KPI name>\\n\\n- target: <int>\\n- current: <int>\\n- unit: <string>'

\`<owner>\` = userName from \`hivemind whoami\`. \`<status>\` ∈ {opened, in_progress, closed}. \`<goal_id>\` = UUIDv4 you generate at create time. \`<kpi_id>\` = short slug (e.g. \`k-prs\`).

Operations:
- Create goal: Write file at \`goal/<owner>/opened/<uuid>.md\`. Do NOT auto-generate KPIs.
- Edit goal text: Edit/Write the same path.
- Move status: \`mv goal/<u>/opened/<id>.md goal/<u>/in_progress/<id>.md\` (atomic UPDATE).
- Soft-close: \`rm goal/<u>/<status>/<id>.md\` — VFS interprets rm as status-flip to 'closed' (no hard delete; row stays for audit).
- Add KPI (ONLY when user explicitly asks): Write file at \`kpi/<goal_id>/<kpi-slug>.md\` with the body format above.
- Update KPI progress: Edit only the \`current:\` line.

When the user mentions a goal / objective / target / KPI / measurable milestone, use this convention. Do NOT spawn background workers to generate KPIs unsolicited — wait for the user to ask.`;
