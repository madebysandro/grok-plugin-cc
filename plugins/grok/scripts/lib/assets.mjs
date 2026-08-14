/**
 * Copying generated media out of Grok's session folder and into the user's
 * workspace, with stable names and a manifest recording how each file was made.
 */

import fs from "node:fs";
import path from "node:path";

const MAX_SLUG_LENGTH = 48;

/** Turn arbitrary prompt text into a safe, readable filename stem. */
export function slugify(text, fallback = "grok") {
  const slug = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug || fallback;
}

/** Append `-2`, `-3`, ... until the path is free. Never overwrites. */
export function uniquePath(dir, stem, extension) {
  let candidate = path.join(dir, `${stem}${extension}`);
  let counter = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-${counter}${extension}`);
    counter += 1;
  }
  return candidate;
}

/**
 * Copy each completed media call into `outDir`.
 *
 * Returns `{ saved, missing }`. `missing` holds calls whose reported file is
 * gone — surfaced rather than silently dropped, since it usually means the
 * session was cleaned up mid-run.
 */
export function collectAssets({ calls, outDir, baseName, index = 1 }) {
  fs.mkdirSync(outDir, { recursive: true });

  const saved = [];
  const missing = [];
  let counter = index;

  for (const call of calls) {
    if (call.status !== "completed" || !call.path) {
      continue;
    }

    if (!fs.existsSync(call.path)) {
      missing.push(call);
      continue;
    }

    const extension = path.extname(call.path) || ".bin";
    const stem = baseName ? `${baseName}-${counter}` : `${slugify(call.prompt)}-${counter}`;
    const destination = uniquePath(outDir, stem, extension);

    fs.copyFileSync(call.path, destination);

    saved.push({
      file: destination,
      bytes: fs.statSync(destination).size,
      tool: call.tool,
      outputType: call.outputType,
      prompt: call.prompt,
      aspectRatio: call.aspectRatio,
      source: call.path
    });

    counter += 1;
  }

  return { saved, missing };
}

/**
 * Write `<outDir>/grok-manifest.json`, merging with any existing manifest so
 * repeated runs into one directory accumulate rather than clobber.
 */
export function writeManifest({ outDir, entries, meta = {} }) {
  const manifestFile = path.join(outDir, "grok-manifest.json");

  let existing = { version: 1, generations: [] };
  if (fs.existsSync(manifestFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      if (parsed && Array.isArray(parsed.generations)) {
        existing = parsed;
      }
    } catch {
      // A corrupt manifest is replaced rather than allowed to fail the run.
    }
  }

  existing.version = 1;
  existing.generations.push({
    createdAt: new Date().toISOString(),
    ...meta,
    assets: entries.map((entry) => ({
      file: path.basename(entry.file),
      bytes: entry.bytes,
      tool: entry.tool,
      prompt: entry.prompt,
      aspectRatio: entry.aspectRatio
    }))
  });

  fs.writeFileSync(manifestFile, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
  return manifestFile;
}

/** Resolve an output directory against the workspace, creating it on demand. */
export function resolveOutDir(rawOut, cwd, fallback = "grok-media") {
  const target = rawOut ? path.resolve(cwd, rawOut) : path.resolve(cwd, fallback);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

/**
 * Resolve a user-supplied input image path.
 *
 * `data:` URLs pass through untouched — Grok's `image_edit` accepts them
 * directly, so there is nothing to resolve on disk.
 */
export function resolveInputImage(rawPath, cwd) {
  const value = String(rawPath ?? "").trim();
  if (!value) {
    throw new Error("Image path is empty");
  }
  if (value.startsWith("data:")) {
    return value;
  }

  const resolved = path.resolve(cwd, value);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Image not found: ${resolved}`);
  }
  if (!fs.statSync(resolved).isFile()) {
    throw new Error(`Not a file: ${resolved}`);
  }
  return resolved;
}
