# Per-agent SessionStart delivery channels

Research notes on each agent's harness behavior — what stdout / stderr / JSON shapes get rendered to the user vs the model. The findings below come from source-level reading + multi-channel probes (`probe/probe-*.js`), not just config-shape inspection.

## Current implementation status

**Only Claude Code has a real delivery adapter.** Other agents will be added one at a time as we expand based on usage:

| Agent | Adapter shipped? | Roadmap order |
|---|---|---|
| Claude Code | ✅ `delivery/claude-code.ts` (dual-channel: `systemMessage` + `additionalContext`) | shipped |
| openclaw | ❌ — | next |
| Codex | ❌ — | TBD |
| Cursor | ❌ — | TBD |
| Hermes | ❌ — | TBD |
| Pi | ❌ — no SessionStart hook upstream | TBD |

When a new adapter lands: add the agent string to the `Agent` union in `types.ts`, create `delivery/<agent>.ts`, wire it into the dispatch table in `delivery/index.ts`. The notes below tell you exactly what shape each agent's harness needs.

## TL;DR — per-agent harness behavior

| Agent | Multi-hook → distinct context blocks? | Stderr → user? | Recommended delivery shape |
|---|---|---|---|
| **Claude Code** | ✅ YES — additionalContext from each hook collected into an array | ❌ stderr captured but NOT rendered as of CC 2.1.131 — use `systemMessage` instead | dual-channel JSON: top-level `systemMessage` (user-visible: renders as `SessionStart:startup says: <text>`) + nested `hookSpecificOutput.additionalContext` (model-visible) |
| **Codex** | ❌ NO — flattened `Vec<String>`, joined with `\n\n` downstream | ❌ NO — discarded | inline-append into existing session-start.js with a clear divider section |
| **Hermes** | ❌ NO — `on_session_start` return value DISCARDED entirely at `run_agent.py:9777-9786` | ❌ NO — captured to `logger.debug` only | register a `pre_llm_call` hook with framework-side per-`session_id` dedup (fire only on first turn) |
| **Cursor** | ⚠️ Unknown (closed-source GUI; docs imply concat) | ⚠️ Unknown | run `probe-cursor.js` first to verify; expected to follow the Codex inline-append pattern |
| **openclaw** | TBD — research before implementing | TBD | TBD |

## Findings (source-level)

### Claude Code — verified empirically against 2.1.131 with multi-channel probe

A standalone shell-script probe was wired in as a 2nd SessionStart hook command alongside the existing memory hook. The probe emitted distinct markers via every plausible channel; the user opened a fresh `claude` and reported what surfaced. The session JSONL was inspected to see exactly how the harness recorded each.

Findings:
- ✅ **Top-level `systemMessage` → user-visible verbatim.** Renders in the terminal at session start as `SessionStart:startup says: <text>`. MUST be at the top level of the JSON; nesting it inside `hookSpecificOutput` causes the harness to silently drop it.
- ✅ **Nested `hookSpecificOutput.additionalContext` → model-visible.** Multiple hooks' additionalContext arrive as an array on a single `hook_additional_context` attachment — both the existing memory hook's content AND our notification hook's content are present.
- ❌ **`process.stderr.write` → captured but not rendered.** As of Claude Code 2.1.0 ("ultrathink update"), SessionStart hook stderr is recorded into the session JSONL's `attachment.stderr` field but no longer printed to the user's terminal. Don't rely on it.
- ❌ **Top-level `additionalContext` (not nested) → ignored.** The docs and our test confirm only the nested form is honored.

Empirical evidence preserved in the session JSONL captured by the probe — see also CC docs ([Hooks reference](https://code.claude.com/docs/en/hooks)) and bug reports [#9591](https://github.com/anthropics/claude-code/issues/9591) (post-2.1.0 silenced stderr) and [#15344](https://github.com/anthropics/claude-code/issues/15344) (systemMessage behavior in CLI vs VS Code).

**Channel (v1):** single SessionStart hook command emits one JSON object with `systemMessage` at top level + `hookSpecificOutput.additionalContext` nested. Same text in both. User reads, model reasons.

**Caveat:** the VS Code extension does not render `systemMessage` (issue #15344). Terminal CLI users get the full UX; IDE users get model-only delivery.

### Codex — verified upstream source (`openai/codex@main`)

- `codex-rs/hooks/src/events/session_start.rs` parses each command's stdout (JSON first, plain text fallback into `additional_context`).
- `codex-rs/hooks/src/events/common.rs::flatten_additional_contexts` collects all hooks' contexts as a `Vec<String>` of separate items.
- Downstream those entries are joined with `"\n\n"` for the model — **concatenation, not separate blocks**.
- `parse_completed()` only reads stdout; `result.stderr` field exists but is never inspected — **stderr discarded**.
- **v1 implication:** registering a second hook command does NOT produce a distinct context block — the user's "but not DEEPLAKE MEMORY, HIVEMIND" requirement cannot be honored at the harness level.

### Hermes — verified upstream source (`~/.hermes/hermes-agent/`)

- `run_agent.py:9777-9786`: `_invoke_hook("on_session_start", ...)` is called but its return value is **discarded** — no assignment, no use of the returned `List[Any]`.
- The current shipping `src/hooks/hermes/session-start.ts:109` line `console.log(JSON.stringify({ context: additional }))` is a **latent no-op** — bytes travel through stdin/stdout/parse and get dropped at the caller. Worth filing upstream.
- `agent/shell_hooks.py:391-398` runs hooks with `subprocess.run(..., capture_output=True, ...)`, then `:444-448` routes stderr to `logger.debug(...)` only — stderr is captured and only emitted at DEBUG log level (default INFO/WARNING; user must explicitly opt in via `--dev` or `HERMES_LOG_LEVEL=DEBUG`).
- The actual model-visible context-injection point in Hermes is `pre_llm_call` (`run_agent.py:9890-9897`), where multiple callbacks' `{context: "..."}` returns are joined with `"\n\n"`.
- **v1 implication:** Hermes cannot deliver a notification at session start through the existing `on_session_start` hook channel. Future option: register a `pre_llm_call` hook with framework-side `session_id`-keyed dedup (fire only on first turn of each session). Out of scope for v1.

### Cursor — closed source

- `~/.cursor/hooks.json` accepts an array of commands per `sessionStart` — config shape supports multiple hooks.
- Cursor 1.7+ docs describe `additional_context` as a single string field. Docs are silent on multi-hook merging behavior and stderr handling. No source available to verify.
- **Implementation note:** behavior unknown; verify via the runnable probe in `probe/probe-cursor.js` before implementing.

## v1 delivery summary

The only agent shipped today is **Claude Code**, via a dual-channel JSON emit:

- **`systemMessage` at the top level** of the JSON output — renders verbatim in the terminal as `SessionStart:startup says: <text>`. User-visible.
- **`hookSpecificOutput.additionalContext`** (nested) — delivered to the model as a `<system-reminder>` block. Lets the model reason on follow-up turns ("you have a balance reminder, avoid expensive ops?").

Both fields carry the same rendered text. The user definitely sees it; the model also receives it.

Other agents (Codex, Cursor, Hermes, Pi, openclaw) are not yet wired. The findings above are the forward reference for what each adapter needs to do when it's prioritized.

## Probes

`probe/` contains runnable verification scripts for each agent. They no-op unless `HIVEMIND_NOTIFICATION_PROBE=1` is set. See `probe/README.md` for wiring instructions. Phase 0 closed without running them in live Codex/Cursor/Hermes sessions because the source-level read already established that multi-hook block separation is not a viable strategy for those agents.
