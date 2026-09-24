import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { LIB } from "./helpers.mjs";

const { AVAILABLE_MEDIA_TOOLS, isZeroDataRetentionVideoError, parseGrokEnvelope } = await import(path.join(LIB, "grok.mjs"));
const { MEDIA_DISALLOWED_TOOLS } = await import(path.join(LIB, "invocation.mjs"));

test("parses a clean JSON envelope", () => {
  const envelope = parseGrokEnvelope(JSON.stringify({ text: "hi", sessionId: "abc", total_cost_usd: 0.12 }));

  assert.equal(envelope.text, "hi");
  assert.equal(envelope.sessionId, "abc");
});

test("finds the envelope behind a leading banner", () => {
  const stdout = 'A new version of Grok is available!\n{"text":"hi","sessionId":"abc"}';
  assert.equal(parseGrokEnvelope(stdout).sessionId, "abc");
});

test("returns null for empty or unparseable output", () => {
  assert.equal(parseGrokEnvelope(""), null);
  assert.equal(parseGrokEnvelope("   "), null);
  assert.equal(parseGrokEnvelope("not json at all"), null);
});

test("recognises the Zero Data Retention video rejection", () => {
  const message =
    'Video generation failed with HTTP 400 Bad Request: {"code":"invalid-argument","error":"Zero Data Retention teams must provide output.upload_url for video generation."}';

  assert.equal(isZeroDataRetentionVideoError(message), true);
  assert.equal(isZeroDataRetentionVideoError("HTTP 500 Internal Server Error"), false);
  assert.equal(isZeroDataRetentionVideoError(""), false);
  assert.equal(isZeroDataRetentionVideoError(null), false);
});

test("media runs block the tools that cause detours", () => {
  // search_tool/use_tool matter most: without them a missing tool sends the
  // agent trawling MCP discovery for several turns instead of failing fast.
  for (const tool of ["search_tool", "use_tool", "run_terminal_command", "web_search"]) {
    assert.ok(MEDIA_DISALLOWED_TOOLS.includes(tool), `${tool} should be blocked during media runs`);
  }
});

test("the available media tool list matches Grok CLI 1.0", () => {
  // video_gen is in the binary's tool table but is not offered to the agent,
  // which is why text-to-video runs as image_gen -> image_to_video.
  assert.deepEqual(AVAILABLE_MEDIA_TOOLS, ["image_gen", "image_edit", "image_to_video", "reference_to_video"]);
});
