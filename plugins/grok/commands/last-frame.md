---
description: Save a video's last frame as a PNG (local, ffmpeg; no Grok)
argument-hint: '<video> [--out DIR] [--name SLUG]'
allowed-tools: Bash(node:*), Read
---

Save the last frame a clip really shows as a PNG, with ffmpeg on this machine — no Grok call, no quota. This is how one clip continues into the next: animate the last frame of the previous clip.

Argument handling:

- One video. It takes a path, `@last` (the last file the plugin saved in this workspace, by a generation or a local tool), `job:<id>` (that job's first file) or `job:<id>#N` (its Nth file).
- The saved PNG becomes `@last`, so `/grok:animate "<motion>" --image @last` continues the action.
- Grok's clips carry a cover picture as a second video stream; it is ignored — the frame comes from the clip itself.

Raw slash-command arguments:
`$ARGUMENTS`

Execution — local and quick, always in the foreground:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" last-frame $ARGUMENTS
```

Output rules:

- Relay the companion's output: the saved file's path, its size and the job id.
- The run is recorded as a job, so the output is what `@last` points at next.
- If it fails, relay the reason verbatim. A refusal (exit 1) names the fix — apply it rather than re-running unchanged.
- `Read` the saved PNG so the user sees the frame.
