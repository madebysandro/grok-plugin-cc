/**
 * What the Grok CLI's media tools actually accept.
 *
 * Taken from the tool schemas Grok CLI 1.0.41 advertises (every session folder
 * holds a `tool_definitions.json`), the CLI's source (github.com/xai-org/grok-build)
 * and xAI's Imagine documentation, and confirmed by live runs. Checking options
 * here turns a quota-spending Grok turn that ends in a validation error into an
 * instant local one.
 */

/**
 * The image models `--image-model` names. Image 2.0 is xAI's current image
 * model and the default: it renders text (accents, prices) correctly.
 * `grok-imagine-image` (1.0) expands the prompt before generating.
 */
export const IMAGE_MODELS = Object.freeze({
  "2.0": "grok-imagine-image-2.0",
  standard: "grok-imagine-image"
});
export const DEFAULT_IMAGE_MODEL_CHOICE = "2.0";
export const DEFAULT_IMAGE_MODEL = IMAGE_MODELS[DEFAULT_IMAGE_MODEL_CHOICE];

/** `--image-model server`: pass no override, so xAI's current default applies. */
export const SERVER_IMAGE_MODEL = "server";
export const IMAGE_MODEL_CHOICES = Object.freeze([...Object.keys(IMAGE_MODELS), SERVER_IMAGE_MODEL]);

/**
 * xAI retires `grok-imagine-image-quality` on 2026-11-02, with its aliases
 * (`-latest`, dated ids, and `grok-imagine-image-pro`, which already redirects
 * to it): from then on Image 2.0 at low quality serves them
 * (docs.x.ai/developers/migration/imagine-image-quality-nov-2). `quality` was
 * this plugin's name for it.
 */
const RETIRED_IMAGE_MODEL_CHOICE = "quality";
const RETIRED_IMAGE_MODEL_PREFIXES = Object.freeze(["grok-imagine-image-quality", "grok-imagine-image-pro"]);

/** A model id `--image-model` passes through as it is, for a model newer than this plugin. */
const IMAGE_MODEL_ID = /^grok-imagine-image[a-z0-9.-]*$/;

/**
 * The models older than Image 2.0, with its narrower limits below. `server`
 * counts among them: without an override, the Grok CLI falls back to
 * `grok-imagine-image-quality`.
 */
const OLDER_IMAGE_MODELS = new Set([IMAGE_MODELS.standard, SERVER_IMAGE_MODEL]);

function isOlderImageModel(model) {
  return OLDER_IMAGE_MODELS.has(model);
}

/**
 * The aspect ratios the Imagine API documents for generating and editing
 * images. The Grok CLI passes `aspect_ratio` through without checking it (its
 * tool descriptions list only some), so these are the limits that count.
 * 21:9 and 5:2 came with Image 2.0 and only it takes them.
 */
export const IMAGE_ASPECTS = Object.freeze([
  "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20", "21:9", "5:2", "auto"
]);
const IMAGE_2_0_ONLY_ASPECTS = Object.freeze(["21:9", "5:2"]);
export const OLDER_IMAGE_ASPECTS = Object.freeze(IMAGE_ASPECTS.filter((aspect) => !IMAGE_2_0_ONLY_ASPECTS.includes(aspect)));

/** The aspect ratios `image_gen` and `image_edit` take on `model` (a model id, or `server`). */
export function imageAspects(model) {
  return isOlderImageModel(model) ? OLDER_IMAGE_ASPECTS : IMAGE_ASPECTS;
}

/** How many source images one `image_edit` call takes: 5 on Image 2.0, 3 on the older models. */
export const EDIT_IMAGE_LIMIT = 5;
export const OLDER_EDIT_IMAGE_LIMIT = 3;

export function editImageLimit(model) {
  return isOlderImageModel(model) ? OLDER_EDIT_IMAGE_LIMIT : EDIT_IMAGE_LIMIT;
}

/** A note for the result when the chosen image model will not use the prompt as it is; otherwise null. */
export function imageModelNote(model) {
  return model === IMAGE_MODELS.standard
    ? `Note: ${IMAGE_MODELS.standard} expands the prompt before generating, so the image does not follow it word for word. Image 2.0 (the default) uses it as written.`
    : null;
}

export const REFERENCE_VIDEO_ASPECTS = Object.freeze(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]);
export const DEFAULT_REFERENCE_ASPECT = "16:9";

/**
 * Both video tools reject anything else with `resolution_name must be one of:
 * 480p, 720p` — including on subscriptions whose Grok app offers 1080p.
 */
export const VIDEO_RESOLUTIONS = Object.freeze(["480p", "720p"]);

/** The tools default to 480p when no resolution is passed; ask for the best one. */
export const DEFAULT_VIDEO_RESOLUTION = "720p";

/** `--draft`: the cheapest clip worth looking at, to try an idea before spending on it. */
export const DRAFT_VIDEO_RESOLUTION = "480p";

const VIDEO_COMMANDS = ["animate", "video", "ref-video"];

/**
 * The commands each option means something for. Any other generation command
 * refuses it rather than silently dropping it, so the user never thinks it
 * applied. `ask` refuses it too unless the original plugin's `ask` took it
 * (`ASK_OPTIONS` in the companion), and the local tools refuse whatever is not
 * on their own lists; the entries naming `ask` or a local tool are here for the
 * message, which says where the option belongs.
 * `--image-model` needs a Grok run that makes an image.
 */
const OPTION_COMMANDS = Object.freeze({
  // Only these prompts ask for several results; only these commands take --image inputs;
  // only ask can be allowed to write files.
  count: ["image", "edit"],
  image: ["edit", "animate", "ref-video", "overlay"],
  write: ["ask"],
  draft: VIDEO_COMMANDS,
  resolution: VIDEO_COMMANDS,
  duration: VIDEO_COMMANDS,
  "image-model": ["image", "edit", "video"],
  loop: ["ref-video"],
  voice: ["ref-video"],
  keyframe: ["ref-video"],
  "first-frame": ["ref-video"],
  "last-frame": ["ref-video"],
  // The local tools' own options, refused here so a Grok run never drops them silently.
  text: ["overlay"],
  sub: ["overlay"],
  brand: ["overlay"],
  position: ["overlay"],
  style: ["overlay"],
  mode: ["reframe"],
  anchor: ["reframe"],
  reencode: ["concat"],
  key: ["cutout"],
  tolerance: ["cutout", "split"],
  expect: ["split"],
  bg: ["split"]
});

/** Why `--<option>` is refused on `command`, naming the commands it is for. */
export function optionNotApplicable(option, command) {
  const commands = OPTION_COMMANDS[option];
  const list = commands.length === 1 ? commands[0] : `${commands.slice(0, -1).join(", ")} and ${commands.at(-1)}`;
  return `--${option} does not apply to ${command}; it is for ${list}.`;
}

function rejectInapplicableOptions(command, options) {
  for (const [option, commands] of Object.entries(OPTION_COMMANDS)) {
    if (!commands.includes(command) && options[option] !== undefined && options[option] !== false) {
      throw new MediaOptionError(optionNotApplicable(option, command));
    }
  }
}

export const IMAGE_TO_VIDEO_DURATIONS = Object.freeze([6, 10]);
export const DEFAULT_VIDEO_DURATION = 6;
export const REFERENCE_VIDEO_DURATION = Object.freeze({ min: 1, max: 15 });
export const REFERENCE_LIMITS = Object.freeze({ images: 14, voices: 3, keyframes: 4 });

/** Older Grok CLIs offer a `reference_to_video` with up to 7 images and no pinned frames. */
export const OLDER_REFERENCE_IMAGES = 7;

/** Keyframe timestamps snap to a 1/3-second grid; closer anchors are rejected. */
const KEYFRAME_SPACING_SECONDS = 1 / 3;

export class MediaOptionError extends Error {
  constructor(message) {
    super(message);
    this.name = "MediaOptionError";
  }
}

function pickAspect(value, allowed, label) {
  if (value === undefined || value === null) {
    return null;
  }
  const aspect = String(value).trim();
  if (!allowed.includes(aspect)) {
    throw new MediaOptionError(`--aspect ${aspect} is not accepted by ${label}. Use one of: ${allowed.join(", ")}.`);
  }
  return aspect;
}

/**
 * `--image-model`: a name from `IMAGE_MODEL_CHOICES`, or the id of a Grok
 * image model, passed through so a model newer than this plugin can be used
 * before the plugin knows it. Returns a model id, or `SERVER_IMAGE_MODEL`.
 */
function pickImageModel(value) {
  if (value === undefined || value === null) {
    return DEFAULT_IMAGE_MODEL;
  }
  const choice = String(value).trim().toLowerCase();
  if (choice === SERVER_IMAGE_MODEL) {
    return SERVER_IMAGE_MODEL;
  }
  if (Object.hasOwn(IMAGE_MODELS, choice)) {
    return IMAGE_MODELS[choice];
  }
  if (choice === RETIRED_IMAGE_MODEL_CHOICE || RETIRED_IMAGE_MODEL_PREFIXES.some((prefix) => choice.startsWith(prefix))) {
    throw new MediaOptionError(
      `--image-model ${choice} names a model xAI is retiring: from 2026-11-02 Image 2.0 at low quality serves it. ` +
        `Use ${DEFAULT_IMAGE_MODEL_CHOICE} (the default) or standard.`
    );
  }
  if (IMAGE_MODEL_ID.test(choice)) {
    return choice;
  }
  throw new MediaOptionError(
    `--image-model ${choice || '""'} is not a Grok image model. Use one of: ${IMAGE_MODEL_CHOICES.join(", ")}, ` +
      `or a model id such as ${DEFAULT_IMAGE_MODEL}.`
  );
}

function pickResolution(value) {
  if (value === undefined || value === null) {
    return DEFAULT_VIDEO_RESOLUTION;
  }
  const text = String(value).trim().toLowerCase();
  const resolution = /^\d+$/.test(text) ? `${text}p` : text;
  if (!VIDEO_RESOLUTIONS.includes(resolution)) {
    throw new MediaOptionError(
      `--resolution ${value} is not available. The Grok CLI video tools accept only ${VIDEO_RESOLUTIONS.join(" or ")}; ` +
        "higher resolutions in a Grok subscription apply to the Grok app, not to the CLI."
    );
  }
  return resolution;
}

function pickSeconds(value, flag) {
  if (value === undefined || value === null) {
    return DEFAULT_VIDEO_DURATION;
  }
  const text = String(value).trim().replace(/s$/i, "");
  if (!/^\d+$/.test(text)) {
    throw new MediaOptionError(`${flag} must be a whole number of seconds, got "${value}".`);
  }
  return Number.parseInt(text, 10);
}

/**
 * Validate and normalise one command's generation options.
 *
 * Returns `{ aspect, imageModel, duration, resolution, draft, videoTool }` with
 * only the fields that command uses; throws `MediaOptionError` with a message
 * fit to show the user. `imageModel` is a model id, or `SERVER_IMAGE_MODEL`;
 * `videoTool` (animate only) is the Grok tool that makes the clip.
 */
export function resolveMediaSpec(command, options = {}) {
  rejectInapplicableOptions(command, options);
  switch (command) {
    case "image": {
      const imageModel = pickImageModel(options["image-model"]);
      return { aspect: pickAspect(options.aspect, imageAspects(imageModel), toolOnModel("image_gen", imageModel)), imageModel };
    }

    case "edit": {
      const imageModel = pickImageModel(options["image-model"]);
      const images = asList(options.image).length;
      if (options.aspect !== undefined && images < 2) {
        throw new MediaOptionError(
          "--aspect applies to edit only with 2 or more --image inputs; a single-image edit keeps the source image's shape."
        );
      }
      const limit = editImageLimit(imageModel);
      if (images > limit) {
        const newer = limit < EDIT_IMAGE_LIMIT ? ` (${EDIT_IMAGE_LIMIT} with Image 2.0, the default)` : "";
        throw new MediaOptionError(`${toolOnModel("image_edit", imageModel)} takes at most ${limit} source images${newer}; got ${images}.`);
      }
      return { aspect: pickAspect(options.aspect, imageAspects(imageModel), toolOnModel("image_edit", imageModel)), imageModel };
    }

    case "animate":
      if (asList(options.image).length > 1) {
        throw new MediaOptionError(`animate takes one --image (the still to animate); got ${asList(options.image).length}.`);
      }
      if (options.aspect !== undefined) {
        throw new MediaOptionError(
          "--aspect does not apply to animate: image_to_video keeps the source image's shape. Crop the still first."
        );
      }
      return pickAnimation(options);

    case "video": {
      const imageModel = pickImageModel(options["image-model"]);
      return {
        aspect: pickAspect(options.aspect, imageAspects(imageModel), `${toolOnModel("image_gen", imageModel)} (the opening frame)`),
        imageModel,
        ...pickImageToVideo(options, " For another length, make the still with image and animate it with animate --duration.")
      };
    }

    case "ref-video": {
      const duration = pickSeconds(options.duration, "--duration");
      const { min, max } = REFERENCE_VIDEO_DURATION;
      if (duration < min || duration > max) {
        throw new MediaOptionError(`--duration ${duration} is outside reference_to_video's range of ${min}–${max} seconds.`);
      }
      return {
        aspect: pickAspect(options.aspect, REFERENCE_VIDEO_ASPECTS, "reference_to_video") ?? DEFAULT_REFERENCE_ASPECT,
        duration,
        ...pickDraftResolution(options)
      };
    }

    default:
      return {};
  }
}

/** "image_gen", or "image_gen on grok-imagine-image" for a model with narrower limits, for messages. */
function toolOnModel(tool, model) {
  if (!isOlderImageModel(model)) {
    return tool;
  }
  return `${tool} on ${model === SERVER_IMAGE_MODEL ? "xAI's default model" : model}`;
}

/** The `image_to_video` settings of `video`: `{ duration, resolution, draft }`. `hint` ends a refused duration's message. */
function pickImageToVideo(options, hint = "") {
  const duration = pickSeconds(options.duration, "--duration");
  if (!IMAGE_TO_VIDEO_DURATIONS.includes(duration)) {
    throw new MediaOptionError(
      `--duration ${duration} is not accepted by image_to_video. Use ${IMAGE_TO_VIDEO_DURATIONS.join(" or ")} seconds.${hint}`
    );
  }
  return { duration, ...pickDraftResolution(options) };
}

/**
 * `animate`: `image_to_video` for the lengths it takes (6 or 10 s), and
 * `reference_to_video` with the still pinned as the first frame for the rest
 * of 1–15 s. Returns `{ duration, resolution, draft, videoTool }`.
 */
function pickAnimation(options) {
  const duration = pickSeconds(options.duration, "--duration");
  if (IMAGE_TO_VIDEO_DURATIONS.includes(duration)) {
    return { duration, ...pickDraftResolution(options), videoTool: "image_to_video" };
  }
  const { min, max } = REFERENCE_VIDEO_DURATION;
  if (duration < min || duration > max) {
    throw new MediaOptionError(`--duration ${duration} is outside animate's range of ${min}–${max} seconds.`);
  }
  return { duration, ...pickDraftResolution(options), videoTool: "reference_to_video" };
}

/**
 * The aspect ratio of `reference_to_video` closest to a `width`×`height`
 * still, and whether it matches the still's shape (within 1%).
 */
export function nearestReferenceAspect(width, height) {
  const target = Math.log(width / height);
  let best = null;
  for (const aspect of REFERENCE_VIDEO_ASPECTS) {
    const [w, h] = aspect.split(":").map(Number);
    const distance = Math.abs(Math.log(w / h) - target);
    if (!best || distance < best.distance) {
      best = { aspect, distance };
    }
  }
  return { aspect: best.aspect, exact: best.distance < Math.log(1.01) };
}

/** `{ resolution, draft }`: `--draft` means the draft resolution and cannot be combined with `--resolution`. */
function pickDraftResolution(options) {
  const draft = options.draft === true;
  if (draft && options.resolution !== undefined) {
    throw new MediaOptionError(
      `--draft already means ${DRAFT_VIDEO_RESOLUTION}; drop --resolution, or drop --draft to choose the resolution.`
    );
  }
  return { resolution: draft ? DRAFT_VIDEO_RESOLUTION : pickResolution(options.resolution), draft };
}

/**
 * A preset voice id, lower-cased. The roster itself is not checked here — the
 * tool answers an unknown id with the list of voices — only that it is an id.
 */
function pickVoice(raw) {
  const voice = String(raw ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(voice)) {
    throw new MediaOptionError(`--voice expects a voice id such as eve or ara, got "${raw}".`);
  }
  return voice;
}

function asList(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

/** `--keyframe path/to/still.png@3` → `{ image, timestampS: 3 }`. */
export function parseKeyframe(raw) {
  const text = String(raw ?? "").trim();
  const at = text.lastIndexOf("@");
  if (at <= 0 || at === text.length - 1) {
    throw new MediaOptionError(`--keyframe expects PATH@SECONDS (e.g. frame.png@3), got "${raw}".`);
  }
  const seconds = Number(text.slice(at + 1).replace(/s$/i, ""));
  if (!Number.isFinite(seconds)) {
    throw new MediaOptionError(`--keyframe timestamp must be a number of seconds, got "${text.slice(at + 1)}".`);
  }
  return { image: text.slice(0, at), timestampS: seconds };
}

/**
 * Gather and check the inputs of a `reference_to_video` run.
 *
 * `resolveImage` maps a user path to what Grok should receive (it throws for a
 * missing file), so this module stays free of filesystem access. The last
 * argument describes the tool the installed CLI offers: how many reference
 * images it takes (`maxImages`), and whether it pins first/last frames and
 * keyframes (`pinnedFrames`; the older tool takes 7 and pins nothing).
 */
export function resolveReferenceInputs(
  options,
  duration,
  resolveImage = (value) => value,
  { maxImages = REFERENCE_LIMITS.images, pinnedFrames = true } = {}
) {
  let images = asList(options.image);
  const voices = asList(options.voice).map(pickVoice);
  // Sorted, because keyframes take their <IMAGE_i> tags in time order.
  const keyframes = asList(options.keyframe)
    .map(parseKeyframe)
    .sort((left, right) => left.timestampS - right.timestampS);
  let firstFrame = options["first-frame"] ?? null;
  let lastFrame = options["last-frame"] ?? null;

  // `--loop`: the one image opens and closes the clip, so it repeats seamlessly.
  const loop = options.loop === true;
  if (loop) {
    if (images.length !== 1) {
      throw new MediaOptionError("--loop takes exactly one --image: it becomes both the first and the last frame.");
    }
    if (firstFrame || lastFrame) {
      throw new MediaOptionError("--loop sets both the first and the last frame from --image; drop --first-frame and --last-frame.");
    }
    firstFrame = images[0];
    lastFrame = images[0];
    images = [];
  }

  if (images.length > maxImages) {
    const older =
      maxImages < REFERENCE_LIMITS.images
        ? ` This Grok CLI offers the older reference_to_video; update it to use up to ${REFERENCE_LIMITS.images}.`
        : "";
    throw new MediaOptionError(`reference_to_video takes at most ${maxImages} reference images; got ${images.length}.${older}`);
  }
  if (!pinnedFrames && (firstFrame || lastFrame || keyframes.length > 0)) {
    throw new MediaOptionError(
      "This Grok CLI offers the older reference_to_video: no first/last frame or keyframes. " +
        "Update the Grok CLI, or drop --first-frame, --last-frame, --keyframe and --loop."
    );
  }
  if (voices.length > REFERENCE_LIMITS.voices) {
    throw new MediaOptionError(`reference_to_video takes at most ${REFERENCE_LIMITS.voices} voices; got ${voices.length}.`);
  }
  if (keyframes.length > REFERENCE_LIMITS.keyframes) {
    throw new MediaOptionError(`reference_to_video takes at most ${REFERENCE_LIMITS.keyframes} keyframes; got ${keyframes.length}.`);
  }
  if (images.length + voices.length + keyframes.length === 0 && !firstFrame && !lastFrame) {
    throw new MediaOptionError(
      "reference_to_video needs at least one input: --image (repeatable), --first-frame, --last-frame, --keyframe PATH@SECONDS, or --voice."
    );
  }

  const times = keyframes.map((keyframe) => keyframe.timestampS);
  for (const time of times) {
    if (time <= 0 || time >= duration) {
      throw new MediaOptionError(
        `--keyframe at ${time}s must fall strictly inside the ${duration}s clip; use --first-frame / --last-frame for the ends.`
      );
    }
    const snapped = Math.round(time / KEYFRAME_SPACING_SECONDS) * KEYFRAME_SPACING_SECONDS;
    if (snapped < KEYFRAME_SPACING_SECONDS - 1e-9 || snapped > duration - KEYFRAME_SPACING_SECONDS + 1e-9) {
      throw new MediaOptionError(
        `--keyframe at ${time}s snaps to ${Number(snapped.toFixed(2))}s on reference_to_video's 1/3-second grid, ` +
          `which is an end of the ${duration}s clip; move it inward or use --first-frame / --last-frame.`
      );
    }
  }
  for (let index = 1; index < times.length; index += 1) {
    if (times[index] - times[index - 1] < KEYFRAME_SPACING_SECONDS - 1e-9) {
      throw new MediaOptionError(`Keyframes at ${times[index - 1]}s and ${times[index]}s are closer than 1/3 s apart.`);
    }
  }

  return {
    images: images.map(resolveImage),
    voices,
    keyframes: keyframes.map((keyframe) => ({ image: resolveImage(keyframe.image), timestampS: keyframe.timestampS })),
    firstFrame: firstFrame ? resolveImage(firstFrame) : null,
    lastFrame: lastFrame ? resolveImage(lastFrame) : null,
    loop
  };
}
