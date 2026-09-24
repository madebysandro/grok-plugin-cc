---
description: Generate a video with Grok (image_gen then image_to_video)
argument-hint: '<prompt> [--out DIR] [--aspect 16:9] [--duration 6|10] [--resolution 480p|720p] [--draft] [--background]'
allowed-tools: Bash(node:*), Read
---

Generate a video from a text prompt.

Raw slash-command arguments:
`$ARGUMENTS`

How it works:

Grok CLI 1.0 has no text-to-video tool. Its media toolset is `image_gen`, `image_edit`, `image_to_video`, and `reference_to_video`. So this command runs two steps: it generates an opening frame with `image_gen`, then animates that frame with `image_to_video`. Both artefacts are saved — the still is the clip's first frame, and it is worth keeping.

Argument handling:

- Pass the prompt through verbatim.
- `--aspect` shapes the opening frame (1:1, 16:9, 9:16, 3:2, 2:3, auto); the clip keeps that shape.
- `--duration` is 6 or 10 seconds (default 6). `--resolution` is 480p or 720p (default 720p) — the CLI goes no higher; 1080p in a Grok plan applies to the Grok app only.
- `--draft` makes a cheap 480p try-out, at 6 s unless `--duration` is given. It cannot be combined with `--resolution`.
- Invalid values are refused before Grok runs, with a message saying what to use instead; relay it and fix the flag rather than retrying as-is.
- If the user already has a still they want animated, use `/grok:animate` instead — it skips the generation step and animates their exact image.

Execution — this takes a few minutes, so prefer the background unless the user asked to wait:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" video $ARGUMENTS`,
  description: "Grok video generation",
  run_in_background: true
})
```

Foreground, when the user passed `--wait` or explicitly asked to wait:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" video $ARGUMENTS
```

Output rules:

- Relay the companion's output verbatim.
- You cannot view a video. Report the path and the file size; do not describe the motion or claim the clip looks right.
- If the run reports that xAI rejected the request under Zero Data Retention, relay that explanation as-is. It is an account setting, not a bug in the prompt, and retrying will fail identically — say so instead of trying again.
- A run that produced only the still frame is reported as incomplete. Do not present it as a finished video.
