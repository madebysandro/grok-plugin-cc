---
description: List Grok jobs for this workspace
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" status
```

Present the output as-is.

Notes:

- Jobs are tracked per workspace (the nearest git root), newest first.
- `interrupted` means the process is gone — usually a closed terminal or a restarted session. Nothing is recoverable from it; re-run the command.
- `partial` means some files were produced but the run did not finish what was asked, e.g. a video run that generated its still frame and then failed to animate it.
- Use `/grok:result` for a job's files, and `/grok:cancel` to stop one that is still running.
