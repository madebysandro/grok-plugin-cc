/**
 * Getting an edit's source images to Grok with their detail.
 *
 * The Grok CLI sends image_edit a JPEG or PNG of up to 400 KB as it is, and
 * shrinks anything bigger — or in another format — to 768 px first
 * (`compress_reference` in its image_edit tool). A photo straight off a phone
 * would lose most of its detail. So such a reference is re-encoded here, by
 * `scripts/refprep.py` (Python with Pillow), at up to 1536 px in under 400 KB,
 * and Grok gets that copy instead. Without Python and Pillow the reference
 * goes as it is, and a note says the CLI shrinks it.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findPython } from "./chroma.mjs";
import { runProgram } from "./ffmpeg.mjs";

const SCRIPT = fileURLToPath(new URL("../refprep.py", import.meta.url));

/** The most the Grok CLI sends to image_edit as it is. */
export const PASS_THROUGH_BYTES = 400 * 1024;
/** The longest side a prepared reference keeps; a live edit on 2026-09-25 sent a 1536×864 copy and it was taken. */
export const PREPARED_MAX_SIDE = 1536;
/** What the Grok CLI shrinks a reference to when it has to do it itself. */
const CLI_REFERENCE_SIDE = 768;

const MISSING_LIBRARIES = 3;

/** A JPEG or PNG, going by its first bytes. */
function isJpegOrPng(file) {
  let head;
  try {
    const handle = fs.openSync(file, "r");
    try {
      head = Buffer.alloc(8);
      fs.readSync(handle, head, 0, 8, 0);
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return false;
  }
  return (head[0] === 0xff && head[1] === 0xd8) || head.readUInt32BE(0) === 0x89504e47;
}

/** Whether the Grok CLI would send `image` (a path or a data: URL) to image_edit untouched. */
export function passesThrough(image) {
  if (image.startsWith("data:")) {
    return true; // left to the CLI, which handles data: URLs itself
  }
  return fs.statSync(image).size <= PASS_THROUGH_BYTES && isJpegOrPng(image);
}

/**
 * Prepare each of `images` that the Grok CLI would shrink, writing the copies
 * into `workDir` (which the caller removes after the run).
 *
 * Returns `{ images, prepared, notes }`: the paths to send, in order; what was
 * prepared, for the manifest (`{ source, width, height, bytes, format }`); and
 * notes for the result.
 */
export async function prepareEditReferences(images, { workDir }) {
  const sent = [];
  const prepared = [];
  const notes = [];
  let python;

  for (const [index, image] of images.entries()) {
    if (passesThrough(image)) {
      sent.push(image);
      continue;
    }
    const name = path.basename(image);
    const shrunk = `the Grok CLI shrinks it to ${CLI_REFERENCE_SIDE} px`;
    try {
      python ??= findPython();
    } catch {
      notes.push(`Note: ${name} is over 400 KB or not a JPEG/PNG, and without Python the plugin cannot prepare it, so ${shrunk}.`);
      sent.push(image);
      continue;
    }

    fs.mkdirSync(workDir, { recursive: true });
    const output = path.join(workDir, `ref-${index + 1}-${path.parse(image).name}.prepared`);
    let code;
    let stdout;
    let stderr;
    try {
      ({ code, stdout, stderr } = await runProgram(python, [SCRIPT, image, "--output", output, "--max-side", String(PREPARED_MAX_SIDE)]));
    } catch (error) {
      notes.push(`Note: the plugin could not prepare ${name} (${error.message}), so ${shrunk}.`);
      sent.push(image);
      continue;
    }
    if (code === 0) {
      const result = JSON.parse(stdout);
      const file = `${output}.${result.format === "png" ? "png" : "jpg"}`;
      fs.renameSync(output, file);
      sent.push(file);
      prepared.push({ source: image, width: result.width, height: result.height, bytes: result.bytes, format: result.format });
      notes.push(
        `Note: ${name} went to Grok as a ${result.width}×${result.height} ${result.format.toUpperCase()} of ${Math.round(result.bytes / 1024)} KB, ` +
          `prepared by the plugin; as it was, ${shrunk}.`
      );
      continue;
    }
    const reason = code === MISSING_LIBRARIES ? `${python} lacks Pillow` : stderr.trim().split("\n").at(-1) || `refprep.py exit ${code}`;
    notes.push(`Note: the plugin could not prepare ${name} (${reason}), so ${shrunk}.`);
    sent.push(image);
  }

  return { images: sent, prepared, notes };
}
