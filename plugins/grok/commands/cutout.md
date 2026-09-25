---
description: Clear an image's flat (green-screen) background to transparency (local, Python; no Grok)
argument-hint: '<image> [--key #00FF00] [--tolerance N] [--out DIR] [--name SLUG]'
allowed-tools: Bash(node:*), Read
---

Turn an image generated on a flat background — green screen by default — into a transparent PNG: a product or a character cut out, ready to place on anything. Runs on this machine with Python (Pillow, numpy, scipy); no AI, no Grok call, no quota.

Raw slash-command arguments:
`$ARGUMENTS`

Argument handling:

- One image. It takes a path, `@last` (the last file the plugin saved in this workspace, by a generation or a local tool), `job:<id>` (that job's first file) or `job:<id>#N` (its Nth file).
- `--key` is the background colour to clear, as hex (default `#00FF00`). For a subject that is itself green, generate it on another flat colour, e.g. magenta `#FF00FF`, and pass that.
- `--tolerance` is how far a pixel's colour may be from the key and still count as background, as an RGB distance from 0 to 400 (default 80). Pixels a little past it fade out, so the edge is smooth. Lower it if the cut eats into the subject; raise it if patches of background remain.
- The key colour's spill is removed along the cut edge only — within 3 px of the cleared background, or 1% of the image's shorter side on larger images, where edges are softer: the green fringe light leaves around a subject goes, while a subject's own green, further in, is kept.
- An image that already has transparency keeps it; the key is cleared on top.
- An image with no background of that colour, or nothing but, is refused before anything is written.
- To make a subject for this, ask for it "on a flat pure green (#00FF00) background, evenly lit, no shadow on the background".

Execution — local and quick, always in the foreground:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" cutout $ARGUMENTS
```

Output rules:

- Relay the companion's output: the saved PNG's path, its size and the job id.
- The run is recorded as a job, so the output is what `@last` points at next.
- If it fails, relay the reason verbatim. A refusal (exit 1) names the fix — apply it rather than re-running unchanged. A missing Python library is named with the `pip install` that adds it; do not install anything unless the user asks. `GROK_PLUGIN_PYTHON` picks a Python other than the `python3` on PATH.
- `Read` the result so the user sees the cut-out.
