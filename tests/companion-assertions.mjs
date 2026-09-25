/**
 * Shared steps and checks for black-box companion tests, on top of the
 * sandbox from `companion-harness.mjs`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** The lines of the prompt the companion sent on the fake grok's newest run. */
export function lastPromptLines(sandbox) {
  const call = sandbox.grokCalls().at(-1);
  return call.args[call.args.indexOf("-p") + 1].split("\n");
}

/** The newest entry of the manifest in the workspace's `grok-media/`. */
export function lastGeneration(sandbox) {
  const manifest = JSON.parse(fs.readFileSync(path.join(sandbox.workspace, "grok-media", "grok-manifest.json"), "utf8"));
  return manifest.generations.at(-1);
}

/** Write a stand-in source image into the workspace and return its path. */
export function sourceImage(sandbox, name = "in.png") {
  const file = path.join(sandbox.workspace, name);
  fs.writeFileSync(file, "png-bytes");
  return file;
}

/**
 * Run the companion with grok scripted to make `calls`, checking the exit code.
 * `env` adds variables to the companion's environment, as if set in the user's shell.
 */
export async function generate(sandbox, args, calls, { expectCode = 0, env } = {}) {
  sandbox.scenario({ calls });
  const result = await sandbox.run(args, { env });
  assert.equal(result.code, expectCode, result.stderr || result.stdout);
  return result;
}

async function jobCount(sandbox) {
  const { stdout } = await sandbox.run(["status", "--json"]);
  return JSON.parse(stdout).jobs.length;
}

/** A refused run must fail locally: exit 1, a clear reason, no Grok run, no job. */
export async function assertRejectedBeforeGrok(sandbox, args, pattern) {
  const callsBefore = sandbox.grokCalls().length;
  const jobsBefore = await jobCount(sandbox);
  const { code, stdout, stderr } = await sandbox.run(args);
  assert.equal(code, 1, stderr || stdout);
  assert.match(stderr, pattern);
  assert.equal(sandbox.grokCalls().length, callsBefore, "grok must not run for a refused run");
  assert.equal(await jobCount(sandbox), jobsBefore, "a refused run must not create a job");
}
