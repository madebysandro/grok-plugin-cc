---
description: Generate images with Grok (image_gen)
argument-hint: '<prompt> [--out DIR] [--aspect 16:9] [--count N] [--name SLUG] [--image-model 2.0|quality|standard|server] [--background]'
allowed-tools: Bash(node:*), Read
---

Generate one or more images with Grok's `image_gen` tool.

Raw slash-command arguments:
`$ARGUMENTS`

Argument handling:

- Pass the user's arguments through unchanged. Do not rewrite, translate, expand, or "improve" the prompt — the companion sends it to `image_gen` verbatim on purpose, and rewriting it silently discards the user's art direction.
- If the user gave no prompt at all, ask for one instead of inventing a subject.
- `--count` above 1 produces variations of the same subject.
- `--image-model` picks the image model: `2.0` (the default, `grok-imagine-image-2.0`, which renders text such as accents and prices reliably), `quality`, `standard`, or `server` (no override, so xAI's current default applies). Keep the default unless the user asks for another model.
- `--aspect` is one of 1:1, 16:9, 9:16, 3:2, 2:3, auto; anything else is refused before Grok runs.
- If the user wants Grok to elaborate on a terse prompt, they can pass `--verbatim=false`.

Execution:

- A single image takes roughly 30 seconds. Run in the foreground unless the user passed `--background`, or asked for `--count 4` or more.

Foreground:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" image $ARGUMENTS
```

Background — launch it and stop there, do not poll in the same turn:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" image $ARGUMENTS`,
  description: "Grok image generation",
  run_in_background: true
})
```

Then tell the user it is running and that `/grok:status` shows progress.

Output rules:

- Relay the companion's output, which lists each saved file with its path.
- Then `Read` each saved image so the user can see it inline. This is the one place re-reading is worth it: the user asked for a picture, and a list of paths is not a picture.
- Do not claim an image "looks good" or describe its quality beyond what you can actually see.
- If the run failed, relay the reason verbatim. Do not retry automatically — image generation costs money on every attempt.
