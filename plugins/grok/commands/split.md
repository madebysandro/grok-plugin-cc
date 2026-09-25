---
description: Split a sheet (character turnaround, product grid, icon set) into one transparent PNG per item (local, Python; no Grok)
argument-hint: '<sheet image> [--expect N] [--bg auto|#00FF00] [--tolerance N] [--out DIR] [--name SLUG]'
allowed-tools: Bash(node:*), Read
---

Cut a sheet generated on a flat background — a character turnaround, a product grid, an icon set — into one transparent PNG per item, all on the same canvas with the same margin. Runs on this machine with Python (Pillow, numpy, scipy); no AI, no Grok call, no quota.

Raw slash-command arguments:
`$ARGUMENTS`

Argument handling:

- One sheet image. It takes a path, `@last` (the last file the plugin saved in this workspace, by a generation or a local tool), `job:<id>` (that job's first file) or `job:<id>#N` (its Nth file). A sheet that already has transparency — cut out with `cutout`, say — is split along it, and `--bg` is not used.
- `--expect N`: how many items the sheet should hold. Pass it whenever the user said how many: a different count is refused instead of producing the wrong files.
- `--bg auto` (default) takes the background colour from the sheet's corners, which must agree; otherwise pass it, e.g. `--bg #00FF00`. `--tolerance` works as in `cutout` (RGB distance, default 80).
- Items are found as separate shapes, not by slicing a grid. A small piece — under a third of its neighbour's size — closer than 3% of the sheet's width to a bigger item (a plume, a sword tip) stays with that item; items of similar size stay apart however close they sit. Specks smaller than 0.05% of the sheet are dropped. Items are numbered row by row, left to right.
- Every item gets the same canvas — as wide as the widest item and as tall as the tallest, plus a margin of about 6% of the largest item side all round — centred across and standing on one baseline, so a turnaround's feet line up. The green fringe along each cut edge is removed as in `cutout`.
- An item that touches the edge of the sheet is refused: it was most likely cut off when the sheet was drawn. So are two items that touch each other, which come out as one (the count then differs from `--expect`). In both cases generate the sheet again, asking for a clear margin and clear gaps between the items, rather than patching it.
- To make a sheet for this, ask for the items "on a flat pure green (#00FF00) background, evenly spaced with clear gaps, none touching the edges".

Execution — local and quick, always in the foreground:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" split $ARGUMENTS
```

Output rules:

- Relay the companion's output: one line per saved PNG, and the job id. `job:<id>#N` then names the Nth item, and `@last` the last one.
- If it fails, relay the reason verbatim. A refusal (exit 1) names the fix — apply it rather than re-running unchanged. A missing Python library is named with the `pip install` that adds it; do not install anything unless the user asks. `GROK_PLUGIN_PYTHON` picks a Python other than the `python3` on PATH.
- `Read` a few of the results so the user sees the items came out whole.
