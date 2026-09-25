/**
 * `ask` keeps the original plugin's behaviour with the original plugin's
 * options, and refuses the options added since, which it would otherwise
 * drop without a word.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { assertRejectedBeforeGrok, generate, lastPromptLines, sourceImage } from "./companion-assertions.mjs";
import { createSandbox } from "./companion-harness.mjs";

const ASK = ["ask", "summarise the README"];

/** Each option added since the original plugin, as typed after an ask prompt. */
function addedOptions(sandbox) {
  const image = sourceImage(sandbox);
  return [
    ["--image", image],
    ["--image-model", "2.0"],
    ["--draft"],
    ["--draft=false"],
    ["--resolution", "720p"],
    ["--first-frame", image],
    ["--last-frame", image],
    ["--keyframe", `${image}@2`],
    ["--voice", "ara"],
    ["--loop"],
    ["--loop=false"],
    ["--text", "hello"],
    ["--sub", "world"],
    ["--brand", "brand.json"],
    ["--position", "top"],
    ["--style", "bold"],
    ["--mode", "pad"],
    ["--anchor", "top"],
    ["--reencode"],
    ["--key", "#00FF00"],
    ["--tolerance", "80"],
    ["--expect", "3"],
    ["--bg", "auto"]
  ];
}

test("ask refuses an option added since the original plugin instead of dropping it", async (t) => {
  const sandbox = createSandbox(t);
  const image = sourceImage(sandbox);

  await assertRejectedBeforeGrok(
    sandbox,
    ["ask", "describe", "--image", image, "--text", "hello"],
    /^--image does not apply to ask; it is for edit, animate, ref-video and overlay\.$/m
  );
});

test("ask refuses every option added since the original plugin, naming where it belongs", async (t) => {
  const sandbox = createSandbox(t);

  for (const option of addedOptions(sandbox)) {
    const flag = option[0].split("=")[0];
    await assertRejectedBeforeGrok(sandbox, [...ASK, ...option], new RegExp(`^${flag} does not apply to ask; it is for .+\\.$`, "m"));
  }
});

test("ask keeps taking every option the original plugin took, and none of them reaches the prompt", async (t) => {
  const sandbox = createSandbox(t);
  const original = [
    ["--out", "notes"],
    ["-o", "notes"],
    ["--aspect", "16:9"],
    ["--count", "2"],
    ["-n", "2"],
    ["--name", "summary"],
    ["--model", "grok-test"],
    ["-m", "grok-test"],
    ["--effort", "high"],
    ["--timeout", "60"],
    ["--duration", "6"],
    ["--job", "mine"],
    ["--json"],
    ["--verbatim"],
    ["--raw"],
    ["--keep-session"],
    ["--read-only"],
    ["--write"],
    ["--background"]
  ];

  for (const option of original) {
    const { code, stderr } = await generate(sandbox, [...ASK, ...option], []);
    assert.equal(code, 0, `${option[0]}: ${stderr}`);
    assert.equal(lastPromptLines(sandbox)[0], "summarise the README", `${option[0]} must stay out of the prompt`);
  }
});

test("ask brings a --timeout outside 30-3600 into range, as it always did, instead of refusing it", async (t) => {
  const sandbox = createSandbox(t);

  for (const value of ["5", "99999", "forever"]) {
    const { code, stderr } = await generate(sandbox, [...ASK, "--timeout", value], []);
    assert.equal(code, 0, `--timeout ${value}: ${stderr}`);
  }
  assert.equal(sandbox.grokCalls().length, 3);

  // A 1-second limit taken as given would kill this run; raised to 30 s, it finishes.
  sandbox.scenario({ delayMs: 1500 });
  const { code, stdout, stderr } = await sandbox.run([...ASK, "--timeout", "1"]);
  assert.equal(code, 0, stderr || stdout);
});

test("ask --json names the command, on success and on failure", async (t) => {
  const sandbox = createSandbox(t);

  const done = await generate(sandbox, [...ASK, "--json"], []);
  const { ok, command, text } = JSON.parse(done.stdout);
  assert.deepEqual({ ok, command, text }, { ok: true, command: "ask", text: "DONE" });

  sandbox.scenario({ exit: { code: 3, stderr: "grok blew up" } });
  const failed = await sandbox.run([...ASK, "--json"]);
  assert.equal(failed.code, 2, failed.stderr);
  const payload = JSON.parse(failed.stdout);
  assert.deepEqual({ ok: payload.ok, command: payload.command }, { ok: false, command: "ask" });
  assert.match(payload.reason, /Grok exited with code 3\.\ngrok blew up/);
});
