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

const JOB_REF = /^job:(.+?)(?:#(\d+))?$/;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

/** Resolve an image input: a path, a `data:` URL, or a reference to an earlier result. */
export function resolveImageInput(raw, cwd) {
  const value = String(raw ?? "").trim();
  const ref = resolveResultRef(value, cwd);
  if (!ref) {
    return resolveInputImage(value, cwd);
  }

  if (!IMAGE_EXTENSIONS.has(path.extname(ref.file).toLowerCase())) {
    const stillIndex = ref.job.files.findIndex((file) => IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()));
    const hint =
      stillIndex === -1
        ? "That job produced no still image."
        : `For the job's still, use job:${ref.job.id}#${stillIndex + 1}.`;
    throw new Error(`${value} is ${ref.file} from job "${ref.job.id}", which is not an image. ${hint}`);
  }
  return ref.file;
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

  const jobRef = JOB_REF.exec(value);
  if (!jobRef) {
    return null;
  }

  const job = findJob(cwd, jobRef[1]);
  if (!job) {
    throw new Error(`${value}: no Grok job with id "${jobRef[1]}" in this workspace. Run /grok:status to list recent jobs.`);
  }
  const files = job.files ?? [];
  if (files.length === 0) {
    throw new Error(`${value}: job "${job.id}" (${job.command}, ${job.status}) has no files.`);
  }
  const position = jobRef[2] === undefined ? 1 : Number(jobRef[2]);
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
