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

To re-check the list on a new CLI version:

```bash
grok -p "List the exact names of every tool you have available that generates or edits images or video. Output only a comma-separated list. Do not call any tool." --always-approve --output-format json
```

## Invocation

```bash
grok -p "<prompt>" --always-approve --output-format json --cwd <dir> \
     --disallowed-tools "run_terminal_command,search_tool,use_tool,..." --max-turns 6
```

- `--output-format json` prints one envelope: `{ text, sessionId, usage, total_cost_usd, num_turns }`. `sessionId` is the key to everything below.
- `--always-approve` is required; a headless run otherwise blocks on tool approval.
- `--disallowed-tools` is the single biggest lever on cost and latency. Without it the agent spends turns copying files with `cp` and hunting for tools through `search_tool`. Grok silently ignores names it does not recognise, so listing both `run_terminal_command` and the legacy `run_terminal_cmd` is safe.
- `--max-turns` bounds a run that goes sideways.

## Where generated files land

Grok writes media into its own session folder, **not** the working directory:

```
~/.grok/sessions/<encodeURIComponent(cwd)>/<session-id>/
  updates.jsonl     # the authoritative event log
  images/1.jpg      # generated assets, numbered per session
```

The plugin copies them out itself rather than asking the agent to. Asking costs an extra turn, and the agent frequently reports a path it did not actually write.

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
