import assert from "node:assert/strict";
import test from "node:test";

import { assertRejectedBeforeGrok, generate, lastGeneration, lastPromptLines, sourceImage } from "./companion-assertions.mjs";
import { createSandbox } from "./companion-harness.mjs";

/** The prompt line that sets `key`, e.g. `resolution_name: 720p (...)`, or undefined. */
function promptSetting(sandbox, key) {
  return lastPromptLines(sandbox).find((line) => line.startsWith(`${key}: `));
}

const VIDEO_CALLS = [{ tool: "image_gen" }, { tool: "image_to_video" }];

function pick(object, keys) {
  return Object.fromEntries(keys.map((key) => [key, object[key]]));
}

test("animate asks for 720p and 6 s by default, with no aspect ratio", async (t) => {
  const sandbox = createSandbox(t);

  await generate(sandbox, ["animate", "the kite drifts", "--image", sourceImage(sandbox)], [{ tool: "image_to_video" }]);

  assert.match(promptSetting(sandbox, "resolution_name"), /^resolution_name: 720p\b/);
  assert.match(promptSetting(sandbox, "duration"), /^duration: 6 seconds\b/);
  assert.equal(promptSetting(sandbox, "aspect_ratio"), undefined);
});

test("video asks for 720p on its animation step by default", async (t) => {
  const sandbox = createSandbox(t);

  await generate(sandbox, ["video", "a kite at dusk"], VIDEO_CALLS);

  assert.match(promptSetting(sandbox, "resolution_name"), /^resolution_name: 720p \(for `image_to_video`/);
});

test("--draft asks for 480p at 6 s", async (t) => {
  const sandbox = createSandbox(t);
  const runs = [
    [["animate", "drift", "--image", sourceImage(sandbox), "--draft"], [{ tool: "image_to_video" }]],
    [["video", "a kite at dusk", "--draft"], VIDEO_CALLS]
  ];

  for (const [args, calls] of runs) {
    await generate(sandbox, args, calls);
    assert.match(promptSetting(sandbox, "resolution_name"), /^resolution_name: 480p\b/);
    assert.match(promptSetting(sandbox, "duration"), /^duration: 6 seconds\b/);
    assert.ok(!lastPromptLines(sandbox).some((line) => line.includes("--draft")), "--draft must not leak into the prompt");
  }
});

test("--resolution takes a bare number as the p-suffixed name", async (t) => {
  const sandbox = createSandbox(t);

  await generate(sandbox, ["video", "a kite at dusk", "--resolution", "480"], VIDEO_CALLS);

  assert.match(promptSetting(sandbox, "resolution_name"), /^resolution_name: 480p\b/);
});

test("an option missing its value is refused with a plain message", async (t) => {
  const sandbox = createSandbox(t);

  await assertRejectedBeforeGrok(sandbox, ["video", "a kite at dusk", "--resolution"], /^Missing value for --resolution\n$/);
});

test("--draft keeps an explicit --duration", async (t) => {
  const sandbox = createSandbox(t);

  await generate(sandbox, ["animate", "drift", "--image", sourceImage(sandbox), "--draft", "--duration", "10"], [{ tool: "image_to_video" }]);

  assert.match(promptSetting(sandbox, "resolution_name"), /^resolution_name: 480p\b/);
  assert.match(promptSetting(sandbox, "duration"), /^duration: 10 seconds\b/);
});

test("--draft with an explicit --resolution is refused before calling grok", async (t) => {
  const sandbox = createSandbox(t);

  await assertRejectedBeforeGrok(
    sandbox,
    ["video", "a kite at dusk", "--draft", "--resolution", "720p"],
    /--draft already means 480p; drop --resolution, or drop --draft to choose the resolution\./
  );
});

test("--resolution 1080p is refused, explaining the CLI stops at 720p", async (t) => {
  const sandbox = createSandbox(t);

  for (const args of [["animate", "drift", "--image", sourceImage(sandbox)], ["video", "a kite at dusk"]]) {
    await assertRejectedBeforeGrok(
      sandbox,
      [...args, "--resolution", "1080p"],
      /--resolution 1080p is not available.*only 480p or 720p.*Grok app, not to the CLI/s
    );
  }
});

test("a duration other than 6 or 10 s is refused for animate and video", async (t) => {
  const sandbox = createSandbox(t);

  for (const args of [["animate", "drift", "--image", sourceImage(sandbox)], ["video", "a kite at dusk"]]) {
    await assertRejectedBeforeGrok(sandbox, [...args, "--duration", "3"], /--duration 3 is not accepted by image_to_video\. Use 6 or 10 seconds/);
  }
});

test("--aspect on animate is refused, explaining the video keeps the image's shape", async (t) => {
  const sandbox = createSandbox(t);

  await assertRejectedBeforeGrok(
    sandbox,
    ["animate", "drift", "--image", sourceImage(sandbox), "--aspect", "16:9"],
    /--aspect does not apply to animate: image_to_video keeps the source image's shape/
  );
});

test("an aspect ratio image_gen does not take is refused for image and video", async (t) => {
  const sandbox = createSandbox(t);

  for (const args of [["image", "a red kite"], ["video", "a kite at dusk"]]) {
    await assertRejectedBeforeGrok(
      sandbox,
      [...args, "--aspect", "4:3"],
      /--aspect 4:3 is not accepted by image_gen.*Use one of: 1:1, 16:9, 9:16, 3:2, 2:3, auto\./
    );
  }
});

test("edit --aspect with a single image is refused: only multi-image edits take one", async (t) => {
  const sandbox = createSandbox(t);

  await assertRejectedBeforeGrok(
    sandbox,
    ["edit", "make it blue", "--image", sourceImage(sandbox), "--aspect", "16:9"],
    /--aspect applies to edit only with 2 or more --image inputs; a single-image edit keeps the source image's shape\./
  );
});

test("edit --aspect with several images checks image_edit's list", async (t) => {
  const sandbox = createSandbox(t);
  const image = sourceImage(sandbox);

  await assertRejectedBeforeGrok(
    sandbox,
    ["edit", "merge them", "--image", image, "--image", image, "--aspect", "5:4"],
    /--aspect 5:4 is not accepted by image_edit\. Use one of: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 2:1, 1:2, 19\.5:9, 9:19\.5, 20:9, 9:20, auto\./
  );
  await generate(sandbox, ["edit", "merge them", "--image", image, "--image", image, "--aspect", "4:3"], [{ tool: "image_edit" }]);
  assert.equal(promptSetting(sandbox, "aspect_ratio"), "aspect_ratio: 4:3");
});

test("--draft=false on an image run is not a draft request", async (t) => {
  const sandbox = createSandbox(t);

  await generate(sandbox, ["image", "a red kite", "--draft=false"], [{ tool: "image_gen" }]);
});

test("video-only options are refused for image and edit, naming where they apply", async (t) => {
  const sandbox = createSandbox(t);
  const commands = { image: ["image", "a red kite"], edit: ["edit", "make it blue", "--image", sourceImage(sandbox)] };
  const flags = { "--draft": [], "--resolution": ["720p"], "--duration": ["6"] };

  for (const [command, args] of Object.entries(commands)) {
    for (const [flag, value] of Object.entries(flags)) {
      await assertRejectedBeforeGrok(
        sandbox,
        [...args, flag, ...value],
        new RegExp(`${flag} does not apply to ${command}; it is for animate, video and ref-video\\.`)
      );
    }
  }
});

test("the manifest records the duration, resolution and draft a video run asked for", async (t) => {
  const sandbox = createSandbox(t);

  await generate(sandbox, ["animate", "drift", "--image", sourceImage(sandbox)], [{ tool: "image_to_video" }]);
  assert.deepEqual(pick(lastGeneration(sandbox), ["duration", "resolution", "draft"]), { duration: 6, resolution: "720p", draft: false });
  assert.ok(!("aspect" in lastGeneration(sandbox)), "animate has no aspect to record");

  await generate(sandbox, ["video", "a kite at dusk", "--draft", "--duration", "10", "--aspect", "9:16"], VIDEO_CALLS);
  assert.deepEqual(pick(lastGeneration(sandbox), ["aspect", "duration", "resolution", "draft"]), {
    aspect: "9:16",
    duration: 10,
    resolution: "480p",
    draft: true
  });
});

test("an image run's manifest has no video settings", async (t) => {
  const sandbox = createSandbox(t);

  await generate(sandbox, ["image", "a red kite", "--aspect", "3:2"], [{ tool: "image_gen" }]);

  const generation = lastGeneration(sandbox);
  assert.equal(generation.aspect, "3:2");
  for (const key of ["duration", "resolution", "draft"]) {
    assert.ok(!(key in generation), `${key} should not be recorded for an image`);
  }
});
