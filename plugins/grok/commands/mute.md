---
description: Remove a video's soundtrack (local, ffmpeg; no Grok)
argument-hint: '<video> [--out DIR] [--name SLUG]'
allowed-tools: Bash(node:*), Read
---

Remove the soundtrack from a clip, with ffmpeg on this machine — no Grok call, no quota. Every Grok video comes with sound; this gives a silent copy.

Raw slash-command arguments:
`$ARGUMENTS`

Argument handling:

- One video. It takes a path, `@last` (the last file the plugin saved in this workspace, by a generation or a local tool), `job:<id>` (that job's first file) or `job:<id>#N` (its Nth file).
- The video stream is copied as it is — not re-encoded — and Grok's cover picture is left out.

Execution — local and quick, always in the foreground:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" mute $ARGUMENTS
```

Output rules:

- Relay the companion's output: the saved file's path, its size and the job id.
- The run is recorded as a job, so the output is what `@last` points at next.
- If it fails, relay the reason verbatim. A refusal (exit 1) names the fix — apply it rather than re-running unchanged.
