/**
 * Shared steps and checks for black-box companion tests, on top of the
 * sandbox from `companion-harness.mjs`.
 */

import assert from "node:assert/strict";

/** The lines of the prompt the companion sent on the fake grok's newest run. */
export function lastPromptLines(sandbox) {
  const call = sandbox.grokCalls().at(-1);
  return call.args[call.args.indexOf("-p") + 1].split("\n");
}

/** Run the companion with grok scripted to make `calls`, checking the exit code. */
export async function generate(sandbox, args, calls, { expectCode = 0 } = {}) {
  sandbox.scenario({ calls });
  const result = await sandbox.run(args);
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
