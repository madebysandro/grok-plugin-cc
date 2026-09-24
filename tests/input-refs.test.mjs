import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createSandbox } from "./companion-harness.mjs";

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The lines of the prompt the companion sent on the fake grok's newest run. */
function lastPromptLines(sandbox) {
  const call = sandbox.grokCalls().at(-1);
  return call.args[call.args.indexOf("-p") + 1].split("\n");
}

async function generateImage(sandbox, { job, prompt = "a red kite" } = {}) {
  sandbox.scenario({ calls: [{ tool: "image_gen", prompt }] });
  const args = ["image", prompt];
  if (job) {
    args.push("--job", job);
  }
  const result = await sandbox.run(args);
  assert.equal(result.code, 0, result.stderr || result.stdout);
}

test("animate --image @last uses the file generated last", async (t) => {
  const sandbox = createSandbox(t);
  await generateImage(sandbox, { prompt: "a red kite" });
  await generateImage(sandbox, { prompt: "a blue boat" });
  sandbox.scenario({ calls: [{ tool: "image_to_video" }] });

  const { code, stdout, stderr } = await sandbox.run(["animate", "the boat rocks", "--image", "@last"]);

  assert.equal(code, 0, stderr || stdout);
  assert.ok(lastPromptLines(sandbox).includes(path.join(sandbox.workspace, "grok-media", "a-blue-boat-1.jpg")));
});

test("a generation reports its job id, ready for job:<id>", async (t) => {
  const sandbox = createSandbox(t);
  sandbox.scenario({ calls: [{ tool: "image_gen" }] });
  const image = await sandbox.run(["image", "a red kite", "--json"]);
  const { jobId } = JSON.parse(image.stdout);
  sandbox.scenario({ calls: [{ tool: "image_to_video" }] });

  const { code, stdout, stderr } = await sandbox.run(["animate", "drift", "--image", `job:${jobId}`]);

  assert.equal(code, 0, stderr || stdout);
  assert.ok(lastPromptLines(sandbox).includes(path.join(sandbox.workspace, "grok-media", "a-red-kite-1.jpg")));
});

test("the text report names the job", async (t) => {
  const sandbox = createSandbox(t);
  sandbox.scenario({ calls: [{ tool: "image_gen" }] });

  const { stdout } = await sandbox.run(["image", "a red kite", "--job", "kite"]);

  assert.match(stdout, /· job kite(\s|·|$)/m);
});

test("animate --image job:<id> uses that job's first file", async (t) => {
  const sandbox = createSandbox(t);
  await generateImage(sandbox, { job: "kite" });
  sandbox.scenario({ calls: [{ tool: "image_to_video" }] });

  const { code, stdout, stderr } = await sandbox.run(["animate", "the kite drifts", "--image", "job:kite"]);

  assert.equal(code, 0, stderr || stdout);
  assert.ok(lastPromptLines(sandbox).includes(path.join(sandbox.workspace, "grok-media", "a-red-kite-1.jpg")));
});

test("edit --image job:<id>#N uses that job's Nth file", async (t) => {
  const sandbox = createSandbox(t);
  sandbox.scenario({ calls: [{ tool: "image_gen" }, { tool: "image_gen" }, { tool: "image_gen" }] });
  await sandbox.run(["image", "three kites", "--count", "3", "--job", "kites"]);
  sandbox.scenario({ calls: [{ tool: "image_edit" }] });

  const { code, stdout, stderr } = await sandbox.run(["edit", "make it blue", "--image", "job:kites#2"]);

  assert.equal(code, 0, stderr || stdout);
  const lines = lastPromptLines(sandbox);
  assert.ok(lines.includes(`- ${path.join(sandbox.workspace, "grok-media", "three-kites-2.jpg")}`), lines.join("\n"));
  assert.equal(lines.filter((line) => line.startsWith("- /")).length, 1);
});

/** A bad reference must fail locally: exit 1, a clear reason, no Grok run. */
async function assertRejectedBeforeGrok(sandbox, args, pattern) {
  const callsBefore = sandbox.grokCalls().length;
  const { code, stdout, stderr } = await sandbox.run(args);
  assert.equal(code, 1, stderr || stdout);
  assert.match(stderr, pattern);
  assert.equal(sandbox.grokCalls().length, callsBefore, "grok must not run for a bad reference");
}

test("a job id with no record fails before calling grok", async (t) => {
  const sandbox = createSandbox(t);
  await generateImage(sandbox, { job: "kite" });

  await assertRejectedBeforeGrok(
    sandbox,
    ["animate", "drift", "--image", "job:ghost"],
    /job:ghost: no Grok job with id "ghost" in this workspace.*\/grok:status/s
  );
});

test("a job that produced no files fails before calling grok", async (t) => {
  const sandbox = createSandbox(t);
  sandbox.scenario({ calls: [{ tool: "image_gen", error: "Image generation failed with HTTP 500" }] });
  await sandbox.run(["image", "a red kite", "--job", "broken"]);

  await assertRejectedBeforeGrok(
    sandbox,
    ["animate", "drift", "--image", "job:broken"],
    /job:broken: job "broken" \(image, failed\) has no files\./
  );
});

test("a file number outside the job fails before calling grok", async (t) => {
  const sandbox = createSandbox(t);
  sandbox.scenario({ calls: [{ tool: "image_gen" }, { tool: "image_gen" }] });
  await sandbox.run(["image", "two kites", "--count", "2", "--job", "kites"]);

  for (const ref of ["job:kites#3", "job:kites#0"]) {
    await assertRejectedBeforeGrok(
      sandbox,
      ["animate", "drift", "--image", ref],
      new RegExp(`${ref}: job "kites" has 2 files; use #1 to #2\\.`)
    );
  }
});

test("@last with nothing generated yet fails before calling grok", async (t) => {
  const sandbox = createSandbox(t);

  await assertRejectedBeforeGrok(
    sandbox,
    ["animate", "drift", "--image", "@last"],
    /@last: no generated files are recorded for this workspace yet\./
  );
});

test("a referenced file deleted from disk fails instead of falling back", async (t) => {
  const sandbox = createSandbox(t);
  await generateImage(sandbox, { prompt: "a red kite" });
  await generateImage(sandbox, { prompt: "a blue boat", job: "boat" });
  const boat = path.join(sandbox.workspace, "grok-media", "a-blue-boat-1.jpg");
  fs.rmSync(boat);

  for (const ref of ["@last", "job:boat"]) {
    await assertRejectedBeforeGrok(
      sandbox,
      ["animate", "drift", "--image", ref],
      new RegExp(`${escapeRegExp(ref)}: ${escapeRegExp(boat)} \\(job "boat"\\) no longer exists\\.`)
    );
  }
});

test("@last on a video fails for an image input and points at the job's still", async (t) => {
  const sandbox = createSandbox(t);
  sandbox.scenario({ calls: [{ tool: "image_gen" }, { tool: "image_to_video" }] });
  const video = await sandbox.run(["video", "a kite at dusk", "--job", "clip"]);
  assert.equal(video.code, 0, video.stderr || video.stdout);
  const clip = path.join(sandbox.workspace, "grok-media", "a-kite-at-dusk-2.mp4");

  await assertRejectedBeforeGrok(
    sandbox,
    ["animate", "drift", "--image", "@last"],
    new RegExp(`@last is ${escapeRegExp(clip)} from job "clip", which is not an image\\. For the job's still, use job:clip#1\\.`)
  );
});
