---
name: grok-media-results
description: How to verify and report the output of a Grok media run — checking an image matches the brief, checking a video with ffprobe and extracted frames, what can and cannot be claimed about a clip, handling refusals, partial and failed runs, and iterating without wasting quota. Load after any /grok:image, /grok:edit, /grok:animate, /grok:video or /grok:ref-video run, and after the local tools (/grok:last-frame, /grok:concat, /grok:mute, /grok:reframe, /grok:overlay, /grok:cutout, /grok:split).
---

# Reporting Grok media results

A generation that produced a file is not the same as a generation that worked.

## Verify an image before reporting

`Read` each saved image and actually look at it. Check:

- The subject is what was asked for, not an adjacent thing.
- The composition and aspect ratio match the request.
- Any text in the frame is spelled correctly, accents included. Image 2.0 (the default model) gets short text right far more often than older models, but look anyway; if it is wrong, lay the text on with `/grok:overlay` instead of regenerating.
- For an edit: the requested change happened, and nothing else drifted.
- For a cut-out or a split: the edges are clean and no item was clipped.

Then report what you saw. If two of four images missed the brief, say which two and how.

## Verify a video without watching it

You cannot watch a clip, but you can measure it and look at its frames. Every Grok clip has three streams: H.264 video, AAC audio, and an MJPEG **cover picture** stored as a second video stream. Always address the real video as `v:0` (or `V:0`); the cover is not a frame of the clip.

```bash
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate:format=duration -of default=nw=1 clip.mp4
ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 clip.mp4   # empty after /grok:mute
```

What to expect:

- 720p is a real 1280×720 for a 16:9 still.
- The 480p tier (`--draft`) is **not** 480 lines: 736×400 from a 1280×720 still, 848×480 for a 16:9 `ref-video`, 544×544 for a square one. Report the size ffprobe gives, not "480p".
- Duration: 6 or 10 s for `animate`/`video`, what was asked (1–15 s) for `ref-video`; the file is a few hundredths of a second longer.
- An audio stream, unless the clip was muted.

To see what a clip shows, extract frames from the main stream and `Read` them:

```bash
ffmpeg -v error -y -ss 0 -i clip.mp4 -map 0:v:0 -frames:v 1 first.png
ffmpeg -v error -y -ss 3 -i clip.mp4 -map 0:v:0 -frames:v 1 middle.png
```

(`/grok:last-frame` gives the real last frame, and records it as a job.) From frames you may say what the clip *shows* at those moments — the subject, the setting, whether a pinned first or last frame matches its image, whether a `--loop` clip starts and ends on the same picture. You may not say anything about the motion, the pacing, or what is said: you did not see or hear it. A voice clip's speech needs the user's ears; ask them.

## Reading the outcome

- **Exit 1 — refused.** An option or input was wrong, and the message says how to fix it. Nothing ran and no quota was spent: fix and re-run.
- **Exit 0 — completed.** Files listed, each with its size; the summary line ends with the job id (`--json` gives `jobId`).
- **Exit 2 — partial or failed.** *Partial*: something was produced but not what was asked — most often a `/grok:video` whose still generated and whose animation failed; the still is kept and labelled intermediate. Never present it as the finished video. *Failed*: no usable output; the reason is stated. Relay it rather than paraphrasing.

Notes may follow a result: a brand font that did not load (`overlay`), or — once per output folder in a workspace — that the folder sits inside a git repository that does not ignore it. Relay them; the plugin never edits `.gitignore` itself.

## Failure modes worth recognising

**Zero Data Retention blocking video.** `HTTP 400 ... Zero Data Retention teams must provide output.upload_url`. An xAI account setting, not a prompt problem; every retry fails the same way. Relay it and stop — images still work, so say that too.

**Moderation block.** Stop. Tell the user what was blocked and offer a different direction. Do not reword the prompt to evade the filter.

**Grok never called the tool.** Usually the prompt read as a question rather than a generation request. Rephrase it as a direct instruction.

**Unknown voice.** `ref-video --voice` with an id Grok does not know fails at the tool, which lists the valid voices; the output relays them.

**Timeout.** Re-run with `--timeout <seconds>` (30–3600). Video runs legitimately take a minute or more.

## Iterating without burning quota

Every generation spends the plan's weekly pool (shared by Chat, Imagine, Voice and Build). A run typically takes 15–65 s.

- **Never retry automatically.** A failed run is a decision point for the user, not a loop for you.
- **Edit, do not regenerate.** One detail wrong means `/grok:edit` on the existing file. Regenerating rolls a fresh subject, since there is no seed.
- **Draft first for sequences.** `--draft` (the 480p tier, 6 s) for every clip; re-run only the approved ones at 720p.
- **Do not generate extras** nobody asked for.
- **Check `/grok:setup` first** when video is part of a plan, before spending anything on the stills leading up to it.

## Where files go

Everything is saved into the output directory (default `grok-media/`), named from the prompt or `--name`, numbered, and never overwritten — a repeat run appends `-2`, `-3`. Each run is a job, so `@last` and `job:<id>` pick its files up in the next command.

`grok-manifest.json` in that directory records every run: the command, the prompt actually sent to the tool, the aspect ratio, the image model (`imageModel`), the duration, resolution and whether it was a draft, the session id and the cost — and, for local tools, their inputs, settings and the program that made the file (`ffmpeg`, `chrome`, `python`). When a user asks how a file was made, read the manifest rather than guessing.
