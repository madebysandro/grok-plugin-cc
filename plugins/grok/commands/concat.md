---
description: Join video clips end to end (local, ffmpeg; no Grok)
argument-hint: '<video> <video>... [--reencode] [--out DIR] [--name SLUG]'
allowed-tools: Bash(node:*), Read
---

Join two or more clips in the order given, with ffmpeg on this machine — no Grok call, no quota.

Argument handling:

- Two or more videos. Each takes a path, `@last` (the last file the plugin saved in this workspace, by a generation or a local tool), `job:<id>` (that job's first file) or `job:<id>#N` (its Nth file).
- By default the streams are copied, so nothing loses quality. That needs every clip to match the first in size, frame rate and codecs (sound included); otherwise the command refuses and lists how each clip differs.
- `--reencode` joins clips that differ: each is scaled and padded to the first clip's size and frame rate, a clip without sound gets silence, and the result is re-encoded (H.264 + AAC). Suggest it only after the plain join was refused.
- Grok's cover pictures are left out of the joined file.

Raw slash-command arguments:
`$ARGUMENTS`

Execution — local and quick, always in the foreground:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" concat $ARGUMENTS
```

Output rules:

- Relay the companion's output: the saved file's path, its size and the job id.
- The run is recorded as a job, so the output is what `@last` points at next.
- If it fails, relay the reason verbatim. A refusal (exit 1) names the fix — apply it rather than re-running unchanged.
