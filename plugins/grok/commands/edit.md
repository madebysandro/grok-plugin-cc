---
description: Edit an existing image with Grok (image_edit)
argument-hint: '<instruction> --image PATH [--image PATH2] [--aspect 16:9] [--out DIR] [--count N] [--image-model 2.0|quality|standard|server] [--background]'
allowed-tools: Bash(node:*), Read, Glob
---

Edit an existing image with Grok's `image_edit` tool.

Raw slash-command arguments:
`$ARGUMENTS`

Argument handling:

- `--image` is required and repeatable; each one is a path to a source image, a `data:` URL, `@last` (the last file the plugin saved in this workspace, by a generation or a local tool), `job:<id>` (that job's first file) or `job:<id>#N` (its Nth file).
- `--aspect` only applies with 2 or more `--image` inputs (1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 2:1, 1:2, 19.5:9, 9:19.5, 20:9, 9:20, auto); a single-image edit keeps the source's shape.
- `--image-model` picks the image model: `2.0` (the default, `grok-imagine-image-2.0`, which renders text such as accents and prices reliably), `quality`, `standard`, or `server` (no override, so xAI's current default applies). Keep the default unless the user asks for another model.
- If the user described an image but gave no `--image`, find the file first (`Glob`) and confirm the path with them rather than guessing.
- Pass the instruction through verbatim. Describe only what changes — `image_edit` preserves everything the instruction does not mention, so extra scene description works against the edit.
- Use this, not `/grok:image`, whenever there is a source image: re-generating from scratch will not preserve the subject.

Execution — in the foreground by default, so the user sees the result right away; an edit takes roughly 25 seconds.

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" edit $ARGUMENTS`,
  description: "Grok image edit",
  timeout: 600000
})
```

The long `timeout` matters: the Bash tool's default of 2 minutes can cut a slow run short.

In the background only when the user passed `--background` or asked for it, or for a batch (`--count 4` or more, or several separate edits) — launch it and stop there, do not poll in the same turn:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" edit $ARGUMENTS`,
  description: "Grok image edit",
  run_in_background: true
})
```

Then tell the user it is running and that `/grok:status` shows progress.

Output rules:

- Relay the companion's output, then `Read` each saved file so the user can see the result.
- The source image is never modified; edits are written as new files.
- To iterate, run `/grok:edit` again against the newest output rather than re-running the original edit.
- If the run failed, relay the reason verbatim and do not retry automatically.
