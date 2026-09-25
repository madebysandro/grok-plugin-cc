/**
 * What the Grok CLI's media tools actually accept.
 *
 * Taken from the tool schemas Grok CLI 1.0.41 advertises (every session folder
 * holds a `tool_definitions.json`) and confirmed by live runs. Checking options
 * here turns a billed Grok turn that ends in a validation error into an
 * instant local one.
 */

export const IMAGE_GEN_ASPECTS = Object.freeze(["1:1", "16:9", "9:16", "3:2", "2:3", "auto"]);

/** `image_edit` only honours an aspect ratio for multi-image edits. */
export const IMAGE_EDIT_ASPECTS = Object.freeze([
  "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20", "auto"
]);

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

/**
 * `--image-model` choices. Image 2.0 is the default: it renders text (accents,
 * prices) correctly, and the server's own default, `grok-imagine-image-quality`,
 * is retired on 2026-11-02.
 */
export const IMAGE_MODELS = Object.freeze({
  "2.0": "grok-imagine-image-2.0",
  quality: "grok-imagine-image-quality",
  standard: "grok-imagine-image"
});
export const DEFAULT_IMAGE_MODEL_CHOICE = "2.0";
export const DEFAULT_IMAGE_MODEL = IMAGE_MODELS[DEFAULT_IMAGE_MODEL_CHOICE];

/** `--image-model server`: pass no override, so xAI's current default applies. */
export const SERVER_IMAGE_MODEL = "server";
export const IMAGE_MODEL_CHOICES = Object.freeze([...Object.keys(IMAGE_MODELS), SERVER_IMAGE_MODEL]);

/** The commands whose Grok run makes an image, so `--image-model` means something. */
const IMAGE_MODEL_COMMANDS = ["image", "edit", "video"];

/** Why `--image-model` is refused on `command`, for the commands that make no image. */
export function imageModelNotApplicable(command) {
  return `--image-model does not apply to ${command}; it is for ${IMAGE_MODEL_COMMANDS.slice(0, -1).join(", ")} and ${IMAGE_MODEL_COMMANDS.at(-1)}.`;
}

export const IMAGE_TO_VIDEO_DURATIONS = Object.freeze([6, 10]);
export const DEFAULT_VIDEO_DURATION = 6;
export const REFERENCE_VIDEO_DURATION = Object.freeze({ min: 1, max: 15 });
export const REFERENCE_LIMITS = Object.freeze({ images: 14, voices: 3, keyframes: 4 });

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

function pickImageModel(value) {
  if (value === undefined || value === null) {
    return DEFAULT_IMAGE_MODEL;
  }
  const choice = String(value).trim().toLowerCase();
  if (choice === SERVER_IMAGE_MODEL) {
    return SERVER_IMAGE_MODEL;
  }
  if (!Object.hasOwn(IMAGE_MODELS, choice)) {
    throw new MediaOptionError(
      `--image-model ${choice || '""'} is not a Grok image model. Use one of: ${IMAGE_MODEL_CHOICES.join(", ")}.`
    );
  }
  return IMAGE_MODELS[choice];
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
 * Returns `{ aspect, imageModel, duration, resolution, draft }` with only the
 * fields that command uses; throws `MediaOptionError` with a message fit to
 * show the user. `imageModel` is a model id, or `SERVER_IMAGE_MODEL`.
 */
export function resolveMediaSpec(command, options = {}) {
  switch (command) {
    case "image":
      rejectVideoOptions(command, options);
      return { aspect: pickAspect(options.aspect, IMAGE_GEN_ASPECTS, "image_gen"), imageModel: pickImageModel(options["image-model"]) };

    case "edit":
      rejectVideoOptions(command, options);
      if (options.aspect !== undefined && asList(options.image).length < 2) {
        throw new MediaOptionError(
          "--aspect applies to edit only with 2 or more --image inputs; a single-image edit keeps the source image's shape."
        );
      }
      return { aspect: pickAspect(options.aspect, IMAGE_EDIT_ASPECTS, "image_edit"), imageModel: pickImageModel(options["image-model"]) };

    case "animate":
      if (options["image-model"] !== undefined) {
        throw new MediaOptionError(imageModelNotApplicable(command));
      }
      if (options.aspect !== undefined) {
        throw new MediaOptionError(
          "--aspect does not apply to animate: image_to_video keeps the source image's shape. Crop the still first."
        );
      }
      return pickImageToVideo(options);

    case "video":
      return {
        aspect: pickAspect(options.aspect, IMAGE_GEN_ASPECTS, "image_gen (the opening frame)"),
        imageModel: pickImageModel(options["image-model"]),
        ...pickImageToVideo(options)
      };

    case "ref-video": {
      const duration = pickSeconds(options.duration, "--duration");
      const { min, max } = REFERENCE_VIDEO_DURATION;
      if (duration < min || duration > max) {
        throw new MediaOptionError(`--duration ${duration} is outside reference_to_video's range of ${min}–${max} seconds.`);
      }
      return {
        aspect: pickAspect(options.aspect, REFERENCE_VIDEO_ASPECTS, "reference_to_video") ?? DEFAULT_REFERENCE_ASPECT,
        duration,
        resolution: pickResolution(options.resolution)
      };
    }

    default:
      return {};
  }
}

/** The `image_to_video` settings shared by animate and video: `{ duration, resolution, draft }`. */
function pickImageToVideo(options) {
  const duration = pickSeconds(options.duration, "--duration");
  if (!IMAGE_TO_VIDEO_DURATIONS.includes(duration)) {
    throw new MediaOptionError(
      `--duration ${duration} is not accepted by image_to_video. Use ${IMAGE_TO_VIDEO_DURATIONS.join(" or ")} seconds.`
    );
  }
  const draft = options.draft === true;
  if (draft && options.resolution !== undefined) {
    throw new MediaOptionError(
      `--draft already means ${DRAFT_VIDEO_RESOLUTION}; drop --resolution, or drop --draft to choose the resolution.`
    );
  }
  return { duration, resolution: draft ? DRAFT_VIDEO_RESOLUTION : pickResolution(options.resolution), draft };
}

/** An image run would silently ignore these; say so rather than let the user think they applied. */
function rejectVideoOptions(command, options) {
  if (options.draft === true) {
    throw new MediaOptionError(`--draft does not apply to ${command}; it is for animate and video.`);
  }
  for (const option of ["resolution", "duration"]) {
    if (options[option] !== undefined) {
      throw new MediaOptionError(`--${option} does not apply to ${command}; it is for animate and video.`);
    }
  }
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
 * missing file), so this module stays free of filesystem access.
 */
export function resolveReferenceInputs(options, duration, resolveImage = (value) => value) {
  const images = asList(options.image);
  const voices = asList(options.voice).map((voice) => String(voice).trim().toLowerCase()).filter(Boolean);
  const keyframes = asList(options.keyframe).map(parseKeyframe);
  const firstFrame = options["first-frame"] ?? null;
  const lastFrame = options["last-frame"] ?? null;

  if (images.length > REFERENCE_LIMITS.images) {
    throw new MediaOptionError(`reference_to_video takes at most ${REFERENCE_LIMITS.images} reference images; got ${images.length}.`);
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

  const times = keyframes.map((keyframe) => keyframe.timestampS).sort((left, right) => left - right);
  for (const time of times) {
    if (time <= 0 || time >= duration) {
      throw new MediaOptionError(
        `--keyframe at ${time}s must fall strictly inside the ${duration}s clip; use --first-frame / --last-frame for the ends.`
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
    lastFrame: lastFrame ? resolveImage(lastFrame) : null
  };
}
