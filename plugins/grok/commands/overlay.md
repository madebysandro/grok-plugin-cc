---
description: Put exact text over an image, rendered in HTML by headless Chrome (local; no Grok)
argument-hint: '--image PATH --text "..." [--sub "..."] [--brand brand.json] [--position top|center|bottom] [--style clean|bold|glass] [--out DIR] [--name SLUG]'
allowed-tools: Bash(node:*), Read
---

Lay exact text — a title, a price, a date — over an image, set in HTML at the image's own size and rendered by headless Chrome on this machine. No Grok call, no quota, and no misspelled words: use this instead of asking an image model to draw text that must be right.

Raw slash-command arguments:
`$ARGUMENTS`

Argument handling:

- `--image` is required: a path, `@last` (the last file the plugin saved in this workspace, by a generation or a local tool), `job:<id>` (that job's first file) or `job:<id>#N` (its Nth file). It must be an image.
- `--text` is required and is drawn exactly as given; `--sub` adds a smaller line under it. Put text containing `$` in single quotes (`--text 'R$ 5,90'`): the arguments pass through the shell, which would otherwise swallow `$5`.
- `--position` places the text block: `top`, `center` or `bottom` (default).
- `--style`: `clean` (default; text with a soft shadow), `bold` (a solid band in the brand's primary colour) or `glass` (a translucent, blurred panel).
- `--brand` points at a `brand.json` (colours, fonts, logo; see the `grok-imagine-prompting` skill). Without it, the text is white in the system's sans-serif.
- The output is a PNG exactly the size of the base image.

Execution — local, a few seconds, always in the foreground:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" overlay $ARGUMENTS
```

Output rules:

- Relay the companion's output: the saved file's path, its size and the job id, plus any note (e.g. a brand font that did not load, drawn in a fallback font).
- `Read` the PNG so the user sees the result.
- The run is recorded as a job, so the output is what `@last` points at next.
- If it fails, relay the reason verbatim. A refusal (exit 1) names the fix — apply it rather than re-running unchanged. Chrome is found at its usual macOS location, or through `CHROME_PATH`.
