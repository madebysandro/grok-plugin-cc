import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createSandbox } from "./companion-harness.mjs";
import { sessionDirFor } from "./helpers.mjs";

// Pins down the fake's side of the --session-id contract that media runs rely
// on to find their session folder.
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

test("the fake grok answers --version without opening a session", (t) => {
  const sandbox = createSandbox(t);

  const { stdout, status } = spawnSync(sandbox.grokBin, ["--version"], {
    env: { GROK_HOME: sandbox.grokHome },
    encoding: "utf8"
  });

  assert.equal(status, 0);
  assert.match(stdout, /^grok \d+\.\d+\.\d+/);
  assert.equal(fs.existsSync(path.join(sandbox.grokHome, "sessions")), false);
});

test("the fake grok can run slowly, or die before it answers", (t) => {
  const sandbox = createSandbox(t);
  const env = { GROK_HOME: sandbox.grokHome };

  sandbox.scenario({ delayMs: 300 });
  const startedAt = Date.now();
  const slow = spawnSync(sandbox.grokBin, ["-p", "hi", "--cwd", sandbox.workspace], { env, encoding: "utf8" });
  assert.ok(Date.now() - startedAt >= 300, "the run should take at least delayMs");
  assert.equal(JSON.parse(slow.stdout).text, "DONE");

  sandbox.scenario({ exit: { code: 3, stderr: "boom" } });
  const dead = spawnSync(sandbox.grokBin, ["-p", "hi", "--cwd", sandbox.workspace], { env, encoding: "utf8" });
  assert.equal(dead.status, 3);
  assert.equal(dead.stdout, "");
  assert.match(dead.stderr, /boom/);
});
