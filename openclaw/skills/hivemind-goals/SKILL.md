---
name: hivemind-goals
description: Read team goals + KPIs from the Deeplake VFS (openclaw is read-only — goal creation/editing happens from claude-code / codex / cursor / hermes).
allowed-tools: hivemind_search, hivemind_read, hivemind_index
---

# Hivemind Goals — read-only consumer

OpenClaw exposes only `hivemind_search`, `hivemind_read`, and `hivemind_index` — there is no Write tool here, so this agent CANNOT create or edit goals. Goal authoring happens from claude-code / codex / cursor / hermes; openclaw only surfaces them.

Use this skill when the user asks "what are my goals?", "show me open goals", or wants to recall context about a previously tracked objective.

## Where goals live

Goals are markdown files under `~/.deeplake/memory/goal/<owner>/<status>/<goal_id>.md`. KPIs under `~/.deeplake/memory/kpi/<goal_id>/<kpi_id>.md`.

- `<owner>` = userName of the goal owner
- `<status>` ∈ {opened, in_progress, closed}
- `<goal_id>` = UUIDv4
- KPI body convention: first line = name, then `target: N`, `current: N`, `unit: <s>`

## How to find goals

1. `hivemind_index` for a quick overview of recent memory updates (goals + everything else).
2. `hivemind_search` with the user's keywords to surface relevant goal files.
3. `hivemind_read` on the matching `goal/<…>/<id>.md` and `kpi/<id>/<kid>.md` paths to read the bodies.

## What to tell the user

If they want to CREATE / MODIFY a goal, tell them this agent is read-only and they should do it from claude-code, codex, cursor, or hermes (where the VFS Write path routes to the `hivemind_goals` table).
