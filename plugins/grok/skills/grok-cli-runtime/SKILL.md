---
name: grok-cli-runtime
description: How the Grok plugin drives the Grok CLI — the media tools that actually exist, where generated files land, how assets are harvested from the session log, and the known account-level blockers. Load this when a /grok:* command misbehaves, when wiring new Grok functionality, or before assuming a Grok capability exists.
---

# Grok CLI runtime

How this plugin talks to the Grok CLI, and the details that are easy to get wrong.

## The media toolset

Grok CLI 1.0 exposes exactly four media tools:

| Tool | Purpose |
| --- | --- |
| `image_gen` | New image from a text prompt |
| `image_edit` | Modify an existing image, given one or more source images |
| `image_to_video` | Animate a still into a clip |
| `reference_to_video` | Generate a clip guided by a reference image |

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
- `--tools` is an allowlist, one per command: image → `image_gen`, edit → `image_edit`, animate → `image_to_video`, video → `image_gen,image_to_video`. It still keeps Grok's always-on MCP meta-tools (`search_tool`, `use_tool`), so `--disallowed-tools` stays; when both flags are given the denylist wins. Grok silently ignores names it does not recognise, so listing both `run_terminal_command` and the legacy `run_terminal_cmd` is safe.
- `--session-id` takes a **new** UUID (Grok errors if it is in use). The plugin generates it, so the session folder is known before the run starts.
- `--max-turns` bounds a run that goes sideways.
- `ask` keeps Grok's full toolset and the user's setup: no `--tools`, no isolation variables, and `--disallowed-tools` only for the write tools while it is read-only.

### Isolation from the user's Claude and Cursor setup

Without the ten `GROK_{CLAUDE,CURSOR}_*_ENABLED=false` variables, Grok loads the user's Claude and Cursor skills, agents, hooks, MCP servers and rules into every media run. The before/after measurement of the whole lock-down (`--tools` plus these variables) is in the plugin's `CHANGELOG.md`.

What `grok inspect --json` reports under those variables (1.0.41, 2026-09-24):

- **Switched off** (`compatibilityStatus: disabled`): skills in `~/.claude/skills`, skills that Claude plugins provide (this plugin's three included), Claude hooks, and MCP servers from `~/.claude.json` and `~/.cursor/mcp.json`.
- **Still loaded — Claude plugins.** There is no documented switch for them. Every installed Claude plugin is still listed as enabled, including this one. The hooks and agents plugins provide (this plugin's `grok-media` agent included) report no compatibility status, so they appear to keep loading. `--no-subagents` stops a media run from spawning those agents, and the recursion guard below covers the rest of the risk.
- **Still loaded — Grok's own setup**, by design: skills in `~/.grok/skills`, `~/.agents/skills` and Grok's bundle, hooks in `~/.grok/hooks`, and MCP servers from `~/.grok/config.toml`.

### Recursion guard

Every Grok process the plugin starts, `ask` included, gets `GROK_PLUGIN_CC_WORKER=1`. The companion refuses media commands when that variable is set, so a Grok run the plugin started can never call back into the plugin and start another quota-spending Grok run. `ask` is not refused: it spends no media quota by itself.

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

Roughly $0.13–$0.18 and 25–35 seconds per image on `grok-4.6`, most of it agent tokens rather than the image itself. The envelope's `total_cost_usd` is the real figure for a run. Blocking unnecessary tools is what keeps this from doubling.
