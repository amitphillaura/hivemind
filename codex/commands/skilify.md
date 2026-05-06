---
description: View or change the skilify scope (me / team / org) and team list
allowed-tools: Bash
argument-hint: "[scope <me|team|org> | team add <name> | team remove <name> | team list | status]"
---

Run the skilify scope/team management command and report the output verbatim:

```bash
hivemind skilify $ARGUMENTS
```

If `$ARGUMENTS` is empty, it prints the current scope, team list, and per-project state. Otherwise it forwards the subcommand to set scope or modify the team list. Show the user the raw output — no extra commentary needed unless they ask.
