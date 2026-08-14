import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { LIB } from "./helpers.mjs";

const { formatBytes, formatCost, formatDuration, renderJobList, renderMediaFailure, renderMediaResult, truncate } =
  await import(path.join(LIB, "render.mjs"));

test("formats sizes, durations, and cost", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatBytes(NaN), "unknown size");

  assert.equal(formatDuration(9000), "9s");
  assert.equal(formatDuration(125_000), "2m 5s");
  assert.equal(formatDuration(-1), "unknown");

  assert.equal(formatCost(0.1527), "$0.1527");
  assert.equal(formatCost(NaN), null);
});

test("truncate adds an ellipsis only when it cuts", () => {
  assert.equal(truncate("short", 20), "short");
  assert.equal(truncate("abcdefghij", 5), "abcd…");
});

test("a successful media result lists every file and its prompt", () => {
  const text = renderMediaResult({
    title: "Generated",
    saved: [{ file: "/out/shot-1.jpg", bytes: 293_000, tool: "image_gen", prompt: "a telescope", aspectRatio: "16:9" }],
    outDir: "/out",
    elapsedMs: 28_000,
    costUsd: 0.1527,
    sessionId: "sess-1"
  });

  assert.match(text, /Generated: 1 file/);
  assert.match(text, /\/out\/shot-1\.jpg/);
  assert.match(text, /prompt: a telescope/);
  assert.match(text, /16:9/);
  assert.match(text, /28s · \$0\.1527 · session sess-1/);
});

test("a failure surfaces the tool error and the actionable hint", () => {
  const text = renderMediaFailure({
    title: "Animated",
    reason: "xAI rejected the video request.",
    hint: "Turn data retention back on for this account.",
    agentMessage: "Video generation failed.",
    sessionId: "sess-2",
    failedCalls: [{ tool: "image_to_video", error: "HTTP 400: Zero Data Retention teams must provide output.upload_url" }]
  });

  assert.match(text, /Animated produced no files\./);
  assert.match(text, /xAI rejected the video request\./);
  assert.match(text, /image_to_video failed:/);
  assert.match(text, /Zero Data Retention/);
  assert.match(text, /Turn data retention back on/);
  assert.match(text, /Session: sess-2/);
});

test("a partial run says so and still lists what was kept", () => {
  // The still frame of a failed video run is worth keeping, but reporting it as
  // success would be the wrong answer.
  const text = renderMediaFailure({
    title: "Generated video",
    reason: "The still frame was generated, but the animation step produced no video.",
    partialAssets: [{ file: "/out/frame-1.jpg", bytes: 290_000, tool: "image_gen" }],
    outDir: "/out"
  });

  assert.match(text, /did not complete/);
  assert.match(text, /1 intermediate file was kept/);
  assert.match(text, /\/out\/frame-1\.jpg/);
  assert.doesNotMatch(text, /produced no files/);
});

test("the job list renders, and reads sensibly when empty", () => {
  assert.match(renderJobList([]), /No Grok jobs recorded/);

  const text = renderJobList([
    { id: "image-abc", command: "image", status: "completed", assetCount: 2, outDir: "/out/shots", prompt: "a telescope", createdAt: "2026-08-14T10:00:00.000Z" }
  ]);

  assert.match(text, /image-abc/);
  assert.match(text, /completed · 2 files · shots/);
  assert.match(text, /a telescope/);
});
