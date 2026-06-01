# Capture Tasks — turning conversation tangents into Hivemind goals

**Status:** v1 implemented · **Owner:** Sasun · **Companion to:** "pick up where you left off" (resume-brief)

> **Decision (v1).** We did **not** build the auto-detection pipeline below (Stop-hook → LLM gate → dedup → confirm). Instead, capture is **explicit, user-initiated, and in-session**: the user says *"save this for later"* and the agent — which already holds the live context — writes the task as a goal then and there. Its sibling is the resume half: when the user says *"let's work on that task,"* the agent transfers the stored context back into the session and continues with no re-explaining.
>
> The whole feature is a **Save↔Resume context-transfer pair**, designed together: what Save stores is exactly what Resume hands back. Implemented as two operations in the `hivemind-goals` skill (all agent copies) plus two small CLI additions — `hivemind goal add --agent capture` (provenance) and `hivemind goal get <goal_id>` (full-body read for the transfer). No Stop-hook, gate, worker, confirm-flow, or new table. The auto-detection design below is preserved as **Later** (see Scope).

## Problem

Mid-session, a user often states a *new, unrelated* action — "oh, we should also fix the retry backoff", "remind me to email johg", "later we need to migrate the index". It's a real commitment, but it's a tangent from whatever the agent is doing right now, so it evaporates: the agent stays on the main thread, the session ends, the task is lost.

This is a stickiness lever, not an acquisition one. Hivemind's value is "nothing gets lost across sessions"; today that holds for the *main* thread (resume-brief) but not for the *side* threads a user throws out in passing. Capturing them:

- makes the memory measurably more useful (more reasons to keep it installed → W1→W2 stickiness, the leak the data points at);
- feeds the existing **goals** system, which already drives the SessionStart "📌 N goals open" banner and the context-block goals injection.

Non-goal: this is not a general TODO manager. It captures *agent-observed* commitments the user would otherwise drop.

## What "a task" means here

Reuse the existing **goals** primitive — there is no separate "tasks" concept (the legacy `hivemind tasks` CLI was folded into goals). A captured task is a goal row:

- table: `GOALS_COLUMNS` — `goal_id / owner / status / content / version / created_at / agent`
- VFS: `memory/goal/<owner>/<status>/<goal_id>.md`, `content` = markdown (first line = label)
- `agent` field distinguishes provenance — captured tasks should write `agent: "capture"` (vs `manual` / a CLI), so they're auditable and separable from hand-created goals.

## User flow (recommended: confirm-first)

```
[mid-session] user: "…and we should also add rate-limiting to the webhook handler, but not now."
                    ↓  (Stop hook, end of turn/session)
agent surfaces (user channel only):
  📝 Noticed a side task: "Add rate-limiting to the webhook handler"
     Save to Hivemind goals?  (reply: yes / no / edit)
                    ↓ user: "yes"
goal written → shows in next session's "📌 N goals open" banner + goals context block.
```

The capture is **proposed, not silent.** The user confirms (or edits/declines). This is the v1 stance — see the decision below.

## Mechanism

Reuse the **skillify mine pipeline** shape (`src/skillify/`), which already does exactly this class of work: read a session → run an LLM gate → dedup → write rows. The goal-capture pipeline mirrors it:

1. **Trigger** — a `Stop` hook (end of session/turn). Stop, not UserPromptSubmit: we want the full exchange, and we don't want to add latency to every prompt.
2. **Extract (LLM gate)** — feed the session (or the recent window) to a gated `claude -p` call, same as `gate-runner.ts`. Prompt: *extract explicit, actionable commitments the user stated that are **tangential** to the session's main thread; ignore the main task, ignore rhetorical/hypothetical statements.* Output: strict JSON `[{title, detail, confidence}]`.
3. **Dedup** — against open goals via the canonical `listOpenGoals` reader (same owner-matching used by the banner, so we never double-capture or collide on a `%user%` substring). Drop near-duplicates of existing goals.
4. **Confirm** — surface survivors `userVisibleOnly` (see safety) for yes / edit / no.
5. **Write** — on confirm, write a goal row (`agent: "capture"`) via the existing `commands/goal.ts` add path + VFS convention.

## The one real decision: auto vs confirm vs command

| Mode | Value | Risk | 
|---|---|---|
| **Command** (`/hivemind:capture-tasks`) | zero noise, zero risk | user must remember → most tasks still lost |
| **Auto** (Stop hook writes silently) | highest capture | pollutes goals with mis-detected / rhetorical items; hard to trust |
| **Confirm** (Stop hook proposes, user approves) | captures the value | one extra interaction; depends on detection quality |

**Recommendation: Confirm for v1.** It captures the value without polluting the goals table with false positives, and it's the cheapest way to *learn whether the detection is any good* before trusting it silently. If confirm-acceptance is consistently high, graduate to auto (with an undo) later.

## Detection: what counts as a "new/unrelated task"

The hard part, and the main source of noise. The gate must keep:
- explicit, actionable, **deferred** commitments ("we should also…", "remind me to…", "later we need to…", "TODO: …", "don't let me forget…");

and reject:
- the session's **main** work (already being done / will be resumed by resume-brief);
- hypotheticals, questions, opinions ("maybe we could…", "I wonder if…");
- things already tracked (dedup step).

"Tangential to the main thread" is the key filter — a task the agent is *about to do anyway* is not a capture; a task the user parks *for later* is. Bias toward **precision over recall**: a missed capture is invisible; a wrong capture erodes trust in the whole goals list.

## Safety (channel)

The proposal and the captured `content` are derived from conversation — same untrusted-content class as summaries. So:
- the confirm prompt is **user-facing only** (terminal), never the model's `additionalContext`, consistent with the resume-brief / banner channel rules;
- captured goal content is data, not instructions — when later surfaced (banner / context block) it's already treated as user-facing.

No new injection surface: capture writes to the goals table; goals already render `userVisibleOnly`.

## Failure modes / noise control

- **Over-capture** → the goals list becomes noise and people stop trusting it. Mitigate: confirm-first, precision-biased gate, per-session cap (e.g. ≤3 proposed).
- **Duplicate capture** across sessions → dedup via `listOpenGoals` (canonical owner match), and skip if a near-identical open goal exists.
- **Latency** → Stop hook runs the gate out of band (spawned worker, like skillify's `spawn-mine-local-worker`), never blocking the session.
- **Wrong owner / workspace** → goals are owner- and workspace-scoped; reuse the same scoping as the goals banner so captures land where the user will see them.

## Scope

**v1 (shipped) — explicit Save↔Resume context-transfer**
- **Save:** on "save this for later", the agent writes a goal whose body is a resumable *context package* (`<label>` + `Start here / Files / Branch / Run / Why`) via `hivemind goal add --agent capture "<package>"`. `agent:"capture"` keeps parked side-tasks separable from hand-made goals.
- **Resume:** on "let's work on that task", the agent finds the goal, pulls the full body with `hivemind goal get <goal_id>`, flips it to `in_progress`, and continues from `Start here:` — automatic context transfer, no re-explaining.
- Implemented in the `hivemind-goals` skill (claude-code / codex / hermes / openclaw copies) + `src/commands/goal.ts` (`--agent` flag, `goal get`). Reuses the existing goals primitive — no separate task store, no new table.

**Later (the auto-detection design above)**
- Stop-hook → LLM gate → dedup → confirm → write, to catch tangents the user *forgets* to park. Gated behind proving demand for explicit capture first.
- Auto-capture with undo, once confirm-acceptance proves detection quality.
- Mid-session capture (UserPromptSubmit) for "remind me" said in the moment.
- Link a captured task back to the session summary that spawned it (provenance for resume).

## Open questions

1. **Trigger granularity** — Stop (per session) is the v1 call. Is per-turn ever worth it for explicit "remind me right now"? (Probably a later UserPromptSubmit path.)
2. **Acceptance metric** — track confirm yes/no rate to decide if/when to graduate to auto. Where does that get logged?
3. **Edit flow** — "edit" before save: free-text re-prompt, or just let the user restate? v1 could keep it to yes/no and let the user create manually if they want to tweak.
4. **Cross-project tasks** — a task stated in repo A that's really about repo B. v1: attribute to current project; revisit if it matters.
