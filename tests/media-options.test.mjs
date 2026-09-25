import assert from "node:assert/strict";
import test from "node:test";

import { assertRejectedBeforeGrok, generate, lastGeneration, lastPromptLines, sizedImage, sourceImage } from "./companion-assertions.mjs";
import { createSandbox } from "./companion-harness.mjs";
import { OLD_REFERENCE_TO_VIDEO, addSession } from "./grok-fixtures.mjs";

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

test("video takes 6 or 10 s, and points to animate for other lengths", async (t) => {
  const sandbox = createSandbox(t);

  await assertRejectedBeforeGrok(
    sandbox,
    ["video", "a kite at dusk", "--duration", "3"],
    /--duration 3 is not accepted by image_to_video\. Use 6 or 10 seconds\. For another length, make the still with image and animate it with animate --duration\./
  );
});

test("animate refuses a length outside 1–15 s", async (t) => {
  const sandbox = createSandbox(t);
  const still = sizedImage(sandbox, 1280, 720);

  for (const seconds of ["0", "16"]) {
    await assertRejectedBeforeGrok(
      sandbox,
      ["animate", "drift", "--image", still, "--duration", seconds],
      new RegExp(`--duration ${seconds} is outside animate's range of 1–15 seconds\\.`)
    );
  }
});

/** The JSON arguments a reference_to_video prompt passes, from the newest run. */
function referenceArguments(sandbox) {
  const lines = lastPromptLines(sandbox);
  const start = lines.indexOf("{");
  const end = lines.indexOf("}", start);
  return JSON.parse(lines.slice(start, end + 1).join("\n"));
}

/** The `--tools` the newest Grok run was given. */
function offeredTools(sandbox) {
  const { args } = sandbox.grokCalls().at(-1);
  return args[args.indexOf("--tools") + 1];
}

test("animate makes other lengths with reference_to_video, the still pinned as the first frame", async (t) => {
  const sandbox = createSandbox(t);
  const still = sizedImage(sandbox, 1280, 720);

  const { stdout } = await generate(sandbox, ["animate", "the kite drifts", "--image", still, "--duration", "8"], [{ tool: "reference_to_video" }]);

  assert.equal(offeredTools(sandbox), "reference_to_video");
  assert.deepEqual(referenceArguments(sandbox), { aspect_ratio: "16:9", duration: 8, resolution_name: "720p", first_frame: still });
  assert.ok(lastPromptLines(sandbox).includes("the kite drifts"), "the motion prompt goes through as written");
  assert.deepEqual(pick(lastGeneration(sandbox), ["duration", "resolution", "aspect"]), { duration: 8, resolution: "720p", aspect: "16:9" });
  assert.ok(!("videoTool" in lastGeneration(sandbox)), "the manifest records settings, not how the plugin chose the tool");
  assert.doesNotMatch(stdout, /Note:/);
});

test("animate keeps image_to_video for 6 and 10 s", async (t) => {
  const sandbox = createSandbox(t);

  for (const seconds of ["6", "10"]) {
    await generate(sandbox, ["animate", "drift", "--image", sourceImage(sandbox), "--duration", seconds], [{ tool: "image_to_video" }]);
    assert.equal(offeredTools(sandbox), "image_to_video");
  }
});

test("animate through reference_to_video picks the closest aspect ratio, and says so when the still has none of them", async (t) => {
  const sandbox = createSandbox(t);
  const phone = sizedImage(sandbox, 1170, 2532, "phone.png");

  const { stdout } = await generate(sandbox, ["animate", "drift", "--image", phone, "--duration", "4", "--draft"], [{ tool: "reference_to_video" }]);

  assert.deepEqual(pick(referenceArguments(sandbox), ["aspect_ratio", "duration", "resolution_name"]), {
    aspect_ratio: "9:16",
    duration: 4,
    resolution_name: "480p"
  });
  assert.match(stdout, /Note: reference_to_video, which makes clips of this length, offers no 1170×2532 shape; the clip was asked for at 9:16/);
});

test("animate refuses other lengths when the installed Grok offers the older reference_to_video, which pins no frame", async (t) => {
  const sandbox = createSandbox(t);
  addSession(sandbox, { tools: ["reference_to_video"], parameters: { reference_to_video: OLD_REFERENCE_TO_VIDEO } });
  const still = sizedImage(sandbox, 1280, 720);

  await assertRejectedBeforeGrok(
    sandbox,
    ["animate", "drift", "--image", still, "--duration", "8"],
    /This Grok CLI offers the older reference_to_video, which cannot pin a first frame, so animate only makes 6 or 10 s clips\./
  );
  await generate(sandbox, ["animate", "drift", "--image", still, "--duration", "10"], [{ tool: "image_to_video" }]);
});

test("animate refuses, for a length made with reference_to_video, a still whose size it cannot read", async (t) => {
  const sandbox = createSandbox(t);

  await assertRejectedBeforeGrok(
    sandbox,
    ["animate", "drift", "--image", sourceImage(sandbox), "--duration", "8"],
    /Could not read the size of .*in\.png\. A clip of this length is made with reference_to_video/
  );
});

test("--aspect on animate is refused, explaining the video keeps the image's shape", async (t) => {
  const sandbox = createSandbox(t);

  await assertRejectedBeforeGrok(
    sandbox,
    ["animate", "drift", "--image", sourceImage(sandbox), "--aspect", "16:9"],
    /--aspect does not apply to animate: image_to_video keeps the source image's shape/
  );
});

test("image and video take every aspect ratio Image 2.0 does, 21:9 and 5:2 included", async (t) => {
  const sandbox = createSandbox(t);

  for (const aspect of ["21:9", "5:2", "4:3", "9:19.5"]) {
    await generate(sandbox, ["image", "a red kite", "--aspect", aspect], [{ tool: "image_gen" }]);
    assert.equal(promptSetting(sandbox, "aspect_ratio"), `aspect_ratio: ${aspect}`);
  }
  await generate(sandbox, ["video", "a kite at dusk", "--aspect", "21:9"], VIDEO_CALLS);
  assert.match(promptSetting(sandbox, "aspect_ratio"), /^aspect_ratio: 21:9 \(for `image_gen`/);
});

test("an aspect ratio no Grok image model takes is refused for image and video", async (t) => {
  const sandbox = createSandbox(t);

  for (const args of [["image", "a red kite"], ["video", "a kite at dusk"]]) {
    await assertRejectedBeforeGrok(
      sandbox,
      [...args, "--aspect", "5:4"],
      /--aspect 5:4 is not accepted by image_gen.*Use one of: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 2:1, 1:2, 19\.5:9, 9:19\.5, 20:9, 9:20, 21:9, 5:2, auto\./
    );
  }
});

test("21:9 and 5:2 are refused on the models older than Image 2.0", async (t) => {
  const sandbox = createSandbox(t);

  await assertRejectedBeforeGrok(
    sandbox,
    ["image", "a red kite", "--aspect", "21:9", "--image-model", "standard"],
    /--aspect 21:9 is not accepted by image_gen on grok-imagine-image\. Use one of: .*9:20, auto\./
  );
  await assertRejectedBeforeGrok(
    sandbox,
    ["image", "a red kite", "--aspect", "5:2", "--image-model", "server"],
    /--aspect 5:2 is not accepted by image_gen on xAI's default model\./
  );
  await generate(sandbox, ["image", "a red kite", "--aspect", "4:3", "--image-model", "standard"], [{ tool: "image_gen" }]);
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
    /--aspect 5:4 is not accepted by image_edit\. Use one of: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 2:1, 1:2, 19\.5:9, 9:19\.5, 20:9, 9:20, 21:9, 5:2, auto\./
  );
  for (const aspect of ["4:3", "21:9"]) {
    await generate(sandbox, ["edit", "merge them", "--image", image, "--image", image, "--aspect", aspect], [{ tool: "image_edit" }]);
    assert.equal(promptSetting(sandbox, "aspect_ratio"), `aspect_ratio: ${aspect}`);
  }
});

test("edit combines up to 5 images on Image 2.0, and up to 3 on the older models", async (t) => {
  const sandbox = createSandbox(t);
  const images = (count) => Array.from({ length: count }, (_, index) => ["--image", sourceImage(sandbox, `in-${index}.png`)]).flat();

  await generate(sandbox, ["edit", "put them on one table", ...images(5)], [{ tool: "image_edit" }]);
  await assertRejectedBeforeGrok(sandbox, ["edit", "put them on one table", ...images(6)], /image_edit takes at most 5 source images; got 6\./);

  await generate(sandbox, ["edit", "put them on one table", ...images(3), "--image-model", "standard"], [{ tool: "image_edit" }]);
  await assertRejectedBeforeGrok(
    sandbox,
    ["edit", "put them on one table", ...images(4), "--image-model", "standard"],
    /image_edit on grok-imagine-image takes at most 3 source images \(5 with Image 2\.0, the default\); got 4\./
  );
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

test("options a generation command would ignore are refused, naming the commands they are for", async (t) => {
  const sandbox = createSandbox(t);
  const image = sourceImage(sandbox);

  const refusals = [
    [["animate", "drift", "--image", image, "--count", "2"], /--count does not apply to animate; it is for image and edit\./],
    [["video", "a kite at dusk", "--count", "2"], /--count does not apply to video; it is for image and edit\./],
    [["ref-video", "a kite at dusk", "--image", image, "--count", "2"], /--count does not apply to ref-video; it is for image and edit\./],
    [["image", "a red kite", "--image", image], /--image does not apply to image; it is for edit, animate, ref-video and overlay\./],
    [["video", "a kite at dusk", "--image", image], /--image does not apply to video; it is for edit, animate, ref-video and overlay\./],
    [["image", "a red kite", "--write"], /--write does not apply to image; it is for ask\./]
  ];
  for (const [args, pattern] of refusals) {
    await assertRejectedBeforeGrok(sandbox, args, pattern);
  }
});

test("a flag the plugin does not have reaches Grok in the prompt rather than vanishing", async (t) => {
  const sandbox = createSandbox(t);

  await generate(sandbox, ["image", "a red kite", "--vivid"], [{ tool: "image_gen" }]);

  assert.ok(lastPromptLines(sandbox).includes("a red kite --vivid"), lastPromptLines(sandbox).join("\n"));
});

test("the original plugin's dead flags are refused by the generation commands and the local tools, not sent to Grok", async (t) => {
  const sandbox = createSandbox(t);
  const image = sourceImage(sandbox);

  const refusals = [
    [["image", "a red kite", "--raw"], /--raw is not an option of this plugin\./],
    [["video", "a kite at dusk", "--keep-session"], /--keep-session is not an option of this plugin\./],
    [["edit", "make it night", "--image", image, "--read-only"], /--read-only is not an option of this plugin\./],
    [["ref-video", "<IMAGE_0> walks in", "--image", image, "--raw"], /--raw is not an option of this plugin\./],
    [["mute", "clip.mp4", "--keep-session"], /--keep-session is not an option of this plugin\./]
  ];
  for (const [args, pattern] of refusals) {
    await assertRejectedBeforeGrok(sandbox, args, pattern);
  }
});

test("status, result, cancel and setup still take the original plugin's dead flags, as before", async (t) => {
  const sandbox = createSandbox(t);

  for (const command of ["status", "result", "cancel", "setup"]) {
    for (const flag of ["--raw", "--keep-session", "--read-only"]) {
      const { code, stdout, stderr } = await sandbox.run([command, flag]);
      assert.equal(code, 0, `${command} ${flag}: ${stderr || stdout}`);
    }
  }
});

test("ask still takes --read-only as it always did: read-only, and the flag stays out of the prompt", async (t) => {
  const sandbox = createSandbox(t);

  const { code, stderr } = await generate(sandbox, ["ask", "summarise the README", "--read-only", "--raw"], []);

  assert.equal(code, 0, stderr);
  const [call] = sandbox.grokCalls();
  const prompt = call.args[call.args.indexOf("-p") + 1];
  assert.ok(prompt.startsWith("summarise the README\n"), prompt);
  assert.ok(!prompt.includes("--read-only") && !prompt.includes("--raw"), prompt);
  assert.match(call.args[call.args.indexOf("--disallowed-tools") + 1], /\bwrite\b/);
});

test("animate refuses a second --image instead of animating only the first", async (t) => {
  const sandbox = createSandbox(t);
  const image = sourceImage(sandbox);

  await assertRejectedBeforeGrok(
    sandbox,
    ["animate", "drift", "--image", image, "--image", image],
    /animate takes one --image \(the still to animate\); got 2\./
  );
});

test("the generation commands refuse --count and --timeout values out of range, not quietly changing them", async (t) => {
  const sandbox = createSandbox(t);

  const refusals = [
    [["image", "a red kite", "--count", "20"], /--count 20 is not a whole number from 1 to 8\./],
    [["image", "a red kite", "--count", "abc"], /--count abc is not a whole number from 1 to 8\./],
    [["image", "a red kite", "--timeout", "5"], /--timeout 5 is not a whole number from 30 to 3600\./],
    [["video", "a kite at dusk", "--timeout", "forever"], /--timeout forever is not a whole number from 30 to 3600\./]
  ];
  for (const [args, pattern] of refusals) {
    await assertRejectedBeforeGrok(sandbox, args, pattern);
  }
});

test("--background is for Claude, which runs the command in the background; it never reaches Grok", async (t) => {
  const sandbox = createSandbox(t);

  await generate(sandbox, ["image", "a red kite", "--background"], [{ tool: "image_gen" }]);

  const lines = lastPromptLines(sandbox);
  assert.ok(lines.includes("a red kite"), lines.join("\n"));
  assert.ok(!lines.some((line) => line.includes("--background")), lines.join("\n"));
});
