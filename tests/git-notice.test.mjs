import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { generate } from "./companion-assertions.mjs";
import { createSandbox } from "./companion-harness.mjs";

const HAS_GIT = spawnSync("git", ["--version"]).status === 0;
const needsGit = { skip: HAS_GIT ? false : "git not found on PATH; git notice tests skipped" };

const IMAGE_CALL = [{ tool: "image_gen" }];
const NOTICE = /git repository at .+ git does not ignore/;

/** Make the sandbox workspace a git repository, optionally with a .gitignore. */
function gitInit(sandbox, gitignore = null) {
  const result = spawnSync("git", ["init", "-q"], { cwd: sandbox.workspace, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  if (gitignore !== null) {
    fs.writeFileSync(path.join(sandbox.workspace, ".gitignore"), gitignore);
  }
}

test("the first run that saves into an unignored grok-media/ of a git repo says so, once", needsGit, async (t) => {
  const sandbox = createSandbox(t);
  gitInit(sandbox);

  const first = await generate(sandbox, ["image", "a red kite"], IMAGE_CALL);
  const second = await generate(sandbox, ["image", "a blue boat"], IMAGE_CALL);

  assert.match(first.stdout, /Note: grok-media\/ is inside the git repository/);
  assert.doesNotMatch(second.stdout, NOTICE);
  assert.equal(fs.existsSync(path.join(sandbox.workspace, ".gitignore")), false, "the plugin must never write a .gitignore");
});

test("no note when git ignores the output, and the .gitignore is left as it was", needsGit, async (t) => {
  const sandbox = createSandbox(t);
  gitInit(sandbox, "grok-media/\n");

  const { stdout } = await generate(sandbox, ["image", "a red kite"], IMAGE_CALL);

  assert.doesNotMatch(stdout, NOTICE);
  assert.equal(fs.readFileSync(path.join(sandbox.workspace, ".gitignore"), "utf8"), "grok-media/\n");
});

test("no note outside a git repository", needsGit, async (t) => {
  const sandbox = createSandbox(t);

  const { stdout } = await generate(sandbox, ["image", "a red kite"], IMAGE_CALL);

  assert.doesNotMatch(stdout, NOTICE);
});

test("--out into an unignored folder is noted even when grok-media/ is ignored", needsGit, async (t) => {
  const sandbox = createSandbox(t);
  gitInit(sandbox, "grok-media/\n");

  const { stdout } = await generate(sandbox, ["image", "a red kite", "--out", "renders", "--json"], IMAGE_CALL);

  const { notes } = JSON.parse(stdout);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^Note: renders\/ is inside the git repository/);
});

const HAS_FFMPEG = spawnSync("ffmpeg", ["-version"]).status === 0;
const needsGitAndFfmpeg = { skip: HAS_GIT && HAS_FFMPEG ? false : "git or ffmpeg not found on PATH; local-tool git notice test skipped" };

test("a local tool's output gets the note too, and once means once across commands", needsGitAndFfmpeg, async (t) => {
  const sandbox = createSandbox(t);
  gitInit(sandbox);
  const still = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x48", "-frames:v", "1", path.join(sandbox.workspace, "still.png")]);
  assert.equal(still.status, 0, String(still.stderr));

  const local = await sandbox.run(["reframe", "still.png", "--aspect", "1:1"]);
  const generated = await generate(sandbox, ["image", "a red kite"], IMAGE_CALL);

  assert.equal(local.code, 0, local.stderr);
  assert.match(local.stdout, NOTICE);
  assert.doesNotMatch(generated.stdout, NOTICE);
});

test("a run that keeps only part of what it made still gets the note", needsGit, async (t) => {
  const sandbox = createSandbox(t);
  gitInit(sandbox);

  const { stdout } = await generate(
    sandbox,
    ["video", "a kite at dusk"],
    [{ tool: "image_gen" }, { tool: "image_to_video", error: "HTTP 500" }],
    { expectCode: 2 }
  );

  assert.match(stdout, /intermediate file was kept/);
  assert.match(stdout, NOTICE);
});

test("parallel runs still show the note only once", needsGit, async (t) => {
  const sandbox = createSandbox(t);
  gitInit(sandbox);
  sandbox.scenario({ calls: IMAGE_CALL });

  const runs = await Promise.all([1, 2, 3, 4].map((n) => sandbox.run(["image", `kite ${n}`])));

  assert.deepEqual(runs.map((run) => run.code), [0, 0, 0, 0]);
  assert.equal(runs.filter((run) => NOTICE.test(run.stdout)).length, 1);
});

test("/grok:result shows the note of a run that went to the background", needsGit, async (t) => {
  const sandbox = createSandbox(t);
  gitInit(sandbox);

  const { stdout } = await generate(sandbox, ["image", "a red kite", "--json"], IMAGE_CALL);
  const result = await sandbox.run(["result", JSON.parse(stdout).jobId]);

  assert.match(result.stdout, NOTICE);
});

test("every file a run saves is checked, and the manifest too", needsGit, async (t) => {
  const sandbox = createSandbox(t);
  gitInit(sandbox, "*.jpg\n");
  const video = await generate(sandbox, ["video", "a kite at dusk", "--out", "clips"], [{ tool: "image_gen" }, { tool: "image_to_video" }]);

  const other = createSandbox(t);
  gitInit(other, "*.jpg\n");
  const image = await generate(other, ["image", "a red kite"], IMAGE_CALL);

  assert.match(video.stdout, NOTICE, "the still is ignored, the clip is not");
  assert.match(image.stdout, NOTICE, "the image is ignored, grok-manifest.json is not");
});

test("each folder gets its own note, once", needsGit, async (t) => {
  const sandbox = createSandbox(t);
  gitInit(sandbox);

  const renders = await generate(sandbox, ["image", "a red kite", "--out", "renders"], IMAGE_CALL);
  const media = await generate(sandbox, ["image", "a blue boat"], IMAGE_CALL);
  const again = await generate(sandbox, ["image", "a green kite", "--out", "renders"], IMAGE_CALL);

  assert.match(renders.stdout, /Note: renders\/ is inside the git repository/);
  assert.match(media.stdout, /Note: grok-media\/ is inside the git repository/);
  assert.doesNotMatch(again.stdout, NOTICE);
});

test("the note names the folder as git sees it, through a symlink or at the repository's root", needsGit, async (t) => {
  const sandbox = createSandbox(t);
  gitInit(sandbox);
  const link = path.join(path.dirname(sandbox.workspace), "workspace-link");
  fs.symlinkSync(sandbox.workspace, link);
  sandbox.scenario({ calls: IMAGE_CALL });

  const viaLink = await sandbox.run(["image", "a red kite"], { env: { CLAUDE_PROJECT_DIR: link } });
  const atRoot = await sandbox.run(["image", "a blue boat", "--out", "."]);

  assert.match(viaLink.stdout, /add `grok-media\/` to \.gitignore/);
  assert.match(atRoot.stdout, /the root of the git repository/);
  assert.doesNotMatch(atRoot.stdout, /`\.\/`/);
});
