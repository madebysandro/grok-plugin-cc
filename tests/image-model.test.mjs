import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { assertRejectedBeforeGrok, generate, lastGeneration } from "./companion-assertions.mjs";
import { createSandbox } from "./companion-harness.mjs";

const GEN_OVERRIDE = "GROK_IMAGE_GEN_MODEL_OVERRIDE";
const EDIT_OVERRIDE = "GROK_IMAGE_EDIT_MODEL_OVERRIDE";

/** The environment the fake grok's newest run received. */
function lastGrokEnv(sandbox) {
  return sandbox.grokCalls().at(-1).env;
}

/** A source image in the workspace for `edit` to work on. */
function source(sandbox) {
  const file = path.join(sandbox.workspace, "in.png");
  fs.writeFileSync(file, "png-bytes");
  return file;
}

/** Each command that makes an image, the variable that picks its model, and a run of it. */
const IMAGE_COMMANDS = {
  image: { variable: GEN_OVERRIDE, args: () => ["image", "a café sign reading CAFÉ AURORA"], calls: [{ tool: "image_gen" }] },
  edit: { variable: EDIT_OVERRIDE, args: (sandbox) => ["edit", "make it night", "--image", source(sandbox)], calls: [{ tool: "image_edit" }] },
  video: { variable: GEN_OVERRIDE, args: () => ["video", "a kite at dusk"], calls: [{ tool: "image_gen" }, { tool: "image_to_video" }] }
};

for (const [command, { variable, args, calls }] of Object.entries(IMAGE_COMMANDS)) {
  test(`${command} asks for Image 2.0 by default, through ${variable} only`, async (t) => {
    const sandbox = createSandbox(t);

    await generate(sandbox, args(sandbox), calls);

    const env = lastGrokEnv(sandbox);
    assert.equal(env[variable], "grok-imagine-image-2.0");
    const other = variable === GEN_OVERRIDE ? EDIT_OVERRIDE : GEN_OVERRIDE;
    assert.ok(!(other in env), `${other} belongs to the other image tool`);
  });
}

test("--image-model picks the older models by name", async (t) => {
  const sandbox = createSandbox(t);
  const choices = { quality: "grok-imagine-image-quality", standard: "grok-imagine-image" };

  for (const [command, { variable, args, calls }] of Object.entries(IMAGE_COMMANDS)) {
    for (const [choice, model] of Object.entries(choices)) {
      await generate(sandbox, [...args(sandbox), "--image-model", choice], calls);
      assert.equal(lastGrokEnv(sandbox)[variable], model, `${command} --image-model ${choice}`);
    }
  }
});

/** Run like `generate`, but with an image model override already in the user's environment. */
async function generateWithInherited(sandbox, variable, args, calls) {
  sandbox.scenario({ calls });
  const result = await sandbox.run(args, { env: { [variable]: "inherited-model" } });
  assert.equal(result.code, 0, result.stderr || result.stdout);
}

test("--image-model server leaves the model to xAI, even over an inherited override", async (t) => {
  const sandbox = createSandbox(t);

  for (const [command, { variable, args, calls }] of Object.entries(IMAGE_COMMANDS)) {
    await generateWithInherited(sandbox, variable, [...args(sandbox), "--image-model", "server"], calls);
    assert.ok(!(variable in lastGrokEnv(sandbox)), `${command} --image-model server must not pass ${variable}`);
  }
});

test("without --image-model, Image 2.0 replaces an inherited override", async (t) => {
  const sandbox = createSandbox(t);
  const { variable, args, calls } = IMAGE_COMMANDS.image;

  await generateWithInherited(sandbox, variable, args(sandbox), calls);

  assert.equal(lastGrokEnv(sandbox)[variable], "grok-imagine-image-2.0");
});

test("an unknown --image-model is refused before calling grok", async (t) => {
  const sandbox = createSandbox(t);

  for (const { args } of Object.values(IMAGE_COMMANDS)) {
    await assertRejectedBeforeGrok(
      sandbox,
      [...args(sandbox), "--image-model", "3.0"],
      /--image-model 3\.0 is not a Grok image model\. Use one of: 2\.0, quality, standard, server\./
    );
  }
});

test("--image-model on animate is refused: animate makes no image", async (t) => {
  const sandbox = createSandbox(t);

  await assertRejectedBeforeGrok(
    sandbox,
    ["animate", "drift", "--image", source(sandbox), "--image-model", "2.0"],
    /--image-model does not apply to animate; it is for image, edit and video\./
  );
});

test("the manifest records the image model asked for", async (t) => {
  const sandbox = createSandbox(t);
  const { args, calls } = IMAGE_COMMANDS.image;

  await generate(sandbox, args(sandbox), calls);
  assert.equal(lastGeneration(sandbox).imageModel, "grok-imagine-image-2.0");

  await generate(sandbox, [...args(sandbox), "--image-model", "server"], calls);
  assert.equal(lastGeneration(sandbox).imageModel, "server");

  await generate(sandbox, ["animate", "drift", "--image", source(sandbox)], [{ tool: "image_to_video" }]);
  assert.ok(!("imageModel" in lastGeneration(sandbox)), "animate makes no image");
});
