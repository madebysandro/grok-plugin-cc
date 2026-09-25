---
name: grok-generate
description: Route a media request to the Grok plugin — ONLY when the user explicitly asks for Grok ("use Grok", "with Grok", "usa o Grok", "com o Grok", "pelo Grok", or a /grok:* command). Picks the command and options for images (Image 2.0, exact Portuguese text), edits, image-to-video, text-to-video, reference video (consistent people and products, pinned frames, keyframes, preset voices, seamless loops), and the local tools (last frame, join, mute, reframe, text overlay, cutout, sheet split), and knows Grok's real limits. Not for a generic "generate an image" / "make a video" / "gera uma imagem" that does not name Grok — the user chooses the provider each time, and other generators (Higgsfield) are installed too.
---

# Grok Generate

Turn "use Grok to …" into the right plugin command, run it, and hand back the result — the way the Higgsfield skills do, but on the user's Grok subscription through the Grok CLI: no API key, no per-generation charge beyond the plan's weekly quota.

## Only when the user asks for Grok

This skill applies when the request **names Grok**: "use o Grok para…", "gera com o Grok", "pelo Grok", "make it with Grok", "Grok, animate this", or a `/grok:…` command. It does **not** apply to a generic request — "gera uma imagem de…", "make a video of…", "animate this photo" — even though Grok could do it. The user picks the provider for each request, and other generators are installed. With no provider named, do not choose Grok on your own; if the user seems to expect one, ask which.

Once a conversation has settled on Grok for a piece of work ("now animate it", "make three more"), the follow-ups belong to it too.

## UX rules

1. **Reply in the user's language.** Commands and flags stay in English (`--aspect 16:9`).
2. **One question at a time**, and only when something is genuinely missing: no prompt, no source image for an edit or an animation. Otherwise pick the defaults below and go.
3. **Pass the user's prompt through verbatim.** Do not translate, expand, or "improve" it: the plugin sends it to the tool word for word, and Portuguese text in the prompt comes out in Portuguese. The only thing you add is what a command needs — the `<IMAGE_i>` / `<AUDIO_i>` tags of a `ref-video` prompt, placed around the user's own words.
4. **Run in the foreground**, with the Bash tool's `timeout: 600000` (its 2-minute default cuts video short). An image takes 15–35 s, a clip about a minute. Background only when the user asks for it or passes `--background`, or for a batch (several prompts, or `--count 4` and up) — then launch it, stop, and point to `/grok:status`.
5. **Several clips → a draft pass first.** Before spending quota on a sequence, propose `--draft` (the 480p tier, 6 s) for every clip, and re-run the approved ones at 720p.
6. **Never retry automatically.** A failed run is the user's decision point. Relay the reason as the companion gives it; a refusal (exit 1) happened before Grok ran and names the fix.
7. **Deliver the file path and a one-line summary** (what, size, tier/duration). `Read` every generated image so the user sees it. You cannot watch a video: report path, size and what `ffprobe` shows, never the motion or the speech.
8. **Do not generate extras** nobody asked for, and do not quote costs unless asked — the plan's pool is weekly and shared by Chat, Imagine, Voice and Build.

## Running a command

Every command goes through the plugin's companion; never call `grok` directly (the files would stay in Grok's session folder):

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" image "<prompt>" --aspect 16:9`,
  description: "Grok image",
  timeout: 600000
})
```

The same line works for every command below (`edit`, `animate`, `video`, `ref-video`, the local tools…). The slash commands (`/grok:image` …) do exactly this, for when the user types them. Options that do not apply to a command are refused before anything runs, never silently dropped.

## Intent → command

| The user wants | Command | Notes |
| --- | --- | --- |
| An image from a description | `/grok:image "<prompt>"` | Image 2.0 by default. `--aspect` 1:1, 16:9, 9:16, 3:2, 2:3, auto. Short text (a name, a price, accents) is fine drawn directly. |
| Variations of one idea | `/grok:image "<prompt>" --count N` | 1–8, one tool call each. |
| To change an existing image, or combine several | `/grok:edit "<only the change>" --image P [--image P2]` | Describe just the change; the rest is kept. `--aspect` only with 2+ images. |
| The same character or product across a series | `/grok:image` once, then `/grok:edit` from that base | No seed: re-generating rolls a new subject. |
| To animate a still | `/grok:animate "<the motion>" --image P` | 720p, 6 s by default; `--duration 10`. The clip keeps the still's shape: no `--aspect`. |
| A video from a description | `/grok:video "<scene>" [--aspect 16:9]` | An `image_gen` still, then its animation; both files kept. |
| A video that keeps people, products or places from reference images; exact first/last frame; images at chosen moments; someone speaking; a seamless loop; 1–15 s | `/grok:ref-video "<prompt with <IMAGE_i>>" --image …` | See the `ref-video` notes below. |
| To continue a clip into the next | `/grok:last-frame <clip>`, then `/grok:animate "<motion>" --image @last` (or `/grok:ref-video --first-frame @last`) | The real last frame, not the cover picture. |
| To join clips | `/grok:concat a.mp4 b.mp4 …` | Stream copy; clips that differ are refused with `--reencode` suggested. |
| A silent copy | `/grok:mute <clip>` | Every Grok clip has sound. |
| Another aspect ratio for existing media | `/grok:reframe <file> --aspect 9:16 [--mode crop\|pad] [--anchor …]` | `pad` fills with a blurred copy, not bars. 16:9 → 9:16 crops the width: anchor `left`/`center`/`right`. |
| Exact text over a picture — titles, prices, dates, anything long | `/grok:overlay --image P --text "…" [--sub "…"] [--brand brand.json]` | Rendered in HTML at the image's size; never misspelled. Single-quote text with `$`. |
| A transparent cut-out | generate "on a flat pure green (#00FF00) background", then `/grok:cutout @last` | |
| A turnaround or a grid as separate files | generate the sheet on green with clear gaps, then `/grok:split @last --expect N` | |
| To check the CLI, the plan, what is enabled | `/grok:setup` | Costs nothing. |
| A background run's progress, files, or to stop it | `/grok:status`, `/grok:result [job]`, `/grok:cancel [job]` | |
| A non-media task handed to Grok | `/grok:ask "<task>"` | Read-only unless `--write`. |

### `ref-video` in short

- Inputs (at least one): `--image` (repeatable) for references; `--first-frame` / `--last-frame` for the exact ends; `--keyframe PATH@SECONDS` (up to 4, inside the clip, ≥ 1/3 s apart); `--voice ID` (up to 3; e.g. `eve`, `ara`, `leo`, `rex`); `--loop` (one `--image` as first and last frame).
- In the prompt, images are `<IMAGE_0>`, `<IMAGE_1>`… numbered first frame → images in order → keyframes by time → last frame; voices are `<AUDIO_0>`… in flag order. Write a spoken line in the language it should be spoken in.
- `--aspect` 1:1, 16:9 (default), 9:16, 4:3, 3:4, 3:2, 2:3; `--duration` 1–15 (default 6).

### Chaining results

Any file input takes `@last` (the last file the plugin saved in the workspace — a generation or a local tool), `job:<id>` (that job's first file) or `job:<id>#N`. Job ids are in every command's output. A `video` job holds `[still, clip]`, so after it `@last` is the clip and `job:<id>#1` the still.

## What Grok really does (Grok CLI 1.0.41, measured live)

- **Images** come out about 1K: 1024×1024 square, 1280×720 wide. Image 2.0 (the default; `--image-model quality|standard|server` goes back) renders accents and prices right — "TORREFAÇÃO", "CAFÉ", "R$ 5,90". Reference images in an edit are reduced to about 768 px, so small text or a logo inside a reference suffers.
- **Video** is 720p or the 480p tier, nothing higher. 720p is a real 1280×720. The "480p" tier is not 480 lines: 736×400 from a 1280×720 still, 848×480 for a 16:9 `ref-video`, 544×544 for a square one. `animate`/`video` last 6 or 10 s; `ref-video` 1–15 s.
- Every clip is H.264 at 24 fps **with an AAC soundtrack**, plus an MJPEG cover picture as a second video stream.
- `ref-video` took **8 reference images** on 1.0.41 (its schema says 14; older CLIs, 7 — `/grok:setup` shows which). The voice `eve` spoke a Portuguese line intelligibly. `--loop` gave first and last frames with an SSIM of 0.96.
- There is no seed: the same prompt gives a different result each time.
- A Zero Data Retention account cannot make video at all; `/grok:setup` says so up front.

## What does not exist — say so, do not promise it

- 1080p or 4K video (a plan's 1080p is for the Grok app, not the CLI), 2k images, several images from one call.
- Editing or extending an existing video natively. To extend: `last-frame`, then a new clip from it, then `concat`.
- Stand-alone speech, music or sound effects, and cloned voices. Voices exist only inside a `ref-video` clip.
- 3D models, AI upscaling, vector output, seeds or negative prompts, hosted URLs.

## A project's library

Keep what must stay consistent across a project's pieces under `grok-media/library/<name>/`:

- `canonical.png` — the reference image of the character, mascot or product. Feed it as `--image` to `edit` and `ref-video`.
- `turnaround.png` — front, side and back views on green (and the separate views from `/grok:split`).
- `traits.md` — what must not drift: face, proportions, outfit, colours, logo placement.
- `brand.json` — for a brand: colours, fonts, logo, used by `/grok:overlay --brand` (format in the `grok-imagine-prompting` skill).

Create entries only when the user builds one; the step-by-step recipes that use the library come in a later round.

## See also

- `grok-imagine-prompting` — writing prompts, `ref-video` tags, staging for cutout and split, text via overlay.
- `grok-media-results` — checking a result before reporting it, including video with `ffprobe` and extracted frames.
- `grok-cli-runtime` — how the plugin drives the CLI, when something misbehaves.
