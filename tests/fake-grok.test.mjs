import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createSandbox } from "./companion-harness.mjs";
import { sessionDirFor } from "./helpers.mjs";

// The companion does not pass --session-id yet, so this pins down the fake's
// side of that contract directly: later tickets rely on it.
test("the fake grok writes its session under the --session-id it is given", (t) => {
  const sandbox = createSandbox(t);
  sandbox.scenario({ calls: [{ tool: "image_gen" }] });

  const { stdout } = spawnSync(
    sandbox.grokBin,
    ["-p", "draw", "--cwd", sandbox.workspace, "--session-id", "0192f0c4-fixed"],
    { env: { GROK_HOME: sandbox.grokHome }, encoding: "utf8" }
  );

  assert.equal(JSON.parse(stdout).sessionId, "0192f0c4-fixed");
  const sessionDir = sessionDirFor(sandbox.grokHome, "0192f0c4-fixed", sandbox.workspace);
  assert.ok(fs.existsSync(path.join(sessionDir, "updates.jsonl")));
});

test("the fake grok records the args and env it was run with", (t) => {
  const sandbox = createSandbox(t);

  spawnSync(sandbox.grokBin, ["-p", "draw", "--cwd", sandbox.workspace], {
    env: { GROK_HOME: sandbox.grokHome, GROK_TEST_MARKER: "on" }
  });

  const [call] = sandbox.grokCalls();
  assert.deepEqual(call.args, ["-p", "draw", "--cwd", sandbox.workspace]);
  // macOS adds this one to every process it starts.
  const { __CF_USER_TEXT_ENCODING, ...env } = call.env;
  assert.deepEqual(env, { GROK_HOME: sandbox.grokHome, GROK_TEST_MARKER: "on" });
});
