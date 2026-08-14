---
name: grok-media-results
description: How to verify and report the output of a Grok media run — checking the file actually matches the brief, what can and cannot be claimed about a video, handling partial and failed runs, and iterating without wasting money. Load after any /grok:image, /grok:edit, /grok:video, or /grok:animate run.
---

# Reporting Grok media results

A generation that produced a file is not the same as a generation that worked.

## Verify before reporting

For images, `Read` each saved file and actually look at it. Check:

- The subject is what was asked for, not an adjacent thing.
- The composition and aspect ratio match the request.
- Any text in the frame is spelled correctly — this is where image models fail most often.
- For an edit: the requested change happened, and nothing else drifted.

Then report what you saw. If two of four images missed the brief, say which two and how. A user who is told "generated 4 images" and then opens four wrong ones has been given a worse answer than one who was told the truth.

For video, you cannot watch the file. Report the path and size, and say nothing about the motion, pacing, or quality — you do not know. Inventing a description of a clip you cannot see is fabrication, whatever it is dressed up as.

## Reading the outcome

The companion exits `0` only when the run produced what was asked for. Exit `2` means something is wrong, and the output says what.

- **Completed** — files listed, each with its size and the prompt that made it.
- **Partial** — some files were produced but the run did not finish. Most often a `/grok:video` run whose still frame generated and whose animation step failed. The still is kept and labelled as intermediate. Never present it as the finished video.
- **Failed** — no usable output. The reason is stated; relay it rather than paraphrasing.

## Failure modes worth recognising

**Zero Data Retention blocking video.** `HTTP 400 ... Zero Data Retention teams must provide output.upload_url`. This is an xAI account setting, not a prompt problem. Retrying fails identically. Relay the explanation and stop — images still work fine, so say that too instead of implying the plugin is broken.

**Moderation block.** Stop. Tell the user what was blocked and offer a different direction. Do not reword the prompt to evade the filter.

**Grok never called the tool.** Usually means the prompt read as a question rather than a generation request. Rephrase as a direct instruction.

**Timeout.** Re-run with `--timeout <seconds>`. Video runs legitimately take minutes.

## Iterating without burning money

Every attempt is billed — roughly $0.13–$0.18 per image, most of it agent tokens.

- **Never retry automatically.** A failed run is a decision point for the user, not a loop for you.
- **Edit, do not regenerate.** One detail wrong means `/grok:edit` on the existing file. Regenerating rolls a fresh subject, since there is no seed.
- **Do not generate extras.** Producing "a few more options" nobody asked for spends the user's money on your own initiative.
- **Check `/grok:setup` first** when video is part of a plan, before spending anything on the stills leading up to it.

## Where files go

Assets are copied out of Grok's session folder into the output directory (default `grok-media/`), named from the prompt or `--name`, numbered, and never overwritten — a repeat run appends `-2`, `-3`.

`grok-manifest.json` in that directory records every generation: the prompt actually sent to the tool, the aspect ratio, the tool used, the session id, and the cost. When a user asks how an image was made, read the manifest rather than guessing.
