import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createSandbox } from "./companion-harness.mjs";

const PROMPT = "a brass telescope on a walnut desk";

test("image copies the generated file into grok-media/", async (t) => {
  const sandbox = createSandbox(t);
  sandbox.scenario({ calls: [{ tool: "image_gen", prompt: PROMPT, content: "telescope-bytes" }] });

  const { code, stdout, stderr } = await sandbox.run(["image", PROMPT]);

  assert.equal(code, 0, stderr || stdout);
  const saved = path.join(sandbox.workspace, "grok-media", "a-brass-telescope-on-a-walnut-desk-1.jpg");
  assert.equal(fs.readFileSync(saved, "utf8"), "telescope-bytes");
});

test("image records the prompt and tool in the manifest", async (t) => {
  const sandbox = createSandbox(t);
  const toolPrompt = `${PROMPT}, soft window light`;
  sandbox.scenario({ calls: [{ tool: "image_gen", prompt: toolPrompt }] });

  await sandbox.run(["image", PROMPT]);

  const manifestFile = path.join(sandbox.workspace, "grok-media", "grok-manifest.json");
  const [generation] = JSON.parse(fs.readFileSync(manifestFile, "utf8")).generations;
  assert.equal(generation.command, "image");
  assert.equal(generation.requestedPrompt, PROMPT);
  assert.deepEqual(
    generation.assets.map(({ file, tool, prompt }) => ({ file, tool, prompt })),
    [{ file: "a-brass-telescope-on-a-walnut-desk-1.jpg", tool: "image_gen", prompt: toolPrompt }]
  );
});

test("image sends the prompt to grok verbatim", async (t) => {
  const sandbox = createSandbox(t);
  const prompt = 'shop sign reading "CAFÉ AURORA" and "Pão de queijo quentinho – R$ 5,90"';
  sandbox.scenario({ calls: [{ tool: "image_gen", prompt }] });

  await sandbox.run(["image", prompt]);

  const [call] = sandbox.grokCalls();
  const sent = call.args[call.args.indexOf("-p") + 1];
  assert.ok(sent.includes(prompt), sent);
});

test("a tool error is explained and exits non-zero", async (t) => {
  const sandbox = createSandbox(t);
  const error = "Image generation failed with HTTP 500 Internal Server Error";
  sandbox.scenario({ calls: [{ tool: "image_gen", prompt: PROMPT, error }] });

  const { code, stdout } = await sandbox.run(["image", PROMPT]);

  assert.notEqual(code, 0);
  assert.match(stdout, /Grok called the generation tool, but it returned an error\./);
  assert.ok(stdout.includes(error), stdout);
});

test("a run keeps job state in CLAUDE_PLUGIN_DATA, outside the workspace", async (t) => {
  const sandbox = createSandbox(t);
  sandbox.scenario({ calls: [{ tool: "image_gen", prompt: PROMPT }] });

  await sandbox.run(["image", PROMPT]);

  assert.deepEqual(fs.readdirSync(sandbox.workspace), ["grok-media"]);
  assert.equal(fs.readdirSync(path.join(sandbox.pluginData, "state")).length, 1);
});

// Slash commands decide to run in the background and pass their $ARGUMENTS
// through as they are, so the flag reaches the companion too.
test("--background never becomes part of the prompt sent to Grok", async (t) => {
  const sandbox = createSandbox(t);
  sandbox.scenario({ calls: [{ tool: "image_gen" }] });

  const { code, stdout, stderr } = await sandbox.run(["image", PROMPT, "--background"]);

  assert.equal(code, 0, stderr || stdout);
  const [call] = sandbox.grokCalls();
  const sent = call.args[call.args.indexOf("-p") + 1];
  assert.ok(sent.includes(PROMPT));
  assert.doesNotMatch(sent, /--background/);
});
