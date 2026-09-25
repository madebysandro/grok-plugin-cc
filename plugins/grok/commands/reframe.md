---
description: Reframe an image or video to another aspect ratio (local, ffmpeg; no Grok)
argument-hint: '<image|video> --aspect W:H [--mode crop|pad] [--anchor center|top|bottom|left|right] [--out DIR] [--name SLUG]'
allowed-tools: Bash(node:*), Read
---

Change the aspect ratio of an image or a video — for reels, stories or feed — with ffmpeg on this machine. No AI, no Grok call, no quota.

Argument handling:

- One image or video. It takes a path, `@last` (the last file the plugin saved in this workspace, by a generation or a local tool), `job:<id>` (that job's first file) or `job:<id>#N` (its Nth file).
- `--aspect W:H` is required, e.g. `9:16`, `1:1`, `4:5`, `16:9`.
- `--mode crop` (default) keeps the largest window of the new ratio. `--mode pad` keeps the whole picture and fills the rest with a blurred copy of the picture itself, not black bars.
- Only one axis changes, and `--anchor` picks where along it: `left`, `center` (default) or `right` when the width is cut or padded — e.g. 16:9 → 9:16 with crop — and `top`, `center` or `bottom` when the height is. An anchor on the other axis is refused with a message naming the right ones. (`left`/`right` go beyond the spec's `center|top|bottom` on purpose: 16:9 → 9:16 is the main case, and it cuts the width.)
- Videos are re-encoded (H.264) with their sound copied; the output sizes are even numbers. Images keep their format.
- A picture already at the requested ratio is refused rather than copied.

Raw slash-command arguments:
`$ARGUMENTS`

Execution — local and quick, always in the foreground:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" reframe $ARGUMENTS
```

Output rules:

- Relay the companion's output: the saved file's path, its size and the job id.
- The run is recorded as a job, so the output is what `@last` points at next.
- If it fails, relay the reason verbatim. A refusal (exit 1) names the fix — apply it rather than re-running unchanged.
- `Read` the result when it is an image so the user sees the new framing.
