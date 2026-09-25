---
description: Animate an existing still image into a video with Grok (image_to_video)
argument-hint: '<motion description> --image PATH [--out DIR] [--duration 6|10] [--resolution 480p|720p] [--draft] [--background]'
allowed-tools: Bash(node:*), Read, Glob
---

Animate an existing still image with Grok's `image_to_video` tool.

Raw slash-command arguments:
`$ARGUMENTS`

Argument handling:

- `--image` is required — the still to animate. It takes a path, `@last` (the last file the plugin saved in this workspace, by a generation or a local tool such as `/grok:last-frame`), `job:<id>` (that job's first file) or `job:<id>#N` (its Nth file).
- The prompt should describe **motion**, not the scene: what moves, how the camera travels, what the light does. The image already establishes the content, so re-describing it wastes the prompt.
- If the user just generated an image with `/grok:image` or `/grok:edit`, use that exact output path.
- There is no `--aspect`: the video keeps the source image's shape. Crop the still first if the user wants another shape.
- `--duration` is 6 or 10 seconds (default 6). `--resolution` is 480p or 720p (default 720p) — the CLI goes no higher; 1080p in a Grok plan applies to the Grok app only.
- `--draft` makes a cheap 480p try-out, at 6 s unless `--duration` is given. It cannot be combined with `--resolution`.

Execution — in the foreground by default, so the user gets the clip as soon as it lands; a clip takes about a minute (live runs took 45–65 s).

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" animate $ARGUMENTS`,
  description: "Grok image-to-video",
  timeout: 600000
})
```

The long `timeout` matters: the Bash tool's default of 2 minutes can cut a slow run short.

In the background only when the user passed `--background` or asked for it, or for a batch of several clips — launch it and stop there, do not poll in the same turn:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" animate $ARGUMENTS`,
  description: "Grok image-to-video",
  run_in_background: true
})
```

Then tell the user it is running and that `/grok:status` shows progress.

Output rules:

- Relay the companion's output verbatim.
- You cannot view a video. Report the path and size; do not describe the motion.
- If the run reports a Zero Data Retention rejection, relay it as-is and do not retry — every attempt will fail the same way until the account setting changes.
