---
name: hivemind-goals
description: Create, track, and read team goals + KPIs via Hivemind from openclaw. Use whenever the user mentions a goal, objective, KPI, target, milestone, or asks to track progress on something measurable. ALSO use when the user says "task", "todo", "work item", "remind me to", "fix X", or any actionable work item — the goal system replaced the legacy `hivemind tasks` CLI and now covers both objectives and tasks.
allowed-tools: hivemind_search, hivemind_read, hivemind_index, hivemind_goal_add, hivemind_kpi_add
---

# Hivemind Goals (openclaw)

OpenClaw exposes purpose-built tools for goals + KPIs. Use them directly — do NOT try to write files via the host filesystem.

## Tools

- `hivemind_goal_add({ text })` — create a new goal. Returns `goal_id` (UUID). Status starts at `opened`.
- `hivemind_kpi_add({ goal_id, kpi_id, target, unit, name? })` — add a KPI to an existing goal. Only call when the user explicitly asks for KPIs; do NOT auto-generate.
- `hivemind_search({ query })` — search Hivemind shared memory (summaries + sessions). Use this when the user asks "what's already there" before creating a duplicate.
- `hivemind_read({ path })` — read the full content of a specific Hivemind path.
- `hivemind_index({})` — list everything in memory.

## Workflow when the user expresses a goal

1. (Optional) `hivemind_search` first to surface any existing related goal.
2. `hivemind_goal_add({ text: "<short description>" })` — capture the returned `goal_id`.
3. ONLY if the user asks for KPIs: `hivemind_kpi_add` once per KPI with `goal_id` + `kpi_id` (short slug like `k-prs`) + `target` (positive int) + `unit`.
4. Confirm to the user with the goal_id and that the goal is team-visible.

## What NOT to do

- Do NOT write files anywhere under `~/.deeplake/memory/`. OpenClaw's runtime does not route filesystem writes to the Deeplake tables — only the `hivemind_*` tools above do.
- Do NOT call `hivemind_kpi_add` unsolicited. Wait for the user to ask.
- Do NOT use `hivemind_search` to *create* anything — it's read-only.
