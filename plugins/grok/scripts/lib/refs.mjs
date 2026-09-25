/**
 * Input references to earlier results, so a generation can feed the next one
 * without hunting for paths:
 *
 *   @last        the last file of the newest job that produced any
 *   job:<id>     that job's first file
 *   job:<id>#N   its Nth file, counting from 1
 *
 * They resolve from the workspace's job state, which records every file a run
 * saved, whatever `--out` it used. A reference that cannot be honoured fails
 * here, before Grok is called.
 */

import fs from "node:fs";
import path from "node:path";

import { resolveInputImage } from "./assets.mjs";
import { findJob, listJobs } from "./state.mjs";

const JOB_PREFIX = "job:";
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);

/** "image", "video", or null, going by the file's extension. */
export function mediaKindOf(file) {
  const extension = path.extname(file).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }
  return VIDEO_EXTENSIONS.has(extension) ? "video" : null;
}

/** Resolve an `--image` value: a path, a `data:` URL, or a reference to an earlier result. */
export function resolveImageArg(raw, cwd) {
  const value = String(raw ?? "").trim();
  const ref = resolveResultRef(value, cwd);
  if (!ref) {
    return resolveInputImage(value, cwd);
  }

  if (!isImageFile(ref.file)) {
    const stillIndex = ref.job.files.findIndex(isImageFile);
    const hint =
      stillIndex === -1
        ? "That job produced no still image."
        : `For the job's still, use job:${ref.job.id}#${stillIndex + 1}.`;
    throw new Error(`${value}: ${ref.file} (job "${ref.job.id}") is not an image. ${hint}`);
  }
  return ref.file;
}

/**
 * Resolve an input of a local tool: a path, or a reference to an earlier
 * result, whose kind (by extension) must be one `command` accepts.
 */
export function resolveLocalInput(raw, cwd, { accept, command }) {
  const value = String(raw ?? "").trim();
  const ref = resolveResultRef(value, cwd);
  const file = ref ? ref.file : path.resolve(cwd, value);
  if (!ref && !(fs.existsSync(file) && fs.statSync(file).isFile())) {
    throw new Error(`File not found: ${file}`);
  }

  const label = ref ? `${value}: ${file} (job "${ref.job.id}")` : value;
  const kind = mediaKindOf(file);
  const wanted = accept.map((each) => `${each === "image" ? "an" : "a"} ${each}`).join(" or ");
  if (!kind) {
    throw new Error(`${label} is neither an image nor a video, going by its extension; ${command} takes ${wanted}.`);
  }
  if (!accept.includes(kind)) {
    throw new Error(`${label} is ${kind === "image" ? "an" : "a"} ${kind}; ${command} needs ${wanted}.`);
  }
  return file;
}

function isImageFile(file) {
  return mediaKindOf(file) === "image";
}

/** `{ job, file }` for `@last` / `job:<id>[#N]`, or null when `value` is not a reference. */
function resolveResultRef(value, cwd) {
  if (value === "@last") {
    const job = listJobs(cwd).find((candidate) => candidate.files?.length > 0);
    if (!job) {
      throw new Error("@last: no generated files are recorded for this workspace yet.");
    }
    return existingFile(value, job, job.files.at(-1));
  }

  if (!value.startsWith(JOB_PREFIX)) {
    return null;
  }

  const body = value.slice(JOB_PREFIX.length);
  const hash = body.lastIndexOf("#");
  const jobId = hash === -1 ? body : body.slice(0, hash);
  const number = hash === -1 ? "1" : body.slice(hash + 1);
  if (!jobId) {
    throw new Error(`${value}: no job id given; use job:<id> or job:<id>#N.`);
  }
  if (!/^\d+$/.test(number)) {
    throw new Error(`${value}: the file number after # must be a whole number, e.g. job:${jobId}#1.`);
  }

  const job = findJob(cwd, jobId);
  if (!job) {
    throw new Error(`${value}: no Grok job with id "${jobId}" in this workspace. Run /grok:status to list recent jobs.`);
  }
  const files = job.files ?? [];
  if (files.length === 0) {
    throw new Error(`${value}: job "${job.id}" (${job.command}, ${job.status}) has no files.`);
  }
  const position = Number(number);
  if (position < 1 || position > files.length) {
    throw new Error(`${value}: job "${job.id}" has ${files.length} file${files.length === 1 ? "" : "s"}; use #1 to #${files.length}.`);
  }
  return existingFile(value, job, files[position - 1]);
}

/** A reference never falls back to an older file: the one it names must still be there. */
function existingFile(ref, job, file) {
  if (!fs.existsSync(file)) {
    throw new Error(`${ref}: ${file} (job "${job.id}") no longer exists.`);
  }
  return { job, file };
}
