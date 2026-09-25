/**
 * Chroma keying on local images — `cutout` and `split` — through
 * `scripts/chroma.py` (Python 3 with Pillow, numpy and scipy). No Grok, no
 * quota, and nothing is installed: a missing library is named, not fetched.
 *
 * Each tool has a plan step, which checks the options and dry-runs chroma.py
 * so it can refuse before anything is written, and a write step.
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { MediaToolError, findBinary, runProgram } from "./ffmpeg.mjs";

const SCRIPT = fileURLToPath(new URL("../chroma.py", import.meta.url));

/** chroma.py's exit codes besides 0 (see the script); any other code is a failure. */
const REFUSED = 1;
const MISSING_LIBRARIES = 3;

/** The background `cutout` clears by default, and how far from a key colour still counts as background. */
const DEFAULT_KEY = "#00FF00";
const DEFAULT_TOLERANCE = 80;

/** `#00FF00` (or `00ff00`) → `"00FF00"`; null when `value` is not a hex colour. */
function hexColour(value) {
  const text = String(value).trim().replace(/^#/, "");
  return /^[0-9a-f]{6}$/i.test(text) ? text.toUpperCase() : null;
}

function parseKey(value = DEFAULT_KEY) {
  const key = hexColour(value);
  if (!key) {
    throw new MediaToolError(`--key must be a hex colour such as #00FF00, got "${value}".`);
  }
  return key;
}

/** `--bg auto` reads the sheet's background from its corners; otherwise a hex colour. */
function parseBackground(value = "auto") {
  if (String(value).trim().toLowerCase() === "auto") {
    return "auto";
  }
  const background = hexColour(value);
  if (!background) {
    throw new MediaToolError(`--bg must be auto or a hex colour such as #00FF00, got "${value}".`);
  }
  return background;
}

/** `--tolerance`: how far (RGB distance) from the key a pixel still counts as background. */
function parseTolerance(value = DEFAULT_TOLERANCE) {
  const tolerance = Number(value);
  if (String(value).trim() === "" || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 400) {
    throw new MediaToolError(`--tolerance must be a number from 0 to 400 (RGB distance from the key), got "${value}".`);
  }
  return tolerance;
}

function parseExpect(value) {
  if (value === undefined) {
    return null;
  }
  if (!/^[1-9]\d*$/.test(String(value).trim())) {
    throw new MediaToolError(`--expect must be a whole number of items, such as 4, got "${value}".`);
  }
  return Number(value);
}

/** `GROK_PLUGIN_PYTHON` picks the interpreter; otherwise `python3` from PATH or the usual install dirs. */
function findPython() {
  const override = process.env.GROK_PLUGIN_PYTHON;
  if (!override) {
    const python = findBinary("python3");
    if (!python) {
      throw new MediaToolError("Python 3 not found. Install it (for example `brew install python`), or set GROK_PLUGIN_PYTHON to its path.");
    }
    return python;
  }
  try {
    fs.accessSync(override, fs.constants.X_OK);
    if (fs.statSync(override).isFile()) {
      return override;
    }
  } catch {
    // reported below
  }
  throw new MediaToolError(`GROK_PLUGIN_PYTHON is set to ${override}, which is not an executable Python.`);
}

function parseJson(text, python) {
  try {
    return JSON.parse(text);
  } catch {
    throw new MediaToolError(`chroma.py (run by ${python}) printed something that is not JSON:\n${text.trim().slice(0, 600)}`, 2);
  }
}

/**
 * Run `chroma.py <args>` and return the JSON it prints. A refusal, a missing
 * Python and a missing library are `MediaToolError`s with exit code 1; a
 * crash or anything else chroma.py hits is a failure (exit code 2).
 */
async function runChroma(args) {
  const python = findPython();
  const { code, stdout, stderr } = await runProgram(python, [SCRIPT, ...args]);
  if (code === 0) {
    return parseJson(stdout, python);
  }
  if (code === REFUSED) {
    throw new MediaToolError(stderr.trim());
  }
  if (code === MISSING_LIBRARIES) {
    const { missing } = parseJson(stderr, python);
    throw new MediaToolError(`${python} lacks ${missing.join(", ")}. Install with \`${python} -m pip install ${missing.join(" ")}\` and re-run.`);
  }
  throw new MediaToolError(`chroma.py failed (exit ${code}):\n${stderr.trim().split("\n").slice(-12).join("\n")}`, 2);
}

/** Check a `cutout` of `input` (options `key`, `tolerance`) and return the work to hand to `writeCutout`. */
export async function planCutout(input, options) {
  const work = { input, key: parseKey(options.key), tolerance: parseTolerance(options.tolerance) };
  // A dry run refuses an image with no background of the key colour, or nothing else.
  await runChroma(cutoutArgs(work));
  return work;
}

/** Write the cut-out PNG; returns what the manifest records. */
export async function writeCutout(work, output) {
  await runChroma([...cutoutArgs(work), "--output", output]);
  return { key: `#${work.key}`, tolerance: work.tolerance };
}

function cutoutArgs({ input, key, tolerance }) {
  return ["cutout", input, "--key", key, "--tolerance", String(tolerance)];
}

/**
 * Check a `split` of `input` (options `expect`, `bg`, `tolerance`): find its
 * items and refuse a wrong count or a cut-off item. Returns `{ count, work }`.
 */
export async function planSplit(input, options) {
  const work = {
    input,
    background: parseBackground(options.bg),
    tolerance: parseTolerance(options.tolerance),
    expect: parseExpect(options.expect)
  };
  const { count } = await runChroma(splitArgs(work));
  return { count, work };
}

/** Write one PNG per item to `outputs`; returns what the manifest records. */
export async function writeSplit(work, outputs) {
  const { count, canvas, key } = await runChroma([...splitArgs(work), "--outputs", ...outputs]);
  return { items: count, canvas: canvas.join("x"), key, tolerance: work.tolerance };
}

function splitArgs({ input, background, tolerance, expect }) {
  const args = ["split", input, "--bg", background, "--tolerance", String(tolerance)];
  return expect === null ? args : [...args, "--expect", String(expect)];
}
