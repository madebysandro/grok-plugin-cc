---
description: Show the output of a Grok job
argument-hint: '[job-id]'
allowed-tools: Bash(node:*), Read
---

Run, passing the job id if the user gave one (otherwise the most recent job is used):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" result $ARGUMENTS
```

Output rules:

- Present the companion's output.
- If the job produced images, `Read` them so the user can see them inline.
- If the job is still running, say so and leave it alone. Do not re-launch the command — that starts a second generation, which spends quota again.
- If files are listed as no longer on disk, report that plainly rather than implying they are still available.
