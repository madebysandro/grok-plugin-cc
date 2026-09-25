/**
 * The local utilities — ffmpeg's `last-frame`, `concat`, `mute`, `reframe`,
 * Python's `cutout`, `split`, and Chrome's `overlay` — that assemble pieces
 * from earlier results without Grok and without quota.
 *
 * Each run is recorded like a generation (a job plus a manifest entry, with the
 * tool's `engine` — e.g. `tool: "ffmpeg"` — as the tool that made each file), so
 * `@last` and `job:<id>` pick its output up next: `@last` is the last file the
 * plugin saved in the workspace, whoever made it.
 */

import fs from "node:fs";
import path from "node:path";

import { resolveOutDir, slugify, uniquePath, writeManifest } from "./assets.mjs";
import { planCutout, planSplit, writeCutout, writeSplit } from "./chroma.mjs";
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
import { OVERLAY_POSITIONS, OVERLAY_STYLES, prepareOverlay, renderOverlay } from "./overlay.mjs";
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

/** A render's time limit: whole seconds from 1 to 600, 60 unless given. */
function pickTimeoutSeconds(value) {
  if (value === undefined) {
    return 60;
  }
  const seconds = Number(String(value).trim());
  if (!/^\d+$/.test(String(value).trim()) || seconds < 1 || seconds > 600) {
    throw new MediaToolError(`--timeout ${value} is not a number of seconds from 1 to 600.`);
  }
  return seconds;
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
 * (`engine`, recorded as each output's tool), what it takes (input files come
 * from the positionals, or from the option `inputs.option` names), and two steps.
 *
 * `prepare(inputs, options, { cwd })` checks everything that can refuse the
 * request — probing the inputs if it must — and returns the output's name and
 * the work to do, before any file or directory is created. A tool that writes
 * several files also returns their `count`; they are named `<stem>-1` to `<stem>-N`.
 * `run(inputs, output, work)` writes the output (an array of paths when there
 * is a `count`) and returns what the manifest should record about it, plus any
 * `notes` for the user.
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

  overlay: {
    title: "Overlaid",
    engine: "chrome",
    usage:
      'overlay --image <image> --text "…" [--sub "…"] [--brand brand.json] [--position top|center|bottom] ' +
      "[--style clean|bold|glass] [--timeout SECS] [--out DIR] [--name SLUG]",
    inputs: { accept: ["image"], min: 1, max: 1, option: "image" },
    options: ["image", "text", "sub", "brand", "position", "style", "timeout"],
    prepare: async ([input], options, { cwd }) => {
      const text = typeof options.text === "string" ? options.text : "";
      if (!text.trim()) {
        throw new MediaToolError(`overlay needs --text. Usage: /grok:${LOCAL_TOOLS.overlay.usage}`);
      }
      const settings = {
        text,
        sub: typeof options.sub === "string" && options.sub.trim() ? options.sub : null,
        position: pickChoice(options.position, OVERLAY_POSITIONS, "--position", "bottom"),
        style: pickChoice(options.style, OVERLAY_STYLES, "--style", "clean"),
        timeoutMs: pickTimeoutSeconds(options.timeout) * 1000
      };
      const brandFile = options.brand === undefined ? null : path.resolve(cwd, String(options.brand));
      return { stem: `${stemOf(input)}-overlay`, extension: ".png", work: prepareOverlay(input, settings, { brandFile }) };
    },
    run: async (inputs, output, work) => renderOverlay(work, output)
  },

  cutout: {
    title: "Cut out",
    engine: "python",
    usage: "cutout <image> [--key #00FF00] [--tolerance N] [--out DIR] [--name SLUG]",
    inputs: { accept: ["image"], min: 1, max: 1 },
    options: ["key", "tolerance"],
    prepare: async ([input], options) => ({ stem: `${stemOf(input)}-cutout`, extension: ".png", work: await planCutout(input, options) }),
    run: (_inputs, output, work) => writeCutout(work, output)
  },

  split: {
    title: "Split",
    engine: "python",
    usage: "split <sheet image> [--expect N] [--bg auto|#00FF00] [--tolerance N] [--out DIR] [--name SLUG]",
    inputs: { accept: ["image"], min: 1, max: 1 },
    options: ["expect", "bg", "tolerance"],
    prepare: async ([input], options) => {
      const { count, work } = await planSplit(input, options);
      return { stem: `${stemOf(input)}-item`, extension: ".png", count, work };
    },
    run: (_inputs, outputs, work) => writeSplit(work, outputs)
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
 * Run one local tool over its input files (the positionals, or the option the
 * tool names) and record the result.
 * Returns `{ jobId, outDir, assets, elapsedMs, notes }`; throws `MediaToolError`.
 */
export async function runLocalTool(command, { options, positionals, cwd }) {
  const tool = LOCAL_TOOLS[command];
  refuseForeignOptions(command, tool, options);
  const { accept, min, max, option } = tool.inputs;
  const given = option ? [options[option] ?? []].flat() : positionals;
  if (given.length < min || given.length > max || (option && positionals.length > 0)) {
    throw new MediaToolError(`Usage: /grok:${tool.usage}`);
  }
  let inputs;
  try {
    inputs = given.map((value) => resolveLocalInput(value, cwd, { accept, command }));
  } catch (error) {
    throw new MediaToolError(error.message);
  }

  // Everything that can refuse the request runs before the output directory or any file exists.
  const { stem, extension, work, count } = await tool.prepare(inputs, options, { cwd });
  const outDir = resolveOutDir(options.out, cwd, "grok-media");
  const base = options.name ? slugify(options.name) : stem;
  const several = count !== undefined;
  const outputs = several
    ? Array.from({ length: count }, (_, index) => uniquePath(outDir, `${base}-${index + 1}`, extension))
    : [uniquePath(outDir, base, extension)];

  const startedAt = Date.now();
  let details;
  let notes;
  try {
    ({ notes = [], ...details } = await tool.run(inputs, several ? outputs : outputs[0], work));
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

  return { jobId, outDir, assets, elapsedMs, notes };
}
