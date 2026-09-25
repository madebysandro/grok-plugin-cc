---
description: Make a video from reference images, pinned first/last frames, keyframes and preset voices with Grok (reference_to_video)
argument-hint: '<prompt> [--image PATH]... [--first-frame PATH] [--last-frame PATH] [--keyframe PATH@SECONDS]... [--voice ID]... [--loop] [--aspect 16:9] [--duration 1-15] [--resolution 480p|720p] [--draft] [--out DIR] [--background]'
allowed-tools: Bash(node:*), Read, Glob
---

Make one video with Grok's `reference_to_video` tool: people, products and places kept consistent from reference images, exact opening and closing frames, images pinned at chosen moments, and characters speaking in preset voices.

Raw slash-command arguments:
`$ARGUMENTS`

Inputs — give at least one:

- `--image PATH` (repeatable): a reference for a person, product, outfit or place. It conditions the video and appears re-rendered, not literally. Up to 14, or 7 on older Grok CLIs; `/grok:setup` shows which one is installed.
- `--first-frame PATH` / `--last-frame PATH`: the exact frame the clip opens or ends on.
- `--keyframe PATH@SECONDS` (repeatable, up to 4): an image that appears literally at that moment, e.g. `shelf.png@3`. Grok snaps the moment to a 1/3-second grid; it must still fall strictly inside the clip (use `--first-frame` / `--last-frame` for the ends), and anchors must be at least 1/3 s apart.
- `--voice ID` (repeatable, up to 3): a preset voice for someone to speak in, e.g. `ara`, `eve`, `leo`, `rex`. Write the line to be spoken into the prompt, in the language it should be spoken in. The plugin does not know the full roster: an unknown id is refused by Grok, with the list of voices, which the output relays.
- `--loop`: use the one `--image` as both the first and the last frame, for a clip that repeats seamlessly. It is not sent as a reference image. The prompt gets "Locked camera, seamless loop." appended. Not combinable with `--first-frame` / `--last-frame`.

Every file input takes a path, `@last` (the last file the plugin saved in this workspace, by a generation or a local tool), `job:<id>` (that job's first file) or `job:<id>#N` (its Nth file). For a keyframe, put the reference before the time: `@last@2`, `job:abc#2@4`.

Referring to inputs in the prompt:

- Images are `<IMAGE_0>`, `<IMAGE_1>`, … numbered in this order: `--first-frame`, then each `--image` in the order given, then the keyframes in time order, then `--last-frame`.
- With `--loop`, the image is the first frame, `<IMAGE_0>`, and also the last one: `<IMAGE_1>`, or `<IMAGE_N+1>` after N keyframes. Refer to it as `<IMAGE_0>`.
- Voices are `<AUDIO_0>`, `<AUDIO_1>`, … in the order the `--voice` flags are given.
- Example: `--first-frame counter.png --image barista.png --image cup.png` makes the counter `<IMAGE_0>`, the barista `<IMAGE_1>` and the cup `<IMAGE_2>`: `"<IMAGE_1> slides <IMAGE_2> across the counter and says, in the voice <AUDIO_0>: 'Your coffee.'" --voice eve`.

Other options:

- `--aspect` is one of 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3 (default 16:9).
- `--duration` is 1 to 15 seconds (default 6). `--resolution` is 480p or 720p (default 720p); the CLI goes no higher.
- `--draft` makes a cheap 480p try-out, at 6 s unless `--duration` is given. It cannot be combined with `--resolution`. For work with several clips, propose a draft first.
- There is no `--image-model`: this tool makes no still image.
- Everything above except the voice roster is checked before Grok runs, so a mistake costs nothing. Pass the user's prompt through unchanged; it reaches the tool verbatim (with `--loop`, followed by the loop direction).

Execution — in the foreground by default, so the user gets the clip as soon as it lands; a clip takes about a minute (live runs took 45–65 s).

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" ref-video $ARGUMENTS`,
  description: "Grok reference-to-video",
  timeout: 600000
})
```

The long `timeout` matters: the Bash tool's default of 2 minutes can cut a slow run short. Ten minutes is the most it allows, below the companion's own 20-minute limit for video, so a run you expect to be unusually slow belongs in the background.

In the background only when the user passed `--background` or asked for it, or for a batch of several clips — launch it and stop there, do not poll in the same turn:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" ref-video $ARGUMENTS`,
  description: "Grok reference-to-video",
  run_in_background: true
})
```

Then tell the user it is running and that `/grok:status` shows progress.

Output rules:

- Relay the companion's output verbatim.
- You cannot view a video. Report the path and size; do not describe the motion or the speech.
- If the run reports a Zero Data Retention rejection, relay it as-is and do not retry — every attempt will fail the same way until the account setting changes.
