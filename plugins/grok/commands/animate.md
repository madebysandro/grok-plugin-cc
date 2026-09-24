---
description: Animate an existing still image into a video with Grok (image_to_video)
argument-hint: '<motion description> --image PATH [--out DIR] [--duration 6] [--background]'
allowed-tools: Bash(node:*), Read, Glob
---

Animate an existing still image with Grok's `image_to_video` tool.

Raw slash-command arguments:
`$ARGUMENTS`

Argument handling:

- `--image` is required — the still to animate. It takes a path, `@last` (the last file generated in this workspace), `job:<id>` (that job's first file) or `job:<id>#N` (its Nth file).
- The prompt should describe **motion**, not the scene: what moves, how the camera travels, what the light does. The image already establishes the content, so re-describing it wastes the prompt.
- If the user just generated an image with `/grok:image` or `/grok:edit`, pass `--image @last`.

Execution — this takes a few minutes, so prefer the background:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" animate $ARGUMENTS`,
  description: "Grok image-to-video",
  run_in_background: true
})
```

Foreground, when the user asked to wait:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" animate $ARGUMENTS
```

Output rules:

- Relay the companion's output verbatim.
- You cannot view a video. Report the path and size; do not describe the motion.
- If the run reports a Zero Data Retention rejection, relay it as-is and do not retry — every attempt will fail the same way until the account setting changes.
