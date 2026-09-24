/**
 * Zero-cost compatibility checks against the installed Grok CLI.
 *
 * The plugin leans on two things the CLI does not promise to keep stable: the
 * media tools' names and limits, and the shape of `updates.jsonl`. The CLI
 * auto-updates, so `/grok:setup` re-checks both from the session folders Grok
 * already left on disk — no generation, no cost.
 */

import fs from "node:fs";
import path from "node:path";

import { AVAILABLE_MEDIA_TOOLS } from "./grok.mjs";
import { IMAGE_TO_VIDEO_DURATIONS, VIDEO_RESOLUTIONS } from "./media-spec.mjs";
import { extractMediaCalls, listSessionMediaFiles, readSessionUpdates, sessionsRoot } from "./session.mjs";

/** Session folders across every workspace bucket, newest first. */
export function recentSessionDirs(root = sessionsRoot(), limit = 60) {
  let buckets;
  try {
    buckets = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirs = [];
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) {
      continue;
    }
    const bucketPath = path.join(root, bucket.name);
    let entries;
    try {
      entries = fs.readdirSync(bucketPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const dir = path.join(bucketPath, entry.name);
      try {
        dirs.push({ dir, mtimeMs: fs.statSync(dir).mtimeMs });
      } catch {
        // vanished mid-scan
      }
    }
  }

  return dirs
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit)
    .map((entry) => entry.dir);
}

/** `tool_definitions.json` → Map of tool name → `{ description, parameters }`. */
export function parseToolDefinitions(raw) {
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.tools) ? parsed.tools : [];
  const tools = new Map();
  for (const entry of list) {
    const definition = entry?.function ?? entry;
    if (definition?.name) {
      tools.set(definition.name, {
        description: definition.description ?? "",
        parameters: definition.parameters ?? definition.input_schema ?? {}
      });
    }
  }
  return tools;
}

function describedValues(tool, property, pattern) {
  const description = tool?.parameters?.properties?.[property]?.description ?? "";
  return [...new Set(description.match(pattern) ?? [])];
}

/**
 * Compare the media tools the CLI advertises with what the plugin assumes.
 *
 * Uses the newest session that saw the full toolset — runs restricted with
 * `--tools` list only a subset and would report false gaps.
 */
export function checkToolSchemas(dirs) {
  for (const dir of dirs) {
    let tools;
    try {
      tools = parseToolDefinitions(fs.readFileSync(path.join(dir, "tool_definitions.json"), "utf8"));
    } catch {
      continue;
    }
    if (!tools.has("image_gen") || !tools.has("run_terminal_command")) {
      continue;
    }

    const missing = AVAILABLE_MEDIA_TOOLS.filter((name) => !tools.has(name));
    const notes = [];

    for (const name of ["image_to_video", "reference_to_video"]) {
      const advertised = describedValues(tools.get(name), "resolution_name", /\b\d{3,4}p\b/g);
      const unknown = advertised.filter((value) => !VIDEO_RESOLUTIONS.includes(value));
      if (unknown.length > 0) {
        notes.push(`${name} now mentions resolution ${unknown.join(", ")}; the plugin allows ${VIDEO_RESOLUTIONS.join("/")} (lib/media-spec.mjs).`);
      }
    }

    const durations = describedValues(tools.get("image_to_video"), "duration", /\b\d+\b/g).map(Number);
    const unexpected = durations.filter((value) => !IMAGE_TO_VIDEO_DURATIONS.includes(value));
    if (unexpected.length > 0) {
      notes.push(
        `image_to_video now mentions ${unexpected.join(", ")} s; the plugin allows ${IMAGE_TO_VIDEO_DURATIONS.join(" or ")} (lib/media-spec.mjs).`
      );
    }

    return { checked: true, dir, missing, notes };
  }
  return { checked: false };
}

/**
 * Prove the session-log harvest still works on this CLI version.
 *
 * Finds the newest session that has media files on disk and checks the log
 * parser recovers them. Media on disk that the parser cannot see is the
 * signature of a changed log format — exactly what a CLI update would break.
 */
export function checkHarvest(dirs) {
  for (const dir of dirs) {
    const onDisk = listSessionMediaFiles(dir);
    if (onDisk.length === 0) {
      continue;
    }
    const calls = extractMediaCalls(readSessionUpdates(dir));
    const recovered = calls.filter((call) => call.status === "completed" && call.path && onDisk.includes(call.path));
    return {
      checked: true,
      ok: recovered.length > 0,
      dir,
      mediaFiles: onDisk.length,
      recovered: recovered.length,
      when: fs.statSync(dir).mtime.toISOString()
    };
  }
  return { checked: false };
}
