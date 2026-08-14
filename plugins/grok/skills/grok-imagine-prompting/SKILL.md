---
name: grok-imagine-prompting
description: How to write prompts for Grok's image and video tools (image_gen, image_edit, image_to_video) — structure, what the model is reliably good and bad at, consistency across a series, and when to build the asset in code instead. Load before writing or repairing any Grok media prompt, or when a generation came back off-target.
---

# Prompting Grok Imagine

The plugin passes your prompt to `image_gen` **verbatim**. Nothing downstream will fix a vague prompt, so it has to carry the intent on its own.

## Do not generate it — build it

Image models garble exact text, numbers, and structure. They invent digits, mangle words, draw chart bars matching no data, and point diagram arrows nowhere. A more detailed prompt does not fix this, and an edit pass rarely does either.

So when the output must get specific content *right* — charts from real numbers, labelled diagrams, tables, UI with real copy, anything with more than a few words of text — build it in HTML/CSS and screenshot it. Generate only when what matters is how it looks: photos, illustrations, characters, scenes, textures, decorative art.

A short headline or a logotype is usually fine. A pricing table is not.

## Structure

Order the prompt roughly: **subject → action or pose → setting → style → composition → lighting and mood → key details.**

- Lead with the subject. The opening words carry the most weight.
- Write natural prose, not comma-separated keyword tags.
- State what you want *present*. There is no negative prompt, and "no people" often summons people.
- One coherent scene per prompt. Two competing focal points produce a muddle.
- Two to five sentences is the sweet spot. Past that, later details start getting dropped.

Match the aspect ratio to the use: `16:9` banner or video frame, `9:16` phone or story, `1:1` avatar or icon, `4:3`/`3:4` print-ish.

## An example

Too thin:

> a coffee shop

Enough to steer:

> A narrow third-wave coffee shop interior at opening time, one barista wiping down a brass espresso machine. Warm morning light rakes in through a street-facing window, catching steam and dust. Muted earth tones, matte wood, unpolished concrete. Shot at eye level on a 35mm lens, shallow depth of field, the machine sharp and the back of the room falling soft.

The second names subject, action, setting, palette, optics, and light — each of which the model can act on.

## Consistency across a series

There is no seed. The same prompt run twice gives two different subjects.

To keep one character, product, or location across several images: **generate one base image, then derive every variant from it with `image_edit`.** Change one thing per edit and describe only that change — `image_edit` preserves what you do not mention, so re-describing the whole scene invites drift.

```bash
/grok:image  <the base scene>              --name hero
/grok:edit   "change the jacket to red"    --image grok-media/hero-1.jpg
/grok:edit   "same subject, three-quarter view from the left" --image grok-media/hero-1.jpg
```

Re-running `/grok:image` for a recurring subject is the single most common way a series ends up inconsistent.

## Real people

Do not generate a named real person from a text prompt. Use `image_edit` with an actual reference image instead. Never produce sexualised, non-consensual, or minor-involving likenesses — a moderation block is a stop signal, not something to reword around.

## Motion prompts

For `image_to_video`, the still already establishes the content. Describe **motion only**: what moves, where the camera goes, how the light changes.

> Slow push-in. Dust motes drift through the lamplight. The flame flickers once. Everything else holds still.

Re-describing the scene wastes the prompt and can fight the source frame. Keep motion modest — small, physically plausible movement holds up far better than a big gesture.

## When a result comes back wrong

- **Wrong subject or composition** → rewrite the prompt with the subject earlier and more concrete. Do not just re-run: without a seed you are rolling dice, and each roll is billed.
- **Right subject, one wrong detail** → `/grok:edit` that one detail. Do not regenerate.
- **Garbled text or numbers** → stop generating. Build it in code.
- **Drifting across a series** → you are re-generating where you should be editing from a base image.
- **Moderation block** → stop and tell the user. Do not paraphrase to slip past the filter.
