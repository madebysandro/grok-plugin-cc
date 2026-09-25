---
description: Cancel a running Grok job
argument-hint: '[job-id]'
allowed-tools: Bash(node:*)
---

Run, passing the job id if the user gave one (otherwise the most recent job is used):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" cancel $ARGUMENTS
```

Notes:

- When several jobs are running and the user did not name one, list them with `/grok:status` and ask which to cancel rather than killing the most recent by default.
- Cancelling stops the local run. Generation already in flight on xAI's side may still count against the plan's quota.
- Present the result as-is.
