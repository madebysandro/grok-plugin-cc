# Changelog

## Unreleased

### Isolated media runs

- Media commands give Grok only the tools they need (`--tools`: image → `image_gen`, edit → `image_edit`, animate → `image_to_video`, video → `image_gen,image_to_video`). They also turn off subagents, web search and auto-update, and run under a session id the plugin generates.
- Media runs switch off Grok's loading of the user's Claude and Cursor setup (`GROK_{CLAUDE,CURSOR}_*_ENABLED=false`): skills, hooks, MCP servers and rules from `~/.claude` and `~/.cursor`, and the skills Claude plugins provide. Claude plugins themselves still load, with their hooks and agents, because Grok has no switch for them; see the `grok-cli-runtime` skill.
- Recursion guard: every Grok process the plugin starts gets `GROK_PLUGIN_CC_WORKER=1`, and media commands refuse to run when it is set. `ask` behaves as before apart from carrying that marker.

Measured on Grok CLI 1.0.41 with one 1:1 image and the same prompt, one run before and one after (details in `docs/live-tests.md`):

| | Before | After | Change |
| --- | --- | --- | --- |
| Wall time | 23.8 s | 14.7 s | −38 % |
| Input tokens, uncached | 28,306 | 21,826 | −23 % |
| Input tokens, cache read | 29,952 | 4,224 | −86 % |
| Total tokens | 58,596 | 26,141 | −55 % |
| Cost reported by Grok | $0.0250 | $0.0157 | −37 % |
| Tools offered to the agent | 15 | 1 | |

One run on each side, so treat the times as indicative. The drop in offered tools comes from `--tools`; the token and time savings come from the whole lock-down and are not split between its parts.

### Zero-cost compatibility checks in `/grok:setup`

- Reads the session folders Grok already left on disk, never starts a run, and asks the binary only for `--version` with its update check off.
- Media tools: each of the four is confirmed from the newest session that could tell. A tool is `FAIL` only when a full-toolset session (several non-media tools on offer) lacks it; runs restricted with `--tools` can only confirm what they were offered, and anything unconfirmed stays "not verified", which never blocks.
- Session log format: media on disk that `updates.jsonl` no longer leads to fails as "session log format changed".
- Warns when `image_to_video` or `reference_to_video` names a resolution or duration the plugin does not allow, or stops describing one.
- Detects the old (up to 7 images, no pinned frames) and new (up to 14) `reference_to_video` schema, exposed in `setup --json` as `compat.referenceToVideo`.
- Shows the plan and the image/video switches from `~/.grok/settings_cache.json`, keeping only those four fields and never printing or storing the rest. A switch that is off warns on the matching check rather than failing it, since the cache's payload format is not pinned down.

### `/grok:ref-video`

- New command for `reference_to_video`: reference images (`--image`, repeatable), exact first/last frames, keyframes pinned at a moment (`--keyframe PATH@SECONDS`), preset voices (`--voice`) and `--loop` (the one image as both first and last frame, with "Locked camera, seamless loop." added to the prompt).
- `--aspect` (default 16:9), `--duration` 1–15 (default 6), `--resolution` (default 720p) and `--draft`; `--image-model` is refused, since the tool makes no still.
- Checked before Grok runs: at least one input; up to 14 reference images, or 7 and no pinned frames when the installed CLI offers the older schema (as `/grok:setup` detects it); up to 3 voices, each shaped like a voice id; up to 4 keyframes, strictly inside the clip even after Grok snaps them to its 1/3-second grid, and at least 1/3 s apart. Keyframes are sent in time order, which is how their `<IMAGE_i>` tags count.
- Every file input takes `@last` and `job:<id>[#N]`. Grok receives the structured arguments as exact JSON and the prompt verbatim, with `reference_to_video` as its only tool.
- Voice ids are not checked locally: xAI's public docs list the roster only as an example, so an unknown id reaches Grok, whose error names the available voices.
- `--loop`, `--voice`, `--keyframe`, `--first-frame` and `--last-frame` are refused by the other commands instead of being ignored. One table in `lib/media-spec.mjs` now says which command each such option belongs to.

### `/grok:cutout` and `/grok:split`

- Two local image tools, run with Python 3 (Pillow, numpy, scipy) through `scripts/chroma.py`; no Grok, no quota, no OpenCV or rembg. A missing Python or library is named, with the `pip install` that adds it; nothing is installed.
- `cutout <image>` clears a flat background (`--key`, default `#00FF00`) to transparency, with a soft edge past `--tolerance` (RGB distance, default 80), and removes the key colour's spill along the cut edge only (3 px, or 1% of the shorter side on larger images), so a green subject keeps its own colour.
- `split <sheet>` writes one transparent PNG per item, found as separate shapes, following the recipe in Grok's bundled sheet guide: a small piece closer than 3% of the sheet's width to a much bigger item joins it (items of similar size never merge, so a tight grid stays a grid), specks under 0.05% of its area are dropped, items are numbered row by row, and all share one canvas with a margin of about 6%, standing on one baseline. `--expect N` refuses a different count, an item touching the sheet's edge is refused, `--bg auto` reads the background from the corners, and a sheet with transparency is split along it.
- Both take `@last` and `job:<id>[#N]`, check everything before writing, and record a job and manifest entry with `tool: "python"`. Local tools now name their engine and may write several files, each reachable as `job:<id>#N`.

### Foreground by default, and a one-time git notice

- The generation commands (`image`, `edit`, `animate`, `video`, `ref-video`) run in the foreground, with the Bash tool's longest timeout (10 minutes, where the default is 2), and go to the background only when the user passes `--background` or asks for it, or for a batch. The local tools already ran in the foreground.
- `--background` no longer ends up in the prompt sent to Grok: slash commands pass `$ARGUMENTS` through, and the companion now takes the flag out (the local tools, which always run in the foreground, refuse it).
- When a run — a generation, a partial one, or a local tool — saves into a folder of a git repository and git would pick up any of the files, or the manifest (`git check-ignore`), its output says so, once per folder in each workspace. The note is kept with the job, so `/grok:result` shows it after a background run, and parallel runs show it only once. Outside a repository, with everything ignored, or without git, nothing is said. `.gitignore` is never touched.

## 1.0.0

Initial release.

- `/grok:image`, `/grok:edit`, `/grok:video`, `/grok:animate` for media generation
- `/grok:ask` for general delegation to Grok
- `/grok:setup`, `/grok:status`, `/grok:result`, `/grok:cancel`
- `grok-media` subagent for multi-asset work
- Skills: `grok-cli-runtime`, `grok-imagine-prompting`, `grok-media-results`
- Assets harvested from Grok's session log rather than copied by the agent
- Zero Data Retention video blocking detected and explained up front
