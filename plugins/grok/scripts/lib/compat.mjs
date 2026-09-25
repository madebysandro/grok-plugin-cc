/**
 * Zero-cost compatibility checks against the installed Grok CLI.
 *
 * The plugin leans on two things the CLI does not promise to keep stable: the
 * media tools' names and limits, and the shape of `updates.jsonl`. The CLI
 * auto-updates, so `/grok:setup` re-checks both from the session folders Grok
 * already left on disk — no generation, no cost.
 *
 * Every check reports a `status`: "ok", "fail", "warn", or "not-verified" when
 * nothing on disk can tell yet. Only "fail" should block.
 */

import fs from "node:fs";
import path from "node:path";

import { AVAILABLE_MEDIA_TOOLS } from "./grok.mjs";
import {
  IMAGE_TO_VIDEO_DURATIONS,
  OLDER_REFERENCE_IMAGES,
  REFERENCE_LIMITS,
  REFERENCE_VIDEO_DURATION,
  VIDEO_RESOLUTIONS
} from "./media-spec.mjs";
import { extractMediaCalls, listSessionMediaFiles, readSessionUpdates, sessionsRoot } from "./session.mjs";

/** How many recent sessions the checks look through. */
const SESSION_LIMIT = 60;

/** Grok keeps these MCP meta-tools even in a run restricted with `--tools`. */
const MCP_META_TOOLS = new Set(["search_tool", "use_tool"]);

/**
 * How many other tools a session must advertise to count as Grok's whole
 * toolset. Real full sessions show about a dozen; the margin keeps a run
 * restricted with `--tools` from qualifying just because a future CLI keeps
 * one more always-on tool in it.
 */
const FULL_TOOLSET_MIN_OTHER_TOOLS = 3;

/** How many reference images each `reference_to_video` schema takes. */
const REFERENCE_SCHEMA_IMAGES = Object.freeze({ old: OLDER_REFERENCE_IMAGES, new: REFERENCE_LIMITS.images });

/** The durations the plugin allows per video tool, for the limits warning. */
const DURATION_RULES = Object.freeze({
  image_to_video: {
    allows: (seconds) => IMAGE_TO_VIDEO_DURATIONS.includes(seconds),
    text: IMAGE_TO_VIDEO_DURATIONS.join(" or ")
  },
  reference_to_video: {
    allows: (seconds) => seconds >= REFERENCE_VIDEO_DURATION.min && seconds <= REFERENCE_VIDEO_DURATION.max,
    text: `${REFERENCE_VIDEO_DURATION.min} to ${REFERENCE_VIDEO_DURATION.max}`
  }
});

/** Every check `/grok:setup` runs, from the sessions Grok left on disk. */
export function checkCompatibility() {
  const sessions = readRecentSessions();
  return {
    mediaTools: checkMediaTools(sessions),
    harvest: checkHarvest(sessions),
    limits: checkAdvertisedLimits(sessions),
    referenceToVideo: checkReferenceSchema(sessions)
  };
}

/**
 * What `ref-video` may send to the `reference_to_video` the installed CLI last
 * offered: `{ maxImages, pinnedFrames }`. Until a session shows the tool, the
 * newer schema's limits apply.
 */
export function referenceInputLimits() {
  const { schema, maxImages } = checkReferenceSchema(readRecentSessions());
  return { maxImages: maxImages ?? REFERENCE_LIMITS.images, pinnedFrames: schema !== "old" };
}

/**
 * Session folders across every workspace bucket, newest first, each with the
 * tools it advertised (null when it recorded none).
 */
function readRecentSessions() {
  const root = sessionsRoot();
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
    .slice(0, SESSION_LIMIT)
    .map(({ dir }) => ({ dir, tools: readSessionTools(dir) }));
}

/** `tool_definitions.json` → Map of tool name → `{ description, parameters }`. */
function readSessionTools(dir) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dir, "tool_definitions.json"), "utf8"));
  } catch {
    return null;
  }
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

/**
 * A session offered Grok's whole toolset when it advertises several tools
 * beyond media tools and MCP meta-tools. Media runs restricted with `--tools`
 * (every plugin run since the isolation change) advertise only what they
 * asked for, so a tool missing there proves nothing.
 */
function isUnrestricted(tools) {
  const others = [...tools.keys()].filter((name) => !AVAILABLE_MEDIA_TOOLS.includes(name) && !MCP_META_TOOLS.has(name));
  return others.length >= FULL_TOOLSET_MIN_OTHER_TOOLS;
}

/**
 * Check each media tool the plugin relies on against the newest session that
 * could tell: one that advertises the tool, or an unrestricted one.
 *
 * Returns `{ status, advertised, missing, unverified }`: "fail" when an
 * unrestricted session lacks a tool, "ok" when every tool was seen, and
 * "not-verified" otherwise.
 */
function checkMediaTools(sessions) {
  const verdicts = new Map();
  for (const { tools } of sessions) {
    if (!tools) {
      continue;
    }
    const unrestricted = isUnrestricted(tools);
    for (const name of AVAILABLE_MEDIA_TOOLS) {
      if (verdicts.has(name)) {
        continue;
      }
      if (tools.has(name)) {
        verdicts.set(name, "advertised");
      } else if (unrestricted) {
        verdicts.set(name, "missing");
      }
    }
    if (verdicts.size === AVAILABLE_MEDIA_TOOLS.length) {
      break;
    }
  }

  const advertised = AVAILABLE_MEDIA_TOOLS.filter((name) => verdicts.get(name) === "advertised");
  const missing = AVAILABLE_MEDIA_TOOLS.filter((name) => verdicts.get(name) === "missing");
  const unverified = AVAILABLE_MEDIA_TOOLS.filter((name) => !verdicts.has(name));
  const status = missing.length > 0 ? "fail" : unverified.length > 0 ? "not-verified" : "ok";
  return { status, advertised, missing, unverified };
}

/** The newest session's definition of `name`, or null when none offered it. */
function newestDefinition(sessions, name) {
  for (const { tools } of sessions) {
    const tool = tools?.get(name);
    if (tool) {
      return tool;
    }
  }
  return null;
}

/**
 * Values a tool's parameter description mentions, e.g. "either 480p or 720p",
 * lower-cased; null when the tool no longer has that parameter. Grok states its
 * limits in these descriptions rather than in the schema.
 */
function describedValues(tool, property, pattern) {
  const parameter = tool.parameters?.properties?.[property];
  if (!parameter) {
    return null;
  }
  return [...new Set((parameter.description ?? "").toLowerCase().match(pattern) ?? [])];
}

/**
 * Warn when a video tool's description starts naming a resolution or duration
 * the plugin does not allow — a sign a CLI update opened up something new.
 *
 * Returns `{ status, checked, warnings }`; `checked` lists the tools found.
 */
function checkAdvertisedLimits(sessions) {
  const warnings = [];
  const checked = [];

  for (const [name, durations] of Object.entries(DURATION_RULES)) {
    const tool = newestDefinition(sessions, name);
    if (!tool) {
      continue;
    }
    checked.push(name);

    // "720p", "1080P", "4K".
    const resolutions = describedValues(tool, "resolution_name", /\b(?:\d{3,4}p|\dk)\b/g);
    if (resolutions === null) {
      warnings.push(`${name} no longer describes resolution_name; check the plugin's resolutions (lib/media-spec.mjs).`);
    } else {
      const unknown = resolutions.filter((value) => !VIDEO_RESOLUTIONS.includes(value));
      if (unknown.length > 0) {
        warnings.push(`${name} now mentions resolution ${unknown.join(", ")}; the plugin allows ${VIDEO_RESOLUTIONS.join("/")} (lib/media-spec.mjs).`);
      }
    }

    // "6 or 10 seconds", "6s, 10s".
    const seconds = describedValues(tool, "duration", /\b\d+s?\b/g);
    if (seconds === null) {
      warnings.push(`${name} no longer describes duration; check the plugin's durations (lib/media-spec.mjs).`);
    } else {
      const unexpected = [...new Set(seconds.map((value) => Number.parseInt(value, 10)))].filter((value) => !durations.allows(value));
      if (unexpected.length > 0) {
        warnings.push(`${name} now mentions ${unexpected.join(", ")} s; the plugin allows ${durations.text} s (lib/media-spec.mjs).`);
      }
    }
  }

  const status = checked.length === 0 ? "not-verified" : warnings.length > 0 ? "warn" : "ok";
  return { status, checked, warnings };
}

/**
 * Tell which `reference_to_video` schema this CLI offers. The new one pins
 * first/last frames and keyframes and takes up to 14 reference images; older
 * builds take up to 7 and pin nothing. The image limit is read from the
 * description when it states one.
 *
 * Returns `{ status, schema, maxImages }`, with `schema` "new", "old" or null.
 */
function checkReferenceSchema(sessions) {
  const tool = newestDefinition(sessions, "reference_to_video");
  if (!tool) {
    return { status: "not-verified", schema: null, maxImages: null };
  }
  const properties = tool.parameters?.properties ?? {};
  const schema = ["first_frame", "last_frame", "keyframes"].some((name) => name in properties) ? "new" : "old";
  const stated = /up to (\d+)/i.exec(properties.images?.description ?? "");
  return { status: "ok", schema, maxImages: stated ? Number(stated[1]) : REFERENCE_SCHEMA_IMAGES[schema] };
}

/** A path with symlinks resolved, or the path itself when it cannot be. */
function realPath(file) {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return file;
  }
}

/**
 * Prove the session-log harvest still works on this CLI version.
 *
 * Finds the newest session that has media files on disk and checks the log
 * parser recovers them. Media on disk that the parser cannot see is the
 * signature of a changed log format — exactly what a CLI update would break.
 *
 * Returns `{ status, dir, mediaFiles, recovered, when }`.
 */
function checkHarvest(sessions) {
  for (const { dir } of sessions) {
    const onDisk = new Set(listSessionMediaFiles(dir).map(realPath));
    if (onDisk.size === 0) {
      continue;
    }
    const calls = extractMediaCalls(readSessionUpdates(dir));
    const recovered = calls.filter((call) => call.status === "completed" && call.path && onDisk.has(realPath(call.path)));
    return {
      status: recovered.length > 0 ? "ok" : "fail",
      dir,
      mediaFiles: onDisk.size,
      recovered: recovered.length,
      when: fs.statSync(dir).mtime.toISOString()
    };
  }
  return { status: "not-verified", dir: null, mediaFiles: 0, recovered: 0, when: null };
}
