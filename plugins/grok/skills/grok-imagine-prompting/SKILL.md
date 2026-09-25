---
name: grok-imagine-prompting
description: How to write prompts for Grok's image and video tools (image_gen, image_edit, image_to_video, reference_to_video) — structure, what the model is reliably good and bad at, text in images versus /grok:overlay, ref-video's <IMAGE_i>/<AUDIO_i> tags, staging pictures for cutout and split, consistency across a series, and when to build the asset in code instead. Load before writing or repairing any Grok media prompt, or when a generation came back off-target.
---

# Prompting Grok Imagine

The plugin passes your prompt to the tool **verbatim**. Nothing downstream will fix a vague prompt, so it has to carry the intent on its own. Write it in the language the user wrote it in: text meant to appear in the image, or a line meant to be spoken, comes out in that language.

## Do not generate it — build it

Image models garble exact text, numbers, and structure. They invent digits, mangle words, draw chart bars matching no data, and point diagram arrows nowhere. A more detailed prompt does not fix this, and an edit pass rarely does either.

So when the output must get specific content *right* — charts from real numbers, labelled diagrams, tables, UI with real copy, anything with more than a few words of text — build it in HTML/CSS and screenshot it. Generate only when what matters is how it looks: photos, illustrations, characters, scenes, textures, decorative art.

A short headline, a name or a price is usually fine: Image 2.0, the default model, draws them right, accents included ("TORREFAÇÃO", "R$ 5,90"). Put such text in quotes in the prompt and say where it goes. A pricing table is not fine.

For text laid over a picture — a title, a price, a date, anything long or that must be exact — generate the picture without the text, leaving calm space where the text will sit, and add it with `/grok:overlay`: it renders the exact characters in HTML at the image's own size with headless Chrome, so nothing comes out misspelled.

### brand.json

`/grok:overlay --brand <file>` styles the text from a project's brand kit, conventionally `grok-media/library/<name>/brand.json`:

```json
{
  "name": "Café Aurora",
  "colors": { "primary": "#C0392B", "secondary": "#F5E6CC", "accent": "#F1C40F", "text": "#FFFFFF", "background": "rgba(20, 10, 5, 0.6)" },
  "fonts": { "heading": "Playfair Display", "body": "Inter" },
  "logo": "logo.png"
}
```

- `colors`: `text` for the title, `accent` for the subtitle (else `text`), `primary` for the `bold` band, `background` and `secondary` for the `glass` panel and its border. Hex, `rgb()`/`rgba()`, `hsl()`/`hsla()` or CSS colour names; anything else is refused, so a typo cannot pass silently.
- `fonts`: a Google Fonts family name — loaded over the network when rendering — or a path (relative to `brand.json`, or absolute) to a `.ttf`, `.otf`, `.woff` or `.woff2` file, which is embedded and needs no network. (The file form goes beyond the original convention, for brand fonts that are not on Google Fonts.) A font that does not load is reported, and a fallback is drawn.
- `logo`: an image path relative to `brand.json`, shown above the title.

## Structure

Order the prompt roughly: **subject → action or pose → setting → style → composition → lighting and mood → key details.**

- Lead with the subject. The opening words carry the most weight.
- Write natural prose, not comma-separated keyword tags.
- State what you want *present*. There is no negative prompt, and "no people" often summons people.
- One coherent scene per prompt. Two competing focal points produce a muddle.
- Two to five sentences is the sweet spot. Past that, later details start getting dropped.

Match the aspect ratio to the use: `16:9` banner or video frame, `9:16` phone or story, `1:1` avatar or icon, `3:2`/`2:3` print-ish. `image_gen` takes only 1:1, 16:9, 9:16, 3:2, 2:3 and auto.

## An example

Too thin:

> a coffee shop

Enough to steer:

> A narrow third-wave coffee shop interior at opening time, one barista wiping down a brass espresso machine. Warm morning light rakes in through a street-facing window, catching steam and dust. Muted earth tones, matte wood, unpolished concrete. Shot at eye level on a 35mm lens, shallow depth of field, the machine sharp and the back of the room falling soft.

The second names subject, action, setting, palette, optics, and light — each of which the model can act on.

## Reference video (`/grok:ref-video`)

The prompt refers to the inputs by tag:

- Images are `<IMAGE_0>`, `<IMAGE_1>`, … numbered in this order: `--first-frame`, then each `--image` in the order given, then the keyframes by time, then `--last-frame`. With `--loop`, the one image is `<IMAGE_0>`.
- Voices are `<AUDIO_0>`, `<AUDIO_1>`, … in the order of the `--voice` flags.

> `<IMAGE_1>` slides `<IMAGE_2>` across the counter and says, in the voice `<AUDIO_0>`: "Seu café."

- A reference (`--image`) conditions the clip — a person, a product, a place is kept recognisable but re-rendered. A first/last frame or a keyframe appears as it is. Pick the flag by which of the two you need.
- Up to 8 references ran on Grok CLI 1.0.41 (the schema allows 14). Name each one in the prompt by its tag and say what it is for.
- Write a spoken line in the language it should be spoken in, in quotes, and say who speaks it with which voice. The voice `eve` spoke Portuguese intelligibly in a live run.
- For `--loop`, describe motion that can return to where it started (turning, breathing, swaying); the plugin adds "Locked camera, seamless loop."

## Staging a picture for the local tools

- **For `/grok:cutout`:** ask for the subject "on a flat pure green (#00FF00) background, evenly lit, no shadow on the background". For a green subject, use magenta (#FF00FF) and pass `--key #FF00FF`.
- **For `/grok:split`:** ask for the items "on a flat pure green (#00FF00) background, evenly spaced with clear gaps, none touching the edges", and say how many. A character turnaround: "front, side and back views of the same character, side by side, full body, same scale".
- **For `/grok:overlay`:** leave the part of the frame where the text goes (top, centre or bottom) plain enough to read text over.
- **For another format:** generate at the nearest ratio `image_gen` offers and use `/grok:reframe` — `pad` keeps everything on a blurred copy of the picture.

## Consistency across a series

There is no seed. The same prompt run twice gives two different subjects.

To keep one character, product, or location across several images: **generate one base image, then derive every variant from it with `image_edit`.** Change one thing per edit and describe only that change — `image_edit` preserves what you do not mention, so re-describing the whole scene invites drift.

```bash
/grok:image  <the base scene>              --name hero
/grok:edit   "change the jacket to red"    --image grok-media/hero-1.jpg
/grok:edit   "same subject, three-quarter view from the left" --image grok-media/hero-1.jpg
```

Re-running `/grok:image` for a recurring subject is the single most common way a series ends up inconsistent.

`image_edit` shrinks each reference to about 768 px / 400 KB first, so small text, a logo or a fine pattern in the reference can come back blurred or redrawn. Keep what must stay exact out of the edit and add it afterwards with `/grok:overlay`; warn the user when an edit hinges on such detail.

For video, pass the same base image to `/grok:ref-video` as `--image` (or `--first-frame`) in every clip. Keep a project's base images in `grok-media/library/<name>/` (the canonical image, the turnaround, `traits.md` with what must not drift) and start every piece from there.

## Real people

Do not generate a named real person from a text prompt. Use `image_edit` with an actual reference image instead. Never produce sexualised, non-consensual, or minor-involving likenesses — a moderation block is a stop signal, not something to reword around.

## Motion prompts

For `image_to_video`, the still already establishes the content. Describe **motion only**: what moves, where the camera goes, how the light changes.

> Slow push-in. Dust motes drift through the lamplight. The flame flickers once. Everything else holds still.

Re-describing the scene wastes the prompt and can fight the source frame. Keep motion modest — small, physically plausible movement holds up far better than a big gesture. A 6 s clip has room for one action; ask for 10 s (`--duration 10`) rather than packing two into six.

## When a result comes back wrong

- **Wrong subject or composition** → rewrite the prompt with the subject earlier and more concrete. Do not just re-run: without a seed you are rolling dice, and each roll is billed.
- **Right subject, one wrong detail** → `/grok:edit` that one detail. Do not regenerate.
- **Garbled text or numbers** → stop generating. Build it in code.
- **Drifting across a series** → you are re-generating where you should be editing from a base image.
- **Moderation block** → stop and tell the user. Do not paraphrase to slip past the filter.
