# Live test log

Every live Grok run made while building Round 1 of the fork. The spec allows at most 12 generations for the round (`docs/spec-paridade-higgsfield.md` §6), always in the smallest configuration. No credentials or account details are recorded here.

Grok CLI 1.0.41 (4220f3b224a6), macOS arm64. Generations used so far: **5 of 12**.

## Generations

| # | Date (UTC) | Issue | Command | Result | Output | Session |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2026-09-24 23:26 | #3, before isolation (companion at `7f7a202`) | `image "a red apple on a white table" --aspect 1:1` | ok · 23.8 s · 2 turns · input tokens 28,306 uncached + 29,952 cache read · 58,596 total · $0.0250 · 15 tools offered | 1024×1024 JPEG, 178,527 B | `01a0d5be-4ca6-7493-b9bf-3193dbb3a3b6` |
| 2 | 2026-09-24 23:29 | #3, after isolation | same | ok · 14.7 s · 2 turns · input tokens 21,826 uncached + 4,224 cache read · 26,141 total · $0.0157 · only `image_gen` offered | 1024×1024 JPEG, 186,408 B | `dc85367b-7d8f-4372-8f99-3bb95c91ec76` |
| 3 | 2026-09-24 23:46 | #4, `animate` with no video flags | `animate "slow camera push-in across the desk; steam rises from the mug and the monitor glow flickers softly" --image hero.jpg` (`hero.jpg` is `docs/hero.jpg`, 1280×720) | ok · 52.9 s · $0.0162 · `image_to_video` received `resolution_name: 720p`, `duration: 6` and the prompt verbatim · only `image_to_video` offered | 1280×720 H.264 24 fps, 6.04 s, AAC audio, 3,525,655 B | `41a276ef-61bb-4bb1-987d-775d7de1e2af` |
| 4 | 2026-09-24 23:47 | #4, `video --draft` | `video "a red paper kite drifting over a quiet beach at dusk" --aspect 16:9 --draft` | ok · 45.4 s · $0.0268 · `image_gen` received `aspect_ratio: 16:9`; `image_to_video` received `resolution_name: 480p`, `duration: 6` · only those two tools offered · manifest records `resolution: 480p`, `duration: 6`, `draft: true` | still 1280×720 JPEG, 221,227 B · clip 736×400 H.264 24 fps, 6.04 s, AAC audio, 1,268,467 B | `f83595e1-da3e-40d0-a022-985af7980344` |
| 5 | 2026-09-25 00:05 | #5, `edit` with Image 2.0 (the default) | `edit "Replace the word ROASTERY with TORREFAÇÃO and the small word COFFEE with CAFÉ. Keep everything else exactly the same." --image logo.jpg` (`logo.jpg` is `docs/variations-1.jpg`, 1024×1024) | ok · 21.4 s · $0.0163 · `image_edit` received the one source image and the instruction verbatim · only `image_edit` offered · manifest records `imageModel: grok-imagine-image-2.0` · both words rendered correctly (TORREFAÇÃO, CAFÉ), the rest of the logo unchanged | 1024×1024 JPEG, 107,415 B | `88a7fde2-645b-441d-8e14-d88592733d9a` |

Session 2's id is the UUID the plugin generated, which confirms Grok accepted `--session-id`. The offered tools come from each session's `tool_definitions.json`.

Runs 3 and 4 used the companion at `0e206ef` (isolation from #3 included) in a scratch workspace. Dimensions, codecs and durations are from `ffprobe`; the arguments each tool received are from the session's `updates.jsonl`. Grok's 480p tier is not 480 lines: from a 1280×720 still, run 4's clip came out 736×400 (1.84:1, slightly wider than the still). Older 480p clips on this machine are 848×480 and, for square stills, 544×544; their sources are gone, so what decides the size is not known. Every clip also carries a second, MJPEG video stream (a cover picture) next to H.264 and AAC.

Run 5 used the companion at `8d76239`. The session log does not name the image model: `updates.jsonl` and the other session files only record the chat model (`grok-4.7`). That the plugin passes `GROK_IMAGE_EDIT_MODEL_OVERRIDE=grok-imagine-image-2.0` is covered by the black-box tests; the live run shows an edit with that override set works on the subscription and renders Portuguese accents correctly.

## Checks that generate nothing

### `grok inspect --json` with and without isolation (2026-09-24, #3)

Run in an empty directory, once with the normal environment and once with the ten `GROK_{CLAUDE,CURSOR}_*_ENABLED=false` variables that media runs set.

| Source | Normal | Isolated |
| --- | --- | --- |
| Skills in `~/.claude/skills` (100) | enabled | disabled |
| Skills provided by Claude plugins (55, including this plugin's 3) | enabled | disabled |
| Claude hooks (9) | enabled | disabled |
| MCP servers from `~/.cursor/mcp.json` (7) and `~/.claude.json` (2) | enabled | disabled |
| Claude plugins (14, including this one) | listed, enabled | listed, enabled |
| Hooks provided by Claude plugins (5) | no status | no status |
| Agents provided by Claude plugins (2, including this plugin's `grok-media`) | no status | no status |
| Grok's built-in agents (3) | loaded | loaded |
| Grok's own skills (`~/.grok/skills`, `~/.agents/skills`, bundled: 61), hook in `~/.grok/hooks` (1) and `config.toml` MCP server (1) | loaded | loaded |

Result: Claude plugins still load under isolation. Their skills are switched off, but the plugins stay enabled, and the hooks and agents they provide report no compatibility status, so they appear to keep loading. No documented variable turns plugins off. Media runs also pass `--no-subagents`, so the agents cannot be spawned. The recursion guard (`GROK_PLUGIN_CC_WORKER`) covers the risk of Grok calling back into this plugin.
