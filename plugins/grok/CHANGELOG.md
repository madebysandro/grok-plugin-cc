# Changelog

## 2.0.0

The first release of the fork [`madebysandro/grok-plugin-cc`](https://github.com/madebysandro/grok-plugin-cc), built on [`arielaizn/grok-plugin-cc`](https://github.com/arielaizn/grok-plugin-cc) 1.0.0 by Ariel Aizenshtat. It brings the plugin closer to the Higgsfield skills: a few generation commands, local tools that need no AI, and a router skill that Claude follows. Everything runs on a Grok subscription through the Grok CLI, with no API key. Measured on Grok CLI 1.0.41.

### Breaking changes

- The marketplace is now named `madebysandro-grok`, so the plugin installs as `grok@madebysandro-grok`, in Claude Code and in Codex. The original keeps `grok-plugin-cc`, and the two marketplaces can be added side by side; to switch, uninstall `grok@grok-plugin-cc` first (`/plugin uninstall` in Claude Code, `codex plugin remove` in Codex).
- Options are checked before Grok runs. On the generation commands and the local tools, one of the plugin's options that the command cannot honour is refused (exit 1, no job, no quota spent) instead of being dropped or sent to Grok as prompt text, so a call that used to pass a stray option now fails. A flag the plugin does not know at all still goes into a Grok command's prompt, as in 1.0.0.
- The media commands refuse `--count` and `--timeout` values outside their range, or that are not whole numbers, instead of clamping them (`--count 20` used to become 8).
- `animate` and `video` ask for 720p, where the tool on its own gives 480p. `--draft` gives the 480p tier.
- `image`, `edit` and the opening frame of `video` use `grok-imagine-image-2.0` by default. `--image-model server` goes back to xAI's default.
- The generation commands run in the foreground unless the user asks for the background.
- `--raw`, `--keep-session` and `--read-only` did nothing in 1.0.0; the generation commands and the local tools now refuse them.
- `ask` refuses to run inside a Grok run this plugin started, and refuses `--image` and the options added in this release.

### Isolated media runs (#3)

- Media commands give Grok only the tools they need (`--tools`: image → `image_gen`, edit → `image_edit`, animate → `image_to_video`, video → `image_gen,image_to_video`, ref-video → `reference_to_video`). They also turn off subagents, web search and auto-update, and run under a session id the plugin generates.
- Media runs switch off Grok's loading of the user's Claude and Cursor setup (`GROK_{CLAUDE,CURSOR}_*_ENABLED=false`): skills, hooks, MCP servers and rules from `~/.claude` and `~/.cursor`, and the skills Claude plugins provide. Claude plugins themselves still load, with their hooks and agents, because Grok has no switch for them; see the `grok-cli-runtime` skill.
- Recursion guard: every Grok process the plugin starts, `ask` included, gets `GROK_PLUGIN_CC_WORKER=1`, and the media commands and `ask` refuse to run when it is set. Grok calling back into the plugin would start another run and spend quota again; through `ask` it could loop. Apart from that, `ask` keeps Grok's full toolset and the user's setup.

Measured on Grok CLI 1.0.41 with one 1:1 image and the same prompt, one run before and one after (details in `docs/live-tests.md`):

| | Before | After | Change |
| --- | --- | --- | --- |
| Wall time | 23.8 s | 14.7 s | −38 % |
| Input tokens, uncached | 28,306 | 21,826 | −23 % |
| Input tokens, cache read | 29,952 | 4,224 | −86 % |
| Total tokens | 58,596 | 26,141 | −55 % |
| Cost reported by Grok | $0.0250 | $0.0157 | −37 % |
| Tools offered to the agent | 15 | 1 | |

There was one run on each side, so treat the times as indicative. The drop in offered tools comes from `--tools`. The token and time savings come from the whole lock-down, and the table does not split them between its parts.

### Options checked before Grok runs (#4)

- Aspect ratios follow each tool: `image_gen`'s list (1:1, 16:9, 9:16, 3:2, 2:3, auto) for `image` and the opening frame of `video`; `image_edit`'s wider list for `edit`, and only with two or more `--image` inputs, since a single-image edit keeps the source's shape. `animate` refuses `--aspect`, because the clip keeps the still's shape.
- `animate` and `video` take 6 or 10 s. `--resolution` takes 480p or 720p (`480` and `720` work too). Anything higher is refused with the explanation that a plan's 1080p applies to the Grok app, not to the CLI.
- 720p is the default. `--draft` asks for the 480p tier, 6 s unless `--duration` says otherwise, and cannot be combined with `--resolution`.
- The manifest records the aspect, duration, resolution and draft of each run.
- One table in `lib/media-spec.mjs` says which commands each option belongs to. Every other generation command refuses it with "--X does not apply to C; it is for …": `--count` is only for `image` and `edit`; `--image` is an input only of `edit`, `animate`, `ref-video` and `overlay`, and `animate` takes one; `--write` is only for `ask`; the video options are only for `animate`, `video` and `ref-video`; the local tools' own options are only for those tools.
- `--count` (1–8) and the media commands' `--timeout` (30–3600 s) are refused out of range. An option missing its value is reported as just that, with no stack trace.
- The local tools refuse options they do not take.
- The prompts no longer carry a stray `- null` rule, left over from 1.0.0.

### Image 2.0 by default (#5)

- `image`, `edit` and the opening frame of `video` ask for `grok-imagine-image-2.0` through `GROK_IMAGE_GEN_MODEL_OVERRIDE` / `GROK_IMAGE_EDIT_MODEL_OVERRIDE`. Image 2.0 renders text with accents correctly: a live edit wrote "TORREFAÇÃO" and "CAFÉ" without errors. The server's own default, `grok-imagine-image-quality`, is retired on 2026-11-02.
- `--image-model 2.0|quality|standard|server` picks the model. `server` passes no override and also removes one inherited from the shell, so xAI's current default applies. The commands that make no image refuse it. The manifest records the model the run asked for as `imageModel`; Grok's session log does not record which model ran.

### Zero-cost compatibility checks in `/grok:setup` (#6)

- Reads the session folders Grok already left on disk, never starts a run, and asks the binary only for `--version` with its update check off.
- Media tools: each of the four is confirmed from the newest session that could tell. A tool is `FAIL` only when a full-toolset session (several non-media tools on offer) lacks it. Runs restricted with `--tools` can only confirm what they were offered, and anything unconfirmed stays "not verified", which never blocks.
- Session log format: in the newest session with media on disk, `updates.jsonl` has to lead to those files. If it leads to all of them the check passes, to only some it warns, and to none it fails with "session log format changed".
- Warns when `image_to_video` or `reference_to_video` names a resolution or duration the plugin does not allow, or stops describing one.
- Detects the old (up to 7 images, no pinned frames) and new (up to 14) `reference_to_video` schema, exposed in `setup --json` as `compat.referenceToVideo`.
- Shows the plan and the image/video switches from `~/.grok/settings_cache.json`, keeping only those four fields and never printing or storing the rest. A switch that is off only warns on the matching check instead of failing it, because the cache's payload format is not pinned down.

### Earlier results as inputs (#7)

- Every file input (`--image`, `--first-frame`, `--last-frame`, `--keyframe`, and a local tool's files) takes `@last` (the last file the plugin saved in this workspace, by a generation or a local tool), `job:<id>` (that job's first file) or `job:<id>#N` (its Nth file, from 1).
- A reference that cannot be honoured fails before Grok runs and names the reason: an unknown job, a job with no files, a file number out of range, a file deleted since (it never falls back to an older one), or a video given to an image input.
- Generations and local tools report their job id, in the text output and as `jobId` in `--json`. A failed or partial generation's `--json` carries it too, so a still that a partial `video` kept is reachable as `job:<id>`.

### `/grok:ref-video` (#8)

- New command for `reference_to_video`: reference images (`--image`, repeatable), exact first/last frames, keyframes pinned at a moment (`--keyframe PATH@SECONDS`), preset voices (`--voice`) and `--loop` (the one image as both first and last frame, with "Locked camera, seamless loop." added to the prompt).
- `--aspect` (default 16:9), `--duration` 1–15 (default 6), `--resolution` (default 720p) and `--draft`. `--image-model` is refused, since the tool makes no still.
- Checked before Grok runs: at least one input; up to 14 reference images, or 7 and no pinned frames when the installed CLI offers the older schema (as `/grok:setup` detects it); up to 3 voices, each shaped like a voice id; up to 4 keyframes, strictly inside the clip even after Grok snaps them to its 1/3-second grid, and at least 1/3 s apart. Keyframes are sent in time order, which is how their `<IMAGE_i>` tags count.
- Grok receives the structured arguments as exact JSON and the prompt verbatim, with `reference_to_video` as its only tool.
- Voice ids are not checked locally: xAI's public docs list the roster only as an example, so an unknown id reaches Grok, whose error names the available voices.
- Live on 1.0.41: 8 reference images accepted (above the 7 of the older schema); the voice `eve` spoke a Portuguese line intelligibly; `--loop` gave first and last frames with an SSIM of 0.96.

### Local video tools: `/grok:last-frame`, `/grok:concat`, `/grok:mute`, `/grok:reframe` (#9)

- `last-frame <video>` saves the last frame the clip really shows as a PNG, the start of the next clip.
- `concat <video>...` joins clips by copying their streams. Clips that differ from the first in size, frame rate, codecs, sound or stream order are refused with a per-clip listing and `--reencode` suggested; `--reencode` scales, pads, conforms the frame rate and fills missing sound with silence.
- `mute <video>` drops the soundtrack without re-encoding the picture.
- `reframe <image|video> --aspect W:H [--mode crop|pad] [--anchor center|top|bottom|left|right]` crops to the largest window, or pads on a blurred copy of the picture. Videos are re-encoded to even sizes with their sound copied. An anchor on the side that does not change, or a ratio the picture already has, is refused.
- They read the first real video stream, so the MJPEG cover picture in every Grok clip never becomes a frame, a segment or an extra track.
- Like every local tool, they run ffmpeg on this machine with no Grok call and no quota. All checks pass before anything is written, a failed run removes its half-written output, and each run records a job and a manifest entry naming the program that made the file (`tool: "ffmpeg"`). Exit 1 is a refusal, a message on stderr. Exit 2 is a failure of the tool itself, which with `--json` prints `{ ok: false, command, reason }` on stdout, as a failed generation does, and records no job.

### `/grok:overlay` (#10)

- `overlay --image I --text "…" [--sub "…"] [--brand brand.json] [--position top|center|bottom] [--style clean|bold|glass]` sets exact text (titles, prices, dates) over an image. The text is laid out in HTML at the image's own size and rendered by headless Chrome to a PNG of exactly that size. No Grok, no quota, no misspelled words.
- `brand.json` gives the colours, fonts and logo. A font is a Google Fonts family or a font file, which is embedded so rendering needs no network. Colours and font names that could inject CSS are refused. The format is in the `grok-imagine-prompting` skill.
- The render waits for fonts and images and names a brand font that did not load. Text that would run past the picture is refused instead of cropped, and a transparent picture stays transparent.
- Chrome runs with a throwaway profile and `--use-mock-keychain`, so macOS never shows a keychain dialog. It is killed with its helpers when the render ends or `--timeout` (1–600 s, default 60) runs out. `CHROME_PATH` picks the binary; otherwise the macOS app, then `google-chrome` or `chromium` on the PATH.

### `/grok:cutout` and `/grok:split` (#11)

- Two local image tools, run with Python 3 (Pillow, numpy, scipy) through `scripts/chroma.py`, with no Grok, no quota, and no OpenCV or rembg. A missing Python or library is named with the `pip install` that adds it; nothing is installed.
- `cutout <image>` clears a flat background (`--key`, default `#00FF00`) to transparency, with a soft edge past `--tolerance` (RGB distance, default 80). It removes the key colour's spill along the cut edge only (3 px, or 1% of the shorter side on larger images), so a green subject keeps its own colour.
- `split <sheet>` writes one transparent PNG per item, found as separate shapes, following the recipe in Grok's bundled sheet guide. A small piece closer than 3% of the sheet's width to a much bigger item joins it; items of similar size never merge, so a tight grid stays a grid. Specks under 0.05% of the sheet's area are dropped. Items are numbered row by row and share one canvas with a margin of about 6%, standing on one baseline. `--expect N` refuses a different count, an item touching the sheet's edge is refused, `--bg auto` reads the background from the corners, and a sheet with transparency is split along it.
- Both take `@last` and `job:<id>[#N]`, check everything before writing, and record a job and manifest entry with `tool: "python"`. A tool that writes several files makes each reachable as `job:<id>#N`.

### Foreground by default, and a one-time git notice (#12)

- The generation commands (`image`, `edit`, `animate`, `video`, `ref-video`) run in the foreground, with the Bash tool's longest timeout (10 minutes, where the default is 2). They go to the background only when the user passes `--background` or asks for it, or for a batch. The local tools already ran in the foreground.
- `--background` no longer ends up in the prompt sent to Grok. Slash commands pass `$ARGUMENTS` through, and the companion now takes the flag out; the local tools, which always run in the foreground, refuse it.
- When a run (a generation, a partial one, or a local tool) saves into a folder of a git repository and git would pick up any of the files, or the manifest (`git check-ignore`), its output says so, once per folder in each workspace. The note is kept with the job, so `/grok:result` shows it after a background run, and parallel runs show it only once. Outside a repository, with everything ignored, or without git, nothing is said. `.gitignore` is never touched.

### Skills and agent (#13)

- New `grok-generate` skill, the router: it maps a request to the right command and options, runs it, and hands back the path with a one-line summary. It applies only when the user explicitly asks for Grok, never to a generic "generate an image", since the user picks the provider each time. It carries the UX rules (the user's language, one question at a time, the prompt verbatim, the foreground, a `--draft` pass before a sequence, no automatic retry), an intent → command table over all seventeen commands, the limits measured live, what does not exist, and the `grok-media/library/<name>/` convention for a project's recurring characters, products and brands.
- `grok-cli-runtime`, `grok-imagine-prompting` and `grok-media-results` cover the new commands and the measured limits: per-tool limits and isolation, `ref-video` tags and their order, text through Image 2.0 or `overlay`, staging for `cutout` and `split`, and checking a clip with `ffprobe` and extracted frames.
- The `grok-media` agent knows the new commands, runs in the foreground, stops after a draft pass to report it, and uses `overlay` for exact text.

### `ask`

- `ask` takes the options the original plugin's `ask` took (`--write`, `--model`, `--effort`, `--timeout`, `--json` and the other shared ones), whether or not they do anything for it. It refuses every other option with the usual "does not apply" message, even written as `--flag=false`: the ones this release added (`--image-model`, `--draft`, `--resolution`, `--loop`, `--text`, …) and `--image`, which 1.0.0 parsed but `ask` never used.
- Its `--timeout` is brought into 30–3600 s as in 1.0.0, and a malformed value means the default; the media commands refuse both. `--raw`, `--keep-session` and `--read-only` stay accepted and inert, as they do on `status`, `result`, `cancel` and `setup`.
- It is refused under the recursion marker (see #3), and is otherwise unchanged: read-only unless `--write`, with Grok's full toolset. Its `--json` output now names the command.

### Documentation, tests and packaging (#2, #14)

- Help and command docs: the `data:` URL form is for the image inputs of `edit`, `animate` and `ref-video` only, not for `overlay` or the other local tools; `status` lists recent jobs of every kind; `edit`'s argument hint shows `--aspect`; the docs speak of the plan's quota rather than money.
- Black-box tests run the companion as a process against a fake `grok` in a sandbox, with no network, no Grok CLI and nothing read from the real `~/.grok` or plugin state. Tests that need ffmpeg, Python with its libraries, or Chrome skip when those are missing. Document checks make sure every command is routed and listed, no document names a command that does not exist, and every foreground generation example has the 10-minute timeout. Release checks keep one version across the manifests, their links on the fork, the README's install lines on this marketplace, and a CHANGELOG section for that version. No document Claude reads talks of money, and all define `@last` the same way.
- The README is rewritten for the fork. Plugin, marketplace and package are at 2.0.0, with `homepage` and `repository` pointing at the fork. The marketplace's owner is Sandro Roberto; the plugin's author is still Ariel Aizenshtat. `docs/live-tests.md` logs the 9 live generations the round used, of the 12 it allowed.

### Known limitations

- A flag the plugin does not know at all (`--seed 5`) is not refused as an option: on a Grok command it goes to Grok as part of the prompt, like any stray word. A local tool takes it for one of its inputs and stops with its usage line.
- The argument parser only knows `--flag` and `--flag=false` for switches, and gives a value option exactly one word. So `--draft false` sends "false" to Grok as part of the prompt, `--draft=0` and `--draft=no` count as true, and `--duration 10 s` sends "s" as prompt text (`--duration 10s` works).
- The payload format of `~/.grok/settings_cache.json` is not confirmed. `/grok:setup` may show the plan as "unknown", which only means not verified.
- The recursion guard only recognises Grok runs the plugin started. A Grok session the user opens themselves, with this Claude plugin loaded, carries no marker, and its calls into the plugin are not refused.
- Claude plugins, with their hooks and agents, still load inside isolated media runs, because Grok has no switch for them (`--no-subagents` keeps the agents from being spawned).

## 1.0.0

Initial release.

- `/grok:image`, `/grok:edit`, `/grok:video`, `/grok:animate` for media generation
- `/grok:ask` for general delegation to Grok
- `/grok:setup`, `/grok:status`, `/grok:result`, `/grok:cancel`
- `grok-media` subagent for multi-asset work
- Skills: `grok-cli-runtime`, `grok-imagine-prompting`, `grok-media-results`
- Assets harvested from Grok's session log rather than copied by the agent
- Zero Data Retention video blocking detected and explained up front
