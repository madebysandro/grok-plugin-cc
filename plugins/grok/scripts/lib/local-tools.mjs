/**
 * The local utilities — `last-frame`, `concat`, `mute`, `reframe` — that
 * assemble pieces from earlier results without Grok and without quota.
 *
 * Each run is recorded like a generation (a job plus a manifest entry, with
 * `tool: "ffmpeg"`), so `@last` and `job:<id>` pick its output up next: `@last`
 * is the last file the plugin saved in the workspace, whoever made it.
 */

import fs from "node:fs";
import path from "node:path";

import { resolveOutDir, slugify, uniquePath, writeManifest } from "./assets.mjs";
import { MediaToolError, concatClips, extractLastFrame, reframeMedia, stripAudio } from "./ffmpeg.mjs";
import { mediaKindOf, resolveLocalInput } from "./refs.mjs";
import { generateJobId, upsertJob } from "./state.mjs";

function stemOf(file) {
  return slugify(path.basename(file, path.extname(file)), "clip");
}

const REFRAME_MODES = ["crop", "pad"];
const REFRAME_ANCHORS = ["center", "top", "bottom", "left", "right"];

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

/** reframe's settings, checked before any file is written. */
function reframeSettings(options) {
  return {
    aspect: parseAspect(options.aspect),
    mode: pickChoice(options.mode, REFRAME_MODES, "--mode", "crop"),
    anchor: pickChoice(options.anchor, REFRAME_ANCHORS, "--anchor", "center")
  };
}

/** Per command: a title for the report, how it names its output, and the ffmpeg work. */
export const LOCAL_TOOLS = Object.freeze({
  "last-frame": {
    title: "Last frame",
    usage: "last-frame <video> [--out DIR] [--name SLUG]",
    inputs: { accept: ["video"], min: 1, max: 1 },
    output: ([input]) => ({ stem: `${stemOf(input)}-last-frame`, extension: ".png" }),
    run: async ([input], output) => {
      await extractLastFrame(input, output);
      return {};
    }
  },

  concat: {
    title: "Joined",
    usage: "concat <video> <video>... [--reencode] [--out DIR] [--name SLUG]",
    inputs: { accept: ["video"], min: 2, max: Infinity },
    output: ([first]) => ({ stem: `${stemOf(first)}-concat`, extension: path.extname(first) }),
    run: async (inputs, output, options) => {
      const reencode = options.reencode === true;
      await concatClips(inputs, output, { reencode });
      return { reencode };
    }
  },

  reframe: {
    title: "Reframed",
    usage: "reframe <image|video> --aspect W:H [--mode crop|pad] [--anchor center|top|bottom|left|right] [--out DIR] [--name SLUG]",
    inputs: { accept: ["image", "video"], min: 1, max: 1 },
    output: ([input], options) => {
      const { aspect, mode } = reframeSettings(options);
      return { stem: `${stemOf(input)}-${aspect.label.replace(":", "x")}-${mode}`, extension: path.extname(input) };
    },
    run: async ([input], output, options) => {
      const { aspect, mode, anchor } = reframeSettings(options);
      const plan = await reframeMedia(input, output, { aspect, mode, anchor, kind: mediaKindOf(input) });
      return { aspect: aspect.label, mode, anchor, width: plan.width, height: plan.height };
    }
  },

  mute: {
    title: "Muted",
    usage: "mute <video> [--out DIR] [--name SLUG]",
    inputs: { accept: ["video"], min: 1, max: 1 },
    output: ([input]) => ({ stem: `${stemOf(input)}-muted`, extension: path.extname(input) }),
    run: async ([input], output) => {
      await stripAudio(input, output);
      return {};
    }
  }
});

/**
 * Run one local tool over `positionals` (its input files) and record the result.
 * Returns `{ jobId, outDir, assets, elapsedMs }`; throws `MediaToolError`.
 */
export async function runLocalTool(command, { options, positionals, cwd }) {
  const tool = LOCAL_TOOLS[command];
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

  // Everything is checked before the output directory or any file is created.
  const naming = tool.output(inputs, options);
  const outDir = resolveOutDir(options.out, cwd, "grok-media");
  const output = uniquePath(outDir, options.name ? slugify(options.name) : naming.stem, naming.extension);

  const startedAt = Date.now();
  const details = await tool.run(inputs, output, options);
  const elapsedMs = Date.now() - startedAt;

  const assets = [{ file: output, bytes: fs.statSync(output).size, tool: "ffmpeg", prompt: null, aspectRatio: details.aspect ?? null }];
  const jobId = options.job || generateJobId(command);
  upsertJob(cwd, { id: jobId, command, status: "completed", outDir, assetCount: 1, files: [output] });
  writeManifest({ outDir, entries: assets, meta: { command, inputs, ...details } });

  return { jobId, outDir, assets, elapsedMs };
}

export { MediaToolError };
