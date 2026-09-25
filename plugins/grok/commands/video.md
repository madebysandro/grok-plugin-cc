---
description: Generate a video with Grok (image_gen then image_to_video)
argument-hint: '<prompt> [--out DIR] [--aspect 16:9] [--duration 6|10] [--resolution 480p|720p] [--draft] [--image-model 2.0|quality|standard|server] [--background]'
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
- `--image-model` picks the model of the opening frame, as in `/grok:image`: `2.0` (default), `quality`, `standard` or `server`.
- `--duration` is 6 or 10 seconds (default 6). `--resolution` is 480p or 720p (default 720p) — the CLI goes no higher; 1080p in a Grok plan applies to the Grok app only.
- `--draft` makes a cheap 480p try-out, at 6 s unless `--duration` is given. It cannot be combined with `--resolution`.
- Invalid values are refused before Grok runs, with a message saying what to use instead; relay it and fix the flag rather than retrying as-is.
- If the user already has a still they want animated, use `/grok:animate` instead — it skips the generation step and animates their exact image.

Execution — in the foreground by default, so the user gets the clip as soon as it lands; a clip takes about a minute (live runs took 45–65 s).

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" video $ARGUMENTS`,
  description: "Grok video generation",
  timeout: 600000
})
```

The long `timeout` matters: the Bash tool's default of 2 minutes can cut a slow run short. Ten minutes is the most it allows, below the companion's own 20-minute limit for video, so a run you expect to be unusually slow belongs in the background.

In the background only when the user passed `--background` or asked for it, or for a batch of several clips — launch it and stop there, do not poll in the same turn:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" video $ARGUMENTS`,
  description: "Grok video generation",
  run_in_background: true
})
```

Then tell the user it is running and that `/grok:status` shows progress.

Output rules:

- Relay the companion's output verbatim.
- You cannot view a video. Report the path and the file size; do not describe the motion or claim the clip looks right.
- If the run reports that xAI rejected the request under Zero Data Retention, relay that explanation as-is. It is an account setting, not a bug in the prompt, and retrying will fail identically — say so instead of trying again.
- A run that produced only the still frame is reported as incomplete. Do not present it as a finished video.
