import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { LIB, agentMessage, cleanup, failedMediaCallUpdates, makeTempDir, mediaCallUpdates, updateEntry, writeSession } from "./helpers.mjs";

const { extractAgentMessage, extractMediaCalls, listSessionMediaFiles, readSessionUpdates } = await import(
  path.join(LIB, "session.mjs")
);

test("extracts a completed media call with its path and prompt", () => {
  const updates = mediaCallUpdates({
    toolCallId: "call-1",
    prompt: "a brass telescope",
    aspectRatio: "16:9",
    filePath: "/tmp/session/images/1.jpg"
  });

  const calls = extractMediaCalls(updates);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, "image_gen");
  assert.equal(calls[0].outputType, "ImageGen");
  assert.equal(calls[0].status, "completed");
  assert.equal(calls[0].path, "/tmp/session/images/1.jpg");
  assert.equal(calls[0].prompt, "a brass telescope");
  assert.equal(calls[0].aspectRatio, "16:9");
});

test("captures a failed call whose terminal update carries no tool metadata", () => {
  // Regression: the final update of a failed call has neither `x.ai/tool` nor
  // `rawOutput.type`, so a metadata-only filter drops the error entirely and
  // the call is left looking merely pending.
  const updates = failedMediaCallUpdates({ toolCallId: "call-2" });

  const calls = extractMediaCalls(updates);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, "image_to_video");
  assert.equal(calls[0].status, "failed");
  assert.match(calls[0].error, /Zero Data Retention/);
  assert.equal(calls[0].path, null);
});

test("keeps successful and failed calls apart in one session", () => {
  const updates = [
    ...mediaCallUpdates({ toolCallId: "call-still", filePath: "/tmp/session/images/1.jpg" }),
    ...failedMediaCallUpdates({ toolCallId: "call-video" })
  ];

  const calls = extractMediaCalls(updates);

  assert.equal(calls.length, 2);
  assert.equal(calls.filter((call) => call.status === "completed").length, 1);
  assert.equal(calls.filter((call) => call.status === "failed").length, 1);
  // Order follows the session log, so the still comes first.
  assert.equal(calls[0].outputType, "ImageGen");
  assert.equal(calls[1].outputType, "ImageToVideo");
});

test("ignores non-media tool calls", () => {
  const updates = [
    updateEntry({
      sessionUpdate: "tool_call",
      toolCallId: "call-read",
      title: "read_file",
      rawInput: { target_file: "/tmp/a.txt" },
      _meta: { "x.ai/tool": { name: "read_file", kind: "read" } }
    }),
    updateEntry({ sessionUpdate: "tool_call_update", toolCallId: "call-read", status: "completed", content: [] })
  ];

  assert.deepEqual(extractMediaCalls(updates), []);
});

test("reassembles the streamed agent message", () => {
  const updates = [agentMessage("Generating "), agentMessage("the image."), agentMessage(" DONE")];
  assert.equal(extractAgentMessage(updates), "Generating the image. DONE");
});

test("reads updates.jsonl and tolerates a truncated trailing line", () => {
  const root = makeTempDir();
  try {
    const dir = writeSession(root, "sess-1", mediaCallUpdates({ toolCallId: "call-1" }));
    fs.appendFileSync(path.join(dir, "updates.jsonl"), '\n{"partial": ');

    const updates = readSessionUpdates(dir);

    assert.equal(updates.length, 3);
    assert.equal(extractMediaCalls(updates).length, 1);
  } finally {
    cleanup(root);
  }
});

test("returns no updates when the session log is absent", () => {
  const root = makeTempDir();
  try {
    assert.deepEqual(readSessionUpdates(path.join(root, "nope")), []);
  } finally {
    cleanup(root);
  }
});

test("lists media files sitting in a session's asset folders", () => {
  const root = makeTempDir();
  try {
    const dir = writeSession(root, "sess-2", []);
    fs.mkdirSync(path.join(dir, "images"), { recursive: true });
    fs.writeFileSync(path.join(dir, "images", "1.jpg"), "x");
    fs.writeFileSync(path.join(dir, "images", ".hidden"), "x");

    const files = listSessionMediaFiles(dir);

    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith("1.jpg"));
  } finally {
    cleanup(root);
  }
});
