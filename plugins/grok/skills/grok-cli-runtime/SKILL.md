---
name: grok-cli-runtime
description: How the Grok plugin drives the Grok CLI — the media tools that actually exist, where generated files land, how assets are harvested from the session log, and the known account-level blockers. Load this when a /grok:* command misbehaves, when wiring new Grok functionality, or before assuming a Grok capability exists.
---

# Grok CLI runtime

How this plugin talks to the Grok CLI, and the details that are easy to get wrong.

## The media toolset

Grok CLI 1.0 exposes exactly four media tools:

| Tool | Purpose | Limits (1.0.41) |
| --- | --- | --- |
| `image_gen` | New image from a text prompt | `aspect_ratio` passed through unchecked: Image 2.0 takes 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 2:1, 1:2, 19.5:9, 9:19.5, 20:9, 9:20, 21:9, 5:2 and auto (the tool's description lists fewer; 21:9 ran live), older models all but 21:9 and 5:2; the CLI fixes one image at "1k" (1024×1024, 1280×720, 1568×672) |
| `image_edit` | Modify an existing image, given one or more source images | up to 5 sources on Image 2.0, 3 on older models; a JPEG or PNG of up to 400 KB is sent as it is, anything else shrunk to 768 px / 400 KB; `aspect_ratio` only for multi-image edits, same list as `image_gen` |
| `image_to_video` | Animate a still into a clip | `duration` 6 or 10; `resolution_name` 480p or 720p (the tool defaults to 480p; the plugin asks for 720p); no aspect — the clip keeps the still's shape |
| `reference_to_video` | Generate a clip from reference images, pinned first/last frames, keyframes and preset voices (`/grok:ref-video`, and `/grok:animate` for lengths other than 6 or 10 s) | `aspect_ratio` 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3; `duration` 1–15; `images` up to 14 (7 on the older schema; 8 ran live), `voices` up to 3, `keyframes` up to 4 on a 1/3 s grid |

Anything above 720p is refused by the CLI itself (`resolution_name must be one of: 480p, 720p`) — a plan's 1080p is for the Grok app. The plugin checks every limit it knows before starting Grok (`lib/media-spec.mjs`), so a bad option costs nothing.

### What the CLI sends, whatever the Imagine API allows

From the CLI's source (github.com/xai-org/grok-build, as of 1.0.41) and xAI's docs:

- **One image per call, at 1K, with no quality.** `image_gen` and `image_edit` send `n: 1` and `resolution: "1k"`, and never `quality`, so Image 2.0 serves its `auto` tier: `low` for a generation, `medium` for an edit. The API's 2K, `n` up to 10 and `quality` are out of reach. Several calls issued in one step run in parallel (8 at most by default), which is how `--count` stays quick.
- **Edit references.** `compress_reference` passes a JPEG or PNG of up to 400 KB through untouched, at any pixel size, and re-encodes anything else to 768 px and 400 KB. The service took a 1536 px reference in a live run, so the plugin sends a larger photo as a 1536 px copy of under 400 KB (`lib/ref-prep.mjs`, `scripts/refprep.py`, Python with Pillow) instead of letting the CLI shrink it.
- **Video.** The video tools call `grok-imagine-video-1.5`, fixed in the source. The API's text-to-video, 1080p, silent clips, video editing and extension are not tools.
- **A first frame, any length.** `reference_to_video` with only `first_frame` animates that still for 1–15 s. `animate` uses it for the lengths `image_to_video` does not take, with the aspect ratio of its list closest to the still (a note says when the still has none of them); at 480p it gave 736×400 from a 1280×720 still, like `image_to_video`.

`/grok:setup` watches for this changing: it warns when a media tool starts or stops taking a parameter (a `resolution`, `quality` or `n` appearing would be worth offering), and when xAI's public model list (docs.x.ai/developers/models.md, read without credentials) names an image or video model newer than the plugin's, or the release notes retire one of them. `GROK_PLUGIN_DOCS_URL=off` skips the latter.

**There is no `video_gen`.** The name appears in the binary's tool table but is never offered to the agent. Asking for it by name makes the model search MCP discovery for several turns and then report `'video_gen' is not a valid MCP tool name` — a confusing failure that looks like a plugin bug.

So text-to-video is a two-step run: `image_gen` for the opening frame, then `image_to_video` to animate it. That is what `/grok:video` does, and both artefacts are kept.

To re-check the list on a new CLI version, run `/grok:setup`. It costs nothing: it reads the `tool_definitions.json` Grok writes into each session folder instead of starting a run. For each media tool it trusts the newest session that either offered the tool or offered Grok's whole toolset (several non-media tools). Runs restricted with `--tools` (every plugin media run) list only what they asked for, so a tool is reported missing only when a full-toolset session lacks it; otherwise it stays "not verified", which never blocks. The same check reads the `reference_to_video` schema (old: up to 7 images, no pinned frames; new: up to 14 with first/last frame and keyframes) and warns when a video tool's description names a resolution or duration the plugin does not allow.

## Invocation

`lib/invocation.mjs` builds every run. A media run looks like this:

```bash
GROK_CLAUDE_{SKILLS,AGENTS,HOOKS,MCPS,RULES}_ENABLED=false \
GROK_CURSOR_{SKILLS,AGENTS,HOOKS,MCPS,RULES}_ENABLED=false \
GROK_PLUGIN_CC_WORKER=1 \
grok -p "<prompt>" --always-approve --output-format json --cwd <dir> --max-turns 6 \
     --tools image_gen --disallowed-tools "run_terminal_command,search_tool,use_tool,..." \
     --no-subagents --disable-web-search --no-auto-update --session-id <new uuid>
```

- `--output-format json` prints one envelope: `{ text, sessionId, usage, total_cost_usd, num_turns }`. `sessionId` is the key to everything below.
- `--always-approve` is required; a headless run otherwise blocks on tool approval.
- `--tools` is an allowlist, one per command: image → `image_gen`, edit → `image_edit`, animate → `image_to_video` (or `reference_to_video` for other lengths), video → `image_gen,image_to_video`, ref-video → `reference_to_video`. It still keeps Grok's always-on MCP meta-tools (`search_tool`, `use_tool`), so `--disallowed-tools` stays; when both flags are given the denylist wins. Grok silently ignores names it does not recognise, so listing both `run_terminal_command` and the legacy `run_terminal_cmd` is safe.
- `--session-id` takes a **new** UUID (Grok errors if it is in use). The plugin generates it, so the session folder is known before the run starts.
- `--max-turns` bounds a run that goes sideways.
- `ask` keeps Grok's full toolset and the user's setup: no `--tools`, no isolation variables, and `--disallowed-tools` only for the write tools while it is read-only.

### Isolation from the user's Claude and Cursor setup

Without the ten `GROK_{CLAUDE,CURSOR}_*_ENABLED=false` variables, Grok loads the user's Claude and Cursor skills, agents, hooks, MCP servers and rules into every media run. The before/after measurement of the whole lock-down (`--tools` plus these variables) is in the plugin's `CHANGELOG.md`.

What `grok inspect --json` reports under those variables (1.0.41, 2026-09-24):

- **Switched off** (`compatibilityStatus: disabled`): skills in `~/.claude/skills`, skills that Claude plugins provide (this plugin's three included), Claude hooks, and MCP servers from `~/.claude.json` and `~/.cursor/mcp.json`.
- **Still loaded — Claude plugins.** There is no documented switch for them. Every installed Claude plugin is still listed as enabled, including this one. The hooks and agents plugins provide (this plugin's `grok-media` agent included) report no compatibility status, so they appear to keep loading. `--no-subagents` stops a media run from spawning those agents, and the recursion guard below covers the rest of the risk.
- **Still loaded — Grok's own setup**, by design: skills in `~/.grok/skills`, `~/.agents/skills` and Grok's bundle, hooks in `~/.grok/hooks`, and MCP servers from `~/.grok/config.toml`.

### Image model

`image`, `edit` and `video` (its opening frame) ask for **`grok-imagine-image-2.0`**, xAI's current image model, by default, through `GROK_IMAGE_GEN_MODEL_OVERRIDE` (for `image_gen`) or `GROK_IMAGE_EDIT_MODEL_OVERRIDE` (for `image_edit`) in the run's environment. Without an override the CLI falls back to `grok-imagine-image-quality`, which xAI retires on 2026-11-02 (Image 2.0 at `low` serves it from then on); the plugin no longer offers it. `--image-model standard` (`grok-imagine-image`, 1.0, which expands the prompt before generating — the result says so), `server` (no override; an inherited one is removed too) or a model id (`grok-imagine-image-…`, passed as it is, for a model newer than the plugin) switch it. The variable is honoured — a made-up model name fails with an HTTP 404 naming it — but the session log never records which image model ran; the manifest records the one asked for.

### Recursion guard

Every Grok process the plugin starts, `ask` included, gets `GROK_PLUGIN_CC_WORKER=1`. The companion refuses the media commands **and `ask`** when that variable is set, so a Grok run the plugin started can never call back into the plugin and start another Grok run — Grok → `ask` → Grok could loop just as well as a media command, and every run draws on the plan's weekly pool, which Chat, Imagine, Voice and Build share.

The guard only recognises Grok runs the plugin started. A Grok session the user opens themselves, with this Claude plugin loaded, carries no marker and is not refused.

## Where generated files land

Grok writes media into its own session folder, **not** the working directory:

```
~/.grok/sessions/<encodeURIComponent(cwd)>/<session-id>/
  updates.jsonl     # the authoritative event log
  images/1.jpg      # generated assets, numbered per session
```

The plugin copies them out itself rather than asking the agent to. Asking costs an extra turn, and the agent frequently reports a path it did not actually write.

`/grok:setup` re-checks this on every CLI version at no cost: in the newest session with media on disk, the log must lead to those files. If it leads to none, the log format changed and setup fails with "session log format changed".

Note the bucket is keyed on the cwd Grok resolved, which may differ from the one passed in — `/tmp` versus `/private/tmp` on macOS, for instance. `resolveSessionDir` tries the encoded path, then the real path, then scans every bucket for the session id.

### The plugin's own records

Job records (what `/grok:status`, `/grok:result`, `@last` and `job:<id>` read), run logs and one-time notices live in the plugin's data folder, under `state/<workspace>-<hash>/`: `GROK_PLUGIN_DATA` when set, else `CLAUDE_PLUGIN_DATA` when it is this plugin's own (`…/plugins/data/grok-<marketplace>`), else the data folder Claude Code keeps for the installed plugin, else a temp directory. Another plugin's `CLAUDE_PLUGIN_DATA` is never used: the Codex plugin's SessionStart hook exports its own into every command of a session, and its `state/` has the same layout, so sharing it would mix both plugins' jobs and drop its settings. Records written there before 3.0.0 stay where they are; the history starts afresh in the right folder.

## What comes back

- Images: JPEG at about 1K.
- Clips: H.264 at 24 fps **with an AAC soundtrack, always**, plus an MJPEG cover picture as a second video stream (`attached_pic`). Tools that read a clip must use the first real video stream (`v:0`), not "any video stream" — the plugin's local tools pick streams by index for this reason.
- 720p gave a real 1280×720 for a 16:9 still. The 480p tier is not 480 lines: `image_to_video` gave 736×400 from a 1280×720 still, and so did `reference_to_video` with only that still as `first_frame`; with reference images it gave 848×480 for `aspect_ratio: 16:9` whatever their shape. Older 480p clips of square stills on the test machine were 544×544; what decides the size is not known.

## Harvesting assets from `updates.jsonl`

Each line is `{ timestamp, method: "session/update", params: { sessionId, update } }`.

A successful media call ends with an update carrying:

```json
{
  "sessionUpdate": "tool_call_update",
  "toolCallId": "call-...",
  "status": "completed",
  "rawOutput": { "type": "ImageGen", "path": "/Users/.../images/1.jpg", "filename": "1.jpg", "session_folder": "images" }
}
```

`rawInput` on the preceding update holds the prompt the agent actually sent, which is worth recording — it is not always the prompt the user wrote.

### The trap

The **terminal update of a failed call carries no tool metadata at all**:

```json
{
  "sessionUpdate": "tool_call_update",
  "toolCallId": "call-...",
  "status": "failed",
  "content": [{ "type": "content", "content": { "type": "text", "text": "Tool `image_to_video` failed: ..." } }],
  "rawOutput": { "error": "tool_execution_failed", "message": "..." }
}
```

No `_meta["x.ai/tool"]`, no `rawInput.variant`, no `rawOutput.type`. A filter that only matches media-looking updates drops it, and the call is left looking merely pending — the failure vanishes and the command reports "no output" with no reason. Once a `toolCallId` is known to be a media call, every later update for it must be consumed. `tests/session.test.mjs` locks this behaviour in.

## Known blockers

### Zero Data Retention blocks video

On an account with `coding_data_retention_opt_out: true` in `~/.grok/auth.json`, every video call fails:

```
HTTP 400 Bad Request: {"code":"invalid-argument",
 "error":"Zero Data Retention teams must provide output.upload_url for video generation."}
```

xAI requires ZDR callers to supply an upload destination, and the CLI exposes no such parameter. There is no client-side workaround; the account setting has to change. Image generation and editing are unaffected. `/grok:setup` reports this up front so it is not discovered mid-pipeline.

### No seed, no reproducibility

There is no seed, negative prompt, or guidance parameter. The same prompt gives a different image every time. For a consistent subject across images, generate one base and derive the rest with `image_edit`.

## Cost

On a subscription a run draws on the plan's weekly pool (shared by Chat, Imagine, Voice and Build); the envelope's `total_cost_usd` is what the agent turn would have cost. Live runs on 1.0.41 with `grok-4.7`, isolated: $0.012–0.027 each, an image in 15–35 s, a clip in 45–65 s, about 26–31k input tokens. Before the isolation, the same image took 23.8 s and 58.6k input tokens (see the plugin's `CHANGELOG.md` and `docs/live-tests.md`). Most of the cost is agent tokens, not the media; blocking tools and the user's setup is what keeps it down.
