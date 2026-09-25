import assert from "node:assert/strict";
import test from "node:test";

import { assertRejectedBeforeGrok, generate, lastGeneration, sourceImage } from "./companion-assertions.mjs";
import { createSandbox } from "./companion-harness.mjs";

const GEN_OVERRIDE = "GROK_IMAGE_GEN_MODEL_OVERRIDE";
const EDIT_OVERRIDE = "GROK_IMAGE_EDIT_MODEL_OVERRIDE";

/** The environment the fake grok's newest run received. */
function lastGrokEnv(sandbox) {
  return sandbox.grokCalls().at(-1).env;
}

/** Each command that makes an image, the variable that picks its model, and a run of it. */
const IMAGE_COMMANDS = {
  image: { variable: GEN_OVERRIDE, args: () => ["image", "a café sign reading CAFÉ AURORA"], calls: [{ tool: "image_gen" }] },
  edit: { variable: EDIT_OVERRIDE, args: (sandbox) => ["edit", "make it night", "--image", sourceImage(sandbox)], calls: [{ tool: "image_edit" }] },
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

test("--image-model picks a model by name, or takes a Grok image model id as it is", async (t) => {
  const sandbox = createSandbox(t);
  const choices = {
    "2.0": "grok-imagine-image-2.0",
    standard: "grok-imagine-image",
    // A model newer than the plugin can be used before the plugin knows its name.
    "grok-imagine-image-3.0": "grok-imagine-image-3.0"
  };

  for (const [command, { variable, args, calls }] of Object.entries(IMAGE_COMMANDS)) {
    for (const [choice, model] of Object.entries(choices)) {
      await generate(sandbox, [...args(sandbox), "--image-model", choice], calls);
      assert.equal(lastGrokEnv(sandbox)[variable], model, `${command} --image-model ${choice}`);
    }
  }
});

test("--image-model server leaves the model to xAI, even over an inherited override", async (t) => {
  const sandbox = createSandbox(t);

  for (const [command, { variable, args, calls }] of Object.entries(IMAGE_COMMANDS)) {
    await generate(sandbox, [...args(sandbox), "--image-model", "server"], calls, { env: { [variable]: "inherited-model" } });
    assert.ok(!(variable in lastGrokEnv(sandbox)), `${command} --image-model server must not pass ${variable}`);
  }
});

test("without --image-model, Image 2.0 replaces an inherited override", async (t) => {
  const sandbox = createSandbox(t);
  const { variable, args, calls } = IMAGE_COMMANDS.image;

  await generate(sandbox, args(sandbox), calls, { env: { [variable]: "inherited-model" } });

  assert.equal(lastGrokEnv(sandbox)[variable], "grok-imagine-image-2.0");
});

test("an unknown --image-model is refused before calling grok", async (t) => {
  const sandbox = createSandbox(t);

  for (const { args } of Object.values(IMAGE_COMMANDS)) {
    await assertRejectedBeforeGrok(
      sandbox,
      [...args(sandbox), "--image-model", "3.0"],
      /--image-model 3\.0 is not a Grok image model\. Use one of: 2\.0, standard, server, or a model id such as grok-imagine-image-2\.0\./
    );
  }
  await assertRejectedBeforeGrok(sandbox, ["image", "a red kite", "--image-model="], /--image-model "" is not a Grok image model\./);
});

test("--image-model refuses grok-imagine-image-quality and its aliases, which xAI retires on 2026-11-02", async (t) => {
  const sandbox = createSandbox(t);

  for (const choice of ["quality", "grok-imagine-image-quality", "grok-imagine-image-quality-latest", "grok-imagine-image-pro"]) {
    await assertRejectedBeforeGrok(
      sandbox,
      ["image", "a red kite", "--image-model", choice],
      new RegExp(`--image-model ${choice} names a model xAI is retiring: from 2026-11-02 Image 2\\.0 at low quality serves it\\. Use 2\\.0 \\(the default\\) or standard\\.`)
    );
  }
});

test("--image-model standard notes that the model expands the prompt", async (t) => {
  const sandbox = createSandbox(t);
  const { args, calls } = IMAGE_COMMANDS.image;

  const standard = await generate(sandbox, [...args(sandbox), "--image-model", "standard"], calls);
  assert.match(standard.stdout, /Note: grok-imagine-image expands the prompt before generating, so the image does not follow it word for word\./);

  const latest = await generate(sandbox, args(sandbox), calls);
  assert.doesNotMatch(latest.stdout, /expands the prompt/);
});

test("--image-model on ask is refused: ask keeps Grok's own choice of model", async (t) => {
  const sandbox = createSandbox(t);

  await assertRejectedBeforeGrok(
    sandbox,
    ["ask", "draw me a logo", "--image-model", "standard"],
    /--image-model does not apply to ask; it is for image, edit and video\./
  );
});

test("--image-model on animate is refused: animate makes no image", async (t) => {
  const sandbox = createSandbox(t);

  await assertRejectedBeforeGrok(
    sandbox,
    ["animate", "drift", "--image", sourceImage(sandbox), "--image-model", "2.0"],
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

  await generate(sandbox, ["animate", "drift", "--image", sourceImage(sandbox)], [{ tool: "image_to_video" }]);
  assert.ok(!("imageModel" in lastGeneration(sandbox)), "animate makes no image");
});
