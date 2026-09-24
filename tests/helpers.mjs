import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..", "plugins", "grok");
export const LIB = path.join(PLUGIN_ROOT, "scripts", "lib");

export function makeTempDir(prefix = "grok-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Wrap an update object in the `session/update` envelope Grok writes. */
export function updateEntry(update, sessionId = "test-session") {
  return { timestamp: 0, method: "session/update", params: { sessionId, update } };
}

/** A successful media tool call, as three updates. */
export function mediaCallUpdates({
  toolCallId,
  tool = "image_gen",
  variant = "ImageGen",
  prompt = "a test image",
  aspectRatio = "1:1",
  filePath = "/tmp/session/images/1.jpg"
}) {
  return [
    updateEntry({
      sessionUpdate: "tool_call",
      toolCallId,
      title: tool,
      rawInput: { prompt, aspect_ratio: aspectRatio },
      _meta: { "x.ai/tool": { name: tool, kind: tool } }
    }),
    updateEntry({
      sessionUpdate: "tool_call_update",
      toolCallId,
      rawInput: { variant, prompt, aspect_ratio: aspectRatio },
      _meta: { "x.ai/tool": { name: tool, kind: tool } }
    }),
    updateEntry({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      content: [
        {
          type: "content",
          content: { type: "text", text: JSON.stringify({ path: filePath, filename: path.basename(filePath), session_folder: "images" }) }
        }
      ],
      rawOutput: { type: variant, path: filePath, filename: path.basename(filePath), session_folder: "images" }
    })
  ];
}

/**
 * A failed media tool call.
 *
 * The terminal update deliberately carries no `x.ai/tool` metadata and no
 * `rawOutput.type` — this mirrors what Grok actually writes, and is what the
 * extractor previously skipped.
 */
export function failedMediaCallUpdates({
  toolCallId,
  tool = "image_to_video",
  variant = "ImageToVideo",
  prompt = "animate it",
  message = 'Video generation failed with HTTP 400 Bad Request: {"code":"invalid-argument","error":"Zero Data Retention teams must provide output.upload_url for video generation."}'
}) {
  return [
    updateEntry({
      sessionUpdate: "tool_call",
      toolCallId,
      title: tool,
      rawInput: { prompt },
      _meta: { "x.ai/tool": { name: tool, kind: tool } }
    }),
    updateEntry({
      sessionUpdate: "tool_call_update",
      toolCallId,
      rawInput: { variant, prompt },
      _meta: { "x.ai/tool": { name: tool, kind: tool } }
    }),
    updateEntry({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "failed",
      content: [{ type: "content", content: { type: "text", text: `Tool \`${tool}\` failed: ${message}` } }],
      rawOutput: { error: "tool_execution_failed", message }
    })
  ];
}

export function agentMessage(text) {
  return updateEntry({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
}

/** Where Grok keeps a session: `<root>/sessions/<encoded cwd>/<session-id>`. */
export function sessionDirFor(root, sessionId, cwd) {
  return path.join(root, "sessions", encodeURIComponent(cwd), sessionId);
}

/** Write updates to a session directory laid out the way Grok does. */
export function writeSession(root, sessionId, updates, { cwd = "/tmp/workspace" } = {}) {
  const dir = sessionDirFor(root, sessionId, cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "updates.jsonl"), updates.map((entry) => JSON.stringify(entry)).join("\n"), "utf8");
  return dir;
}
