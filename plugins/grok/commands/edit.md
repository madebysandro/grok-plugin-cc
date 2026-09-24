---
description: Edit an existing image with Grok (image_edit)
argument-hint: '<instruction> --image PATH [--image PATH2] [--out DIR] [--count N] [--background]'
allowed-tools: Bash(node:*), Read, Glob
---

Edit an existing image with Grok's `image_edit` tool.

Raw slash-command arguments:
`$ARGUMENTS`

Argument handling:

- `--image` is required and repeatable; each one is a path to a source image, a `data:` URL, `@last` (the last file generated in this workspace), `job:<id>` (that job's first file) or `job:<id>#N` (its Nth file).
- If the user described an image but gave no `--image`, find the file first (`Glob`) and confirm the path with them rather than guessing.
- Pass the instruction through verbatim. Describe only what changes — `image_edit` preserves everything the instruction does not mention, so extra scene description works against the edit.
- Use this, not `/grok:image`, whenever there is a source image: re-generating from scratch will not preserve the subject.

Execution — foreground by default, roughly 25 seconds:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" edit $ARGUMENTS
```

Background, when the user asked for it or requested several variations:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" edit $ARGUMENTS`,
  description: "Grok image edit",
  run_in_background: true
})
```

Output rules:

- Relay the companion's output, then `Read` each saved file so the user can see the result.
- The source image is never modified; edits are written as new files.
- To iterate, run `/grok:edit` again with `--image @last` rather than re-running the original edit.
- If the run failed, relay the reason verbatim and do not retry automatically.
