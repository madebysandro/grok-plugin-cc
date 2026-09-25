/**
 * The local utilities — `last-frame`, `concat`, `mute`, `reframe` — that
 * assemble pieces from earlier results without Grok and without quota.
 *
 * Each run is recorded like a generation (a job plus a manifest entry, with the
 * tool's `engine` — e.g. `tool: "ffmpeg"` — as the tool that made each file), so
 * `@last` and `job:<id>` pick its output up next: `@last` is the last file the
 * plugin saved in the workspace, whoever made it.
 */

import fs from "node:fs";
import path from "node:path";

import { resolveOutDir, slugify, uniquePath, writeManifest } from "./assets.mjs";
import {
  MediaToolError,
  checkConcatCopy,
  concatClips,
  extractLastFrame,
  needsEvenSides,
  planReframe,
  probeMedia,
  probePicture,
  reframeMedia,
  stripAudio
} from "./ffmpeg.mjs";
import { mediaKindOf, resolveLocalInput } from "./refs.mjs";
import { generateJobId, upsertJob } from "./state.mjs";

/** Options every local tool takes; each tool lists the ones of its own. */
const COMMON_OPTIONS = ["out", "name", "json"];

const REFRAME_MODES = ["crop", "pad"];
const REFRAME_ANCHORS = ["center", "top", "bottom", "left", "right"];

/** Image formats reframe writes back as they came; any other image comes out as PNG. */
const KEPT_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png"];

function stemOf(file) {
  return slugify(path.basename(file, path.extname(file)), "clip");
}

/** `--aspect 9:16` → `{ width: 9, height: 16, label: "9:16" }`. */
function parseAspect(value) {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(value ?? "").trim());
  if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) {
    throw new MediaToolError(`reframe needs --aspect W:H, such as 9:16 or 1:1${value === undefined ? "" : `; got "${value}"`}.`);
  }
  return { width: Number(match[1]), height: Number(match[2]), label: `${match[1]}:${match[2]}` };
}

function pickChoice(value, choices, flag, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const choice = String(value).trim().toLowerCase();
  if (!choices.includes(choice)) {
    throw new MediaToolError(`${flag} ${value} is not an option. Use one of: ${choices.join(", ")}.`);
  }
  return choice;
}

async function probeAll(files) {
  const clips = [];
  for (const file of files) {
    clips.push({ file, ...(await probePicture(file)) });
  }
  return clips;
}

/**
 * Per command: a title for the report, the program that does the work
 * (`engine`, recorded as each output's tool), what it takes, and two steps.
 *
 * `prepare(inputs, options)` checks everything that can refuse the request —
 * probing the inputs if it must — and returns the output's name and the work
 * to do, before any file or directory is created. A tool that writes several
 * files also returns their `count`; they are named `<stem>-1` to `<stem>-N`.
 * `run(inputs, output, work)` writes the output (an array of paths when there
 * is a `count`) and returns what the manifest should record about it.
 */
export const LOCAL_TOOLS = Object.freeze({
  "last-frame": {
    title: "Last frame",
    engine: "ffmpeg",
    usage: "last-frame <video> [--out DIR] [--name SLUG]",
    inputs: { accept: ["video"], min: 1, max: 1 },
    options: [],
    prepare: async ([input]) => ({
      stem: `${stemOf(input)}-last-frame`,
      extension: ".png",
      work: { media: await probePicture(input) }
    }),
    run: async ([input], output, { media }) => {
      await extractLastFrame(input, output, media);
      return {};
    }
  },

  concat: {
    title: "Joined",
    engine: "ffmpeg",
    usage: "concat <video> <video>... [--reencode] [--out DIR] [--name SLUG]",
    inputs: { accept: ["video"], min: 2, max: Infinity },
    options: ["reencode"],
    prepare: async (inputs, options) => {
      const reencode = options.reencode === true;
      const clips = await probeAll(inputs);
      if (!reencode) {
        checkConcatCopy(clips);
      }
      // A copy keeps the first clip's container; a re-encode is H.264 + AAC, which is MP4.
      return { stem: `${stemOf(inputs[0])}-concat`, extension: reencode ? ".mp4" : path.extname(inputs[0]), work: { clips, reencode } };
    },
    run: async (inputs, output, { clips, reencode }) => {
      await concatClips(clips, output, { reencode });
      return { reencode };
    }
  },

  reframe: {
    title: "Reframed",
    engine: "ffmpeg",
    usage: "reframe <image|video> --aspect W:H [--mode crop|pad] [--anchor center|top|bottom|left|right] [--out DIR] [--name SLUG]",
    inputs: { accept: ["image", "video"], min: 1, max: 1 },
    options: ["aspect", "mode", "anchor"],
    prepare: async ([input], options) => {
      const aspect = parseAspect(options.aspect);
      const mode = pickChoice(options.mode, REFRAME_MODES, "--mode", "crop");
      const anchor = pickChoice(options.anchor, REFRAME_ANCHORS, "--anchor", "center");
      const kind = mediaKindOf(input);
      const media = await probePicture(input);
      const plan = planReframe(media.video, aspect, mode, anchor, { even: needsEvenSides(kind, media.video.pixFmt) });
      const extension =
        kind === "video" ? ".mp4" : KEPT_IMAGE_EXTENSIONS.includes(path.extname(input).toLowerCase()) ? path.extname(input) : ".png";
      return {
        stem: `${stemOf(input)}-${aspect.label.replace(":", "x")}-${mode}`,
        extension,
        work: { media, plan, mode, anchor, kind, aspect }
      };
    },
    run: async ([input], output, { media, plan, mode, anchor, kind, aspect }) => {
      await reframeMedia(input, output, { media, plan, mode, kind });
      // Record the size ffmpeg actually wrote.
      const { video } = await probeMedia(output);
      return { aspect: aspect.label, mode, anchor, width: video.width, height: video.height };
    }
  },

  mute: {
    title: "Muted",
    engine: "ffmpeg",
    usage: "mute <video> [--out DIR] [--name SLUG]",
    inputs: { accept: ["video"], min: 1, max: 1 },
    options: [],
    prepare: async ([input]) => ({
      stem: `${stemOf(input)}-muted`,
      extension: path.extname(input),
      work: { media: await probePicture(input) }
    }),
    run: async ([input], output, { media }) => {
      await stripAudio(input, output, media);
      return {};
    }
  }
});

/** Refuse options the tool would otherwise ignore, so nobody thinks they applied. */
function refuseForeignOptions(command, tool, options) {
  const accepted = new Set([...COMMON_OPTIONS, ...tool.options]);
  for (const option of Object.keys(options)) {
    if (!accepted.has(option)) {
      throw new MediaToolError(`--${option} does not apply to ${command}.`);
    }
  }
}

/**
 * Run one local tool over `positionals` (its input files) and record the result.
 * Returns `{ jobId, outDir, assets, elapsedMs }`; throws `MediaToolError`.
 */
export async function runLocalTool(command, { options, positionals, cwd }) {
  const tool = LOCAL_TOOLS[command];
  refuseForeignOptions(command, tool, options);
  const { accept, min, max } = tool.inputs;
  if (positionals.length < min || positionals.length > max) {
    throw new MediaToolError(`Usage: /grok:${tool.usage}`);
  }
  let inputs;
  try {
    inputs = positionals.map((value) => resolveLocalInput(value, cwd, { accept, command }));
  } catch (error) {
    throw new MediaToolError(error.message);
  }

  // Everything that can refuse the request runs before the output directory or any file exists.
  const { stem, extension, work, count } = await tool.prepare(inputs, options);
  const outDir = resolveOutDir(options.out, cwd, "grok-media");
  const base = options.name ? slugify(options.name) : stem;
  const outputs =
    count === undefined
      ? [uniquePath(outDir, base, extension)]
      : Array.from({ length: count }, (_, index) => uniquePath(outDir, `${base}-${index + 1}`, extension));

  const startedAt = Date.now();
  let details;
  try {
    details = await tool.run(inputs, count === undefined ? outputs[0] : outputs, work);
  } catch (error) {
    // Leave no half-written file behind to take the name the next run should get.
    for (const output of outputs) {
      fs.rmSync(output, { force: true });
    }
    throw error;
  }
  const elapsedMs = Date.now() - startedAt;

  const assets = outputs.map((output) => ({
    file: output,
    bytes: fs.statSync(output).size,
    tool: tool.engine,
    prompt: null,
    aspectRatio: details.aspect ?? null
  }));
  const jobId = generateJobId(command);
  upsertJob(cwd, { id: jobId, command, status: "completed", outDir, assetCount: outputs.length, files: outputs });
  writeManifest({ outDir, entries: assets, meta: { command, inputs, ...details } });

  return { jobId, outDir, assets, elapsedMs };
}
