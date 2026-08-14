/**
 * Reading Grok session logs.
 *
 * Grok writes generated media into its own session folder and reports the path
 * in `updates.jsonl`. Harvesting from that log is far more reliable than asking
 * the agent to copy files itself: it costs no extra turns, it cannot be
 * paraphrased away, and it still works when the agent forgets to mention paths.
 *
 * Layout: ~/.grok/sessions/<encodeURIComponent(cwd)>/<session-id>/updates.jsonl
 */

import fs from "node:fs";
import path from "node:path";

import { GROK_HOME, MEDIA_TOOLS } from "./grok.mjs";

const MEDIA_OUTPUT_TYPES = new Set(Object.values(MEDIA_TOOLS));
const MEDIA_TOOL_NAMES = new Set(Object.keys(MEDIA_TOOLS));

export function sessionsRoot() {
  return path.join(GROK_HOME, "sessions");
}

/**
 * Locate a session directory by id.
 *
 * The encoded-cwd path is tried first, then a scan of every workspace bucket —
 * Grok keys the bucket on the cwd it actually resolved, which may differ from
 * ours through symlinks (`/tmp` vs `/private/tmp` on macOS, for one).
 */
export function resolveSessionDir(sessionId, cwd) {
  if (!sessionId) {
    return null;
  }

  const root = sessionsRoot();

  if (cwd) {
    const candidates = [cwd];
    try {
      candidates.push(fs.realpathSync.native(cwd));
    } catch {
      // cwd may not exist any more; the scan below still covers us
    }
    for (const candidate of candidates) {
      const direct = path.join(root, encodeURIComponent(candidate), sessionId);
      if (isDirectory(direct)) {
        return direct;
      }
    }
  }

  let buckets;
  try {
    buckets = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const bucket of buckets) {
    if (!bucket.isDirectory()) {
      continue;
    }
    const candidate = path.join(root, bucket.name, sessionId);
    if (isDirectory(candidate)) {
      return candidate;
    }
  }

  return null;
}

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/** Parse `updates.jsonl`, skipping any partially-flushed trailing line. */
export function readSessionUpdates(sessionDir) {
  const updatesFile = path.join(sessionDir, "updates.jsonl");
  let raw;
  try {
    raw = fs.readFileSync(updatesFile, "utf8");
  } catch {
    return [];
  }

  const entries = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // A truncated last line is expected while a run is still in flight.
    }
  }
  return entries;
}

function updateOf(entry) {
  return entry?.params?.update ?? entry?.update ?? null;
}

function toolMetaOf(update) {
  return update?._meta?.["x.ai/tool"] ?? null;
}

/**
 * Walk a session log and return every media tool call it contains.
 *
 * Each result is `{ toolCallId, tool, outputType, status, path, filename,
 * sessionFolder, prompt, aspectRatio, error }`. Failed calls are included with
 * `status: "failed"` and their error text, which is what lets the companion
 * explain a Zero Data Retention rejection instead of reporting "no output".
 */
export function extractMediaCalls(updates) {
  /** @type {Map<string, any>} */
  const calls = new Map();

  const ensure = (toolCallId) => {
    if (!calls.has(toolCallId)) {
      calls.set(toolCallId, {
        toolCallId,
        tool: null,
        outputType: null,
        status: "pending",
        path: null,
        filename: null,
        sessionFolder: null,
        prompt: null,
        aspectRatio: null,
        error: null,
        order: calls.size
      });
    }
    return calls.get(toolCallId);
  };

  for (const entry of updates) {
    const update = updateOf(entry);
    const kind = update?.sessionUpdate;
    if (kind !== "tool_call" && kind !== "tool_call_update") {
      continue;
    }

    const toolCallId = update.toolCallId;
    if (!toolCallId) {
      continue;
    }

    const meta = toolMetaOf(update);
    const rawInput = update.rawInput ?? null;
    const rawOutput = update.rawOutput ?? null;

    const toolName = meta?.name ?? (typeof update.title === "string" ? update.title : null);
    const variant = rawInput?.variant ?? null;
    const outputType = rawOutput?.type ?? null;

    const looksLikeMedia =
      (toolName && MEDIA_TOOL_NAMES.has(toolName)) ||
      (variant && MEDIA_OUTPUT_TYPES.has(variant)) ||
      (outputType && MEDIA_OUTPUT_TYPES.has(outputType));

    // The terminal update of a failed call carries no tool metadata at all —
    // just `{ status, content, rawOutput: { error, message } }`. Once a call id
    // is known to be a media call, every later update for it must be consumed,
    // or the failure (and its error text) is silently dropped.
    if (!looksLikeMedia && !calls.has(toolCallId)) {
      continue;
    }

    const call = ensure(toolCallId);

    if (toolName && MEDIA_TOOL_NAMES.has(toolName)) {
      call.tool = toolName;
    }
    if (variant && MEDIA_OUTPUT_TYPES.has(variant)) {
      call.outputType = variant;
    }
    if (outputType && MEDIA_OUTPUT_TYPES.has(outputType)) {
      call.outputType = outputType;
    }

    // The agent rewrites the user's prompt before calling the tool; capturing
    // the prompt it actually sent is what makes results reproducible.
    if (typeof rawInput?.prompt === "string" && rawInput.prompt) {
      call.prompt = rawInput.prompt;
    }
    if (typeof rawInput?.aspect_ratio === "string" && rawInput.aspect_ratio) {
      call.aspectRatio = rawInput.aspect_ratio;
    }

    if (typeof rawOutput?.path === "string" && rawOutput.path) {
      call.path = rawOutput.path;
      call.filename = rawOutput.filename ?? path.basename(rawOutput.path);
      call.sessionFolder = rawOutput.session_folder ?? null;
    }

    if (update.status === "completed" || update.status === "failed") {
      call.status = update.status;
    }

    // A failed call reports the reason on rawOutput rather than as a path.
    const rawError = rawOutput?.message ?? rawOutput?.error;
    if (typeof rawError === "string" && rawError) {
      call.error = rawError;
    }

    const contentText = flattenContentText(update.content);
    if (contentText) {
      if (!call.path) {
        // Some builds report the path only inside the textual tool result.
        const parsed = parsePathFromToolText(contentText);
        if (parsed) {
          call.path = parsed.path;
          call.filename = parsed.filename ?? path.basename(parsed.path);
          call.sessionFolder = parsed.sessionFolder ?? null;
        }
      }
      if (looksLikeError(contentText)) {
        call.error = contentText.trim();
      }
    }
  }

  const results = [...calls.values()];

  for (const call of results) {
    if (call.error && call.status !== "failed") {
      call.status = "failed";
    }
    if (call.path && !call.error) {
      call.status = "completed";
    }
  }

  return results.sort((left, right) => left.order - right.order).map(({ order, ...rest }) => rest);
}

function flattenContentText(content) {
  if (!content) {
    return "";
  }
  const items = Array.isArray(content) ? content : [content];
  const parts = [];
  for (const item of items) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    const text = item?.content?.text ?? item?.text;
    if (typeof text === "string") {
      parts.push(text);
    }
  }
  return parts.join("\n");
}

function parsePathFromToolText(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.path === "string") {
      return {
        path: parsed.path,
        filename: parsed.filename ?? null,
        sessionFolder: parsed.session_folder ?? null
      };
    }
  } catch {
    // not JSON; nothing more to recover
  }
  return null;
}

function looksLikeError(text) {
  return /HTTP\s+\d{3}|"error"\s*:|\berror\b:|failed|invalid-argument/i.test(text);
}

/** The assistant's final message, reconstructed from its streamed chunks. */
export function extractAgentMessage(updates) {
  const parts = [];
  for (const entry of updates) {
    const update = updateOf(entry);
    if (update?.sessionUpdate !== "agent_message_chunk") {
      continue;
    }
    const text = update?.content?.text;
    if (typeof text === "string") {
      parts.push(text);
    }
  }
  return parts.join("").trim();
}

/**
 * Files present in a session's media folders.
 *
 * A safety net for the rare case where the log is missing or truncated but the
 * assets did land on disk.
 */
export function listSessionMediaFiles(sessionDir) {
  const folders = ["images", "videos", "media"];
  const found = [];

  for (const folder of folders) {
    const dir = path.join(sessionDir, folder);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith(".")) {
        continue;
      }
      found.push(path.join(dir, entry.name));
    }
  }

  return found.sort();
}
