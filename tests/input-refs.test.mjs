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

function saved(sandbox, file) {
  return path.join(sandbox.workspace, "grok-media", file);
}

/** Run the companion with grok scripted to make `calls`, checking the exit code. */
async function generate(sandbox, args, calls, { expectCode = 0 } = {}) {
  sandbox.scenario({ calls });
  const result = await sandbox.run(args);
  assert.equal(result.code, expectCode, result.stderr || result.stdout);
  return result;
}

async function jobCount(sandbox) {
  const { stdout } = await sandbox.run(["status", "--json"]);
  return JSON.parse(stdout).jobs.length;
}

/** A bad reference must fail locally: exit 1, a clear reason, no Grok run, no job. */
async function assertRejectedBeforeGrok(sandbox, args, pattern) {
  const callsBefore = sandbox.grokCalls().length;
  const jobsBefore = await jobCount(sandbox);
  const { code, stdout, stderr } = await sandbox.run(args);
  assert.equal(code, 1, stderr || stdout);
  assert.match(stderr, pattern);
  assert.equal(sandbox.grokCalls().length, callsBefore, "grok must not run for a bad reference");
  assert.equal(await jobCount(sandbox), jobsBefore, "a bad reference must not create a job");
}

test("animate --image @last uses the file generated last", async (t) => {
  const sandbox = createSandbox(t);
  await generate(sandbox, ["image", "a red kite"], [{ tool: "image_gen" }]);
  await generate(sandbox, ["image", "a blue boat"], [{ tool: "image_gen" }]);

  await generate(sandbox, ["animate", "the boat rocks", "--image", "@last"], [{ tool: "image_to_video" }]);

  assert.ok(lastPromptLines(sandbox).includes(saved(sandbox, "a-blue-boat-1.jpg")));
});

test("@last skips newer jobs that saved nothing", async (t) => {
  const sandbox = createSandbox(t);
  await generate(sandbox, ["image", "a red kite"], [{ tool: "image_gen" }]);
  await generate(sandbox, ["image", "a blue boat"], [{ tool: "image_gen", error: "HTTP 500" }], { expectCode: 2 });

  await generate(sandbox, ["animate", "drift", "--image", "@last"], [{ tool: "image_to_video" }]);

  assert.ok(lastPromptLines(sandbox).includes(saved(sandbox, "a-red-kite-1.jpg")));
});

test("animate --image job:<id> uses that job's first file", async (t) => {
  const sandbox = createSandbox(t);
  await generate(sandbox, ["image", "a red kite", "--job", "kite"], [{ tool: "image_gen" }]);

  await generate(sandbox, ["animate", "the kite drifts", "--image", "job:kite"], [{ tool: "image_to_video" }]);

  assert.ok(lastPromptLines(sandbox).includes(saved(sandbox, "a-red-kite-1.jpg")));
});

test("edit --image job:<id>#N uses that job's Nth file", async (t) => {
  const sandbox = createSandbox(t);
  const three = [{ tool: "image_gen" }, { tool: "image_gen" }, { tool: "image_gen" }];
  await generate(sandbox, ["image", "three kites", "--count", "3", "--job", "kites"], three);

  await generate(sandbox, ["edit", "make it blue", "--image", "job:kites#2"], [{ tool: "image_edit" }]);

  const lines = lastPromptLines(sandbox);
  assert.ok(lines.includes(`- ${saved(sandbox, "three-kites-2.jpg")}`), lines.join("\n"));
  assert.equal(lines.filter((line) => line.startsWith("- /")).length, 1);
});

test("a generation reports its job id, ready for job:<id>", async (t) => {
  const sandbox = createSandbox(t);
  const image = await generate(sandbox, ["image", "a red kite", "--json"], [{ tool: "image_gen" }]);
  const { jobId } = JSON.parse(image.stdout);

  await generate(sandbox, ["animate", "drift", "--image", `job:${jobId}`], [{ tool: "image_to_video" }]);

  assert.ok(lastPromptLines(sandbox).includes(saved(sandbox, "a-red-kite-1.jpg")));
});

test("the text report names the job", async (t) => {
  const sandbox = createSandbox(t);

  const { stdout } = await generate(sandbox, ["image", "a red kite", "--job", "kite"], [{ tool: "image_gen" }]);

  assert.match(stdout, /· job kite(\s|·|$)/m);
});

test("a partial run reports its job id, and the still it kept is usable", async (t) => {
  const sandbox = createSandbox(t);
  const video = await generate(
    sandbox,
    ["video", "a kite at dusk", "--json"],
    [{ tool: "image_gen" }, { tool: "image_to_video", error: "HTTP 500" }],
    { expectCode: 2 }
  );
  const { jobId } = JSON.parse(video.stdout);

  await generate(sandbox, ["animate", "drift", "--image", `job:${jobId}`], [{ tool: "image_to_video" }]);

  assert.ok(lastPromptLines(sandbox).includes(saved(sandbox, "a-kite-at-dusk-1.jpg")));
});

test("a job id with no record fails before calling grok", async (t) => {
  const sandbox = createSandbox(t);
  await generate(sandbox, ["image", "a red kite", "--job", "kite"], [{ tool: "image_gen" }]);

  await assertRejectedBeforeGrok(
    sandbox,
    ["animate", "drift", "--image", "job:ghost"],
    /job:ghost: no Grok job with id "ghost" in this workspace.*\/grok:status/s
  );
});

test("a malformed job reference fails before calling grok", async (t) => {
  const sandbox = createSandbox(t);
  await generate(sandbox, ["image", "a red kite", "--job", "kite"], [{ tool: "image_gen" }]);

  await assertRejectedBeforeGrok(
    sandbox,
    ["animate", "drift", "--image", "job:"],
    /job:: no job id given; use job:<id> or job:<id>#N\./
  );
  for (const ref of ["job:kite#", "job:kite#x"]) {
    await assertRejectedBeforeGrok(
      sandbox,
      ["animate", "drift", "--image", ref],
      new RegExp(`${ref}: the file number after # must be a whole number, e\\.g\\. job:kite#1\\.`)
    );
  }
});

test("a job that produced no files fails before calling grok", async (t) => {
  const sandbox = createSandbox(t);
  await generate(sandbox, ["image", "a red kite", "--job", "broken"], [{ tool: "image_gen", error: "HTTP 500" }], {
    expectCode: 2
  });

  await assertRejectedBeforeGrok(
    sandbox,
    ["animate", "drift", "--image", "job:broken"],
    /job:broken: job "broken" \(image, failed\) has no files\./
  );
});

test("a file number outside the job fails before calling grok", async (t) => {
  const sandbox = createSandbox(t);
  await generate(sandbox, ["image", "two kites", "--count", "2", "--job", "kites"], [{ tool: "image_gen" }, { tool: "image_gen" }]);

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
  await generate(sandbox, ["image", "a red kite"], [{ tool: "image_gen" }]);
  await generate(sandbox, ["image", "a blue boat", "--job", "boat"], [{ tool: "image_gen" }]);
  const boat = saved(sandbox, "a-blue-boat-1.jpg");
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
  await generate(sandbox, ["video", "a kite at dusk", "--job", "clip"], [{ tool: "image_gen" }, { tool: "image_to_video" }]);
  const clip = saved(sandbox, "a-kite-at-dusk-2.mp4");

  await assertRejectedBeforeGrok(
    sandbox,
    ["animate", "drift", "--image", "@last"],
    new RegExp(`@last: ${escapeRegExp(clip)} \\(job "clip"\\) is not an image\\. For the job's still, use job:clip#1\\.`)
  );
});
