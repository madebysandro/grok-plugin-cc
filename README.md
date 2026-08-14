# Grok plugin for Claude Code

Generate and edit images and video with the [Grok CLI](https://github.com/xai-org/grok-cli), without leaving Claude Code. Also installable in Codex and Grok itself — they read the same plugin format.

Built in the shape of [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc), which does the same thing for Codex code review and delegation.

## What you get

| Command | What it does |
| --- | --- |
| `/grok:image` | Generate images with `image_gen` |
| `/grok:edit` | Edit an existing image with `image_edit` |
| `/grok:video` | Generate a video (`image_gen` → `image_to_video`) |
| `/grok:animate` | Animate a still you already have |
| `/grok:ask` | Delegate a general task to Grok |
| `/grok:setup` | Check the CLI is installed, signed in, and what it can generate |
| `/grok:status` · `/grok:result` · `/grok:cancel` | Manage background jobs |

Plus a `grok-media` subagent for multi-asset work, and three skills covering the CLI's runtime behaviour, prompt craft, and how to verify results.

## Requirements

- **Grok CLI**, signed in — install from [xai-org/grok-cli](https://github.com/xai-org/grok-cli), then `grok login`. Usage counts against your xAI account.
- **Node.js 18.18+**

## Install

In Claude Code:

```
/plugin marketplace add arielaizn/grok-plugin-cc
/plugin install grok@grok-plugin-cc
/reload-plugins
/grok:setup
```

In Codex:

```bash
codex plugin marketplace add https://github.com/arielaizn/grok-plugin-cc
codex plugin add grok
```

## Usage

```bash
/grok:image a vintage brass telescope on a wooden desk beside an open star chart, warm lamplight --aspect 16:9
/grok:image three logo concepts for a coffee roastery, flat vector, single color --count 3 --out logos
/grok:edit  change the lamp glass to deep blue and cool the scene to moonlight --image grok-media/telescope-1.jpg
/grok:animate slow push-in, dust drifting through the light --image grok-media/telescope-1.jpg
/grok:ask   what would break if we moved session state into Redis?
```

Files land in `grok-media/` by default (`--out` to change it), named from the prompt or `--name`, numbered, and never overwritten. A `grok-manifest.json` records the prompt actually sent, the aspect ratio, the tool used, and the cost of each run.

### Options

| Option | Meaning |
| --- | --- |
| `--out DIR` | Output directory (default `grok-media/`) |
| `--aspect RATIO` | `1:1`, `16:9`, `9:16`, `4:3`, `3:4` |
| `--count N` | Number of images, 1–8 |
| `--name SLUG` | Filename stem |
| `--image PATH` | Source image for `edit`/`animate`; repeatable for `edit` |
| `--model` · `--effort` | Grok model and reasoning effort |
| `--timeout SECS` | Run timeout |
| `--json` | Machine-readable output |
| `--verbatim=false` | Let Grok rewrite your prompt instead of passing it through |

## Things worth knowing

**Your prompt is passed through verbatim.** Grok's bundled `imagine` skill otherwise rewrites prompts, which quietly discards art direction you were explicit about. Pass `--verbatim=false` when you *want* it elaborated.

**There is no text-to-video tool.** Grok CLI 1.0 exposes `image_gen`, `image_edit`, `image_to_video`, and `reference_to_video` — no `video_gen`, despite the name appearing in the binary. `/grok:video` therefore runs two steps: generate the opening frame, then animate it. Both files are kept.

**Video fails on Zero Data Retention accounts.** If your xAI account has `coding_data_retention_opt_out: true`, every video call returns:

```
HTTP 400: Zero Data Retention teams must provide output.upload_url for video generation.
```

xAI requires ZDR callers to supply an upload destination and the CLI exposes no such parameter, so there is no client-side workaround — the account setting has to change. Images and editing are unaffected. `/grok:setup` reports this up front rather than letting you find out mid-pipeline.

**There is no seed.** The same prompt gives a different image every time. For a consistent character or product across a series, generate one base image and derive the rest with `/grok:edit`.

**Assets are harvested from Grok's session log,** not by asking the agent to copy them. Grok writes media to `~/.grok/sessions/<encoded-cwd>/<session-id>/images/`; the plugin reads `updates.jsonl` for the reported paths and copies the files out itself. That costs no extra turn and cannot be paraphrased away.

**Cost.** Roughly $0.13–$0.18 and 25–35 seconds per image, mostly agent tokens rather than the image. Nothing retries automatically.

## Development

```bash
npm test        # 55 tests, no network, no Grok CLI required
```

The companion is also a plain CLI:

```bash
node plugins/grok/scripts/grok-companion.mjs setup
node plugins/grok/scripts/grok-companion.mjs image "a red apple" --out ./shots --json
```

Layout:

```
plugins/grok/
  commands/     slash commands
  agents/       grok-media subagent
  skills/       runtime, prompting, result-handling
  scripts/
    grok-companion.mjs
    lib/
      grok.mjs      CLI discovery, headless invocation, auth and ZDR detection
      session.mjs   session-log parsing and media-call extraction
      assets.mjs    copying assets out, naming, manifest
      prompts.mjs   the instruction templates sent to Grok
      state.mjs     per-workspace job tracking
      render.mjs    output formatting
      args.mjs      argv parsing
```

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with xAI or OpenAI. "Grok" is a trademark of xAI.
