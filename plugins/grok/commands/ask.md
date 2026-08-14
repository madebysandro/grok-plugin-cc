---
description: Delegate a task to Grok and return its answer
argument-hint: '<prompt> [--write] [--model M] [--effort high] [--background]'
allowed-tools: Bash(node:*)
---

Delegate a task to Grok running headlessly in this workspace, and return what it says.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:

- Grok is read-only unless the user passes `--write`. Do not add `--write` on their behalf.
- Return Grok's answer as its own output. Do not merge it into your own reasoning as if you had worked it out, and do not silently act on its conclusions — the user asked for a second opinion, not a hand-off.

Argument handling:

- Pass the prompt through unchanged.
- `--effort high` is worth suggesting for genuinely hard analysis; it costs more and takes longer.

Execution — foreground for a focused question:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" ask $ARGUMENTS
```

Background for anything that will sweep a codebase:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" ask $ARGUMENTS`,
  description: "Grok delegation",
  run_in_background: true
})
```

Output rules:

- Present Grok's answer, attributed to Grok.
- If you disagree with it, say so plainly and give your reason. Do not present a claim you believe is wrong without flagging it, and do not defer to it just because it came from another model.
- If the run failed, relay the error rather than guessing at what Grok would have said.
