import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { assertRejectedBeforeGrok, generate, lastGeneration, lastPromptLines, sourceImage } from "./companion-assertions.mjs";
import { createSandbox } from "./companion-harness.mjs";
import { OLD_REFERENCE_TO_VIDEO, addSession } from "./grok-fixtures.mjs";

const PROMPT = "<IMAGE_0> hands <IMAGE_1> across the counter";
const REFERENCE_CALL = [{ tool: "reference_to_video" }];

/** `flag value` repeated `times` times, e.g. eight `--image a.png`. */
function repeat(flag, value, times) {
  return Array.from({ length: times }, () => [flag, value]).flat();
}

/** The structured arguments the prompt tells Grok to pass, as sent (a JSON block). */
function toolArguments(sandbox) {
  const lines = lastPromptLines(sandbox);
  const start = lines.indexOf("{");
  const end = lines.indexOf("}", start);
  return JSON.parse(lines.slice(start, end + 1).join("\n"));
}

test("ref-video sends its reference images as exact arguments, with 16:9, 6 s and 720p by default", async (t) => {
  const sandbox = createSandbox(t);
  const barista = sourceImage(sandbox, "barista.png");
  const cup = sourceImage(sandbox, "cup.png");

  await generate(sandbox, ["ref-video", PROMPT, "--image", "barista.png", "--image", "cup.png"], REFERENCE_CALL);

  assert.deepEqual(toolArguments(sandbox), {
    aspect_ratio: "16:9",
    duration: 6,
    resolution_name: "720p",
    images: [barista, cup]
  });
  assert.ok(lastPromptLines(sandbox).includes(PROMPT), "the prompt must reach Grok verbatim");
});

test("ref-video saves the clip and records it in the manifest", async (t) => {
  const sandbox = createSandbox(t);
  sourceImage(sandbox, "barista.png");

  await generate(sandbox, ["ref-video", "a barista waves", "--image", "barista.png"], REFERENCE_CALL);

  const generation = lastGeneration(sandbox);
  assert.equal(generation.command, "ref-video");
  assert.deepEqual([generation.duration, generation.resolution, generation.aspect], [6, "720p", "16:9"]);
  assert.equal(generation.assets[0].tool, "reference_to_video");
  assert.ok(fs.existsSync(path.join(sandbox.workspace, "grok-media", generation.assets[0].file)));
});

function pick(object, keys) {
  return Object.fromEntries(keys.map((key) => [key, object[key]]));
}

test("ref-video passes --aspect, --duration and --resolution through", async (t) => {
  const sandbox = createSandbox(t);
  sourceImage(sandbox, "barista.png");

  await generate(
    sandbox,
    ["ref-video", PROMPT, "--image", "barista.png", "--aspect", "9:16", "--duration", "4", "--resolution", "480p"],
    REFERENCE_CALL
  );

  assert.deepEqual(pick(toolArguments(sandbox), ["aspect_ratio", "duration", "resolution_name"]), {
    aspect_ratio: "9:16",
    duration: 4,
    resolution_name: "480p"
  });
});

test("ref-video --draft asks for 480p, at 6 s unless --duration is given", async (t) => {
  const sandbox = createSandbox(t);
  sourceImage(sandbox, "barista.png");

  await generate(sandbox, ["ref-video", PROMPT, "--image", "barista.png", "--draft"], REFERENCE_CALL);
  assert.deepEqual(pick(toolArguments(sandbox), ["duration", "resolution_name"]), { duration: 6, resolution_name: "480p" });

  await generate(sandbox, ["ref-video", PROMPT, "--image", "barista.png", "--draft", "--duration", "3"], REFERENCE_CALL);
  assert.deepEqual(pick(toolArguments(sandbox), ["duration", "resolution_name"]), { duration: 3, resolution_name: "480p" });
  assert.equal(lastGeneration(sandbox).draft, true);
});

test("ref-video refuses options Grok would reject, before running it", async (t) => {
  const sandbox = createSandbox(t);
  sourceImage(sandbox, "barista.png");
  const base = ["ref-video", PROMPT, "--image", "barista.png"];

  await assertRejectedBeforeGrok(sandbox, [...base, "--duration", "16"], /outside reference_to_video's range of 1–15 seconds/);
  await assertRejectedBeforeGrok(sandbox, [...base, "--aspect", "2:1"], /--aspect 2:1 is not accepted by reference_to_video/);
  await assertRejectedBeforeGrok(sandbox, [...base, "--resolution", "1080p"], /accept only 480p or 720p/);
  await assertRejectedBeforeGrok(sandbox, [...base, "--draft", "--resolution", "720p"], /--draft already means 480p/);
  await assertRejectedBeforeGrok(sandbox, [...base, "--image-model", "2.0"], /--image-model does not apply to ref-video/);
});

test("ref-video sends first/last frames, keyframes and voices as exact arguments", async (t) => {
  const sandbox = createSandbox(t);
  const open = sourceImage(sandbox, "open.png");
  const close = sourceImage(sandbox, "close.png");
  const middle = sourceImage(sandbox, "middle.png");

  await generate(
    sandbox,
    [
      "ref-video", "<AUDIO_0> greets the room",
      "--first-frame", "open.png", "--last-frame", "close.png",
      "--keyframe", "middle.png@3", "--voice", "Ara", "--voice", "eve"
    ],
    REFERENCE_CALL
  );

  assert.deepEqual(toolArguments(sandbox), {
    aspect_ratio: "16:9",
    duration: 6,
    resolution_name: "720p",
    first_frame: open,
    last_frame: close,
    keyframes: [{ image: middle, timestamp_s: 3 }],
    voices: ["ara", "eve"]
  });
});

test("ref-video refuses inputs reference_to_video would reject, before running it", async (t) => {
  const sandbox = createSandbox(t);
  sourceImage(sandbox, "a.png");
  const run = (...args) => ["ref-video", PROMPT, ...args];

  await assertRejectedBeforeGrok(sandbox, run(), /needs at least one input/);
  await assertRejectedBeforeGrok(sandbox, run(...repeat("--image", "a.png", 15)), /at most 14 reference images; got 15/);
  await assertRejectedBeforeGrok(sandbox, run(...repeat("--voice", "eve", 4)), /at most 3 voices; got 4/);
  await assertRejectedBeforeGrok(
    sandbox,
    run("--keyframe", "a.png@1", "--keyframe", "a.png@2", "--keyframe", "a.png@3", "--keyframe", "a.png@4", "--keyframe", "a.png@5"),
    /at most 4 keyframes; got 5/
  );
  await assertRejectedBeforeGrok(sandbox, run("--keyframe", "a.png@6"), /strictly inside the 6s clip/);
  // The tool snaps keyframes to a 1/3 s grid: 5.9 s becomes 6 s, the clip's end.
  await assertRejectedBeforeGrok(sandbox, run("--keyframe", "a.png@5.9"), /snaps to 6s on reference_to_video's 1\/3-second grid/);
  await assertRejectedBeforeGrok(sandbox, run("--keyframe", "a.png@0.1"), /snaps to 0s on reference_to_video's 1\/3-second grid/);
  await assertRejectedBeforeGrok(sandbox, run("--voice", "Bob Smith!"), /--voice expects a voice id such as eve or ara/);
  await assertRejectedBeforeGrok(sandbox, run("--keyframe", "a.png@2", "--keyframe", "a.png@2.2"), /closer than 1\/3 s apart/);
  await assertRejectedBeforeGrok(sandbox, run("--keyframe", "a.png"), /PATH@SECONDS/);
  await assertRejectedBeforeGrok(sandbox, run("--image", "missing.png"), /Image not found/);
});

/** Leave a session behind in which Grok offered the older reference_to_video: up to 7 images, no pinned frames. */
function offerOldReferenceSchema(sandbox) {
  addSession(sandbox, { tools: ["reference_to_video"], parameters: { reference_to_video: OLD_REFERENCE_TO_VIDEO } });
}

test("ref-video allows only 7 reference images when the installed Grok offers the older schema", async (t) => {
  const sandbox = createSandbox(t);
  offerOldReferenceSchema(sandbox);
  sourceImage(sandbox, "a.png");

  await assertRejectedBeforeGrok(sandbox, ["ref-video", PROMPT, ...repeat("--image", "a.png", 8)], /at most 7 reference images; got 8/);
  await generate(sandbox, ["ref-video", PROMPT, ...repeat("--image", "a.png", 7)], REFERENCE_CALL);
  assert.equal(toolArguments(sandbox).images.length, 7);
});

test("ref-video refuses pinned frames when the installed Grok offers the older schema", async (t) => {
  const sandbox = createSandbox(t);
  offerOldReferenceSchema(sandbox);
  sourceImage(sandbox, "a.png");

  for (const args of [["--first-frame", "a.png"], ["--last-frame", "a.png"], ["--keyframe", "a.png@2"]]) {
    await assertRejectedBeforeGrok(sandbox, ["ref-video", PROMPT, ...args], /older reference_to_video: no first\/last frame or keyframes/);
  }
});

test("ref-video --loop pins its one --image as both the first and the last frame", async (t) => {
  const sandbox = createSandbox(t);
  const shore = sourceImage(sandbox, "shore.png");

  await generate(sandbox, ["ref-video", "waves roll onto the sand", "--image", "shore.png", "--loop"], REFERENCE_CALL);

  const args = toolArguments(sandbox);
  assert.equal(args.first_frame, shore);
  assert.equal(args.last_frame, shore);
  assert.equal(args.images, undefined);
  assert.ok(lastPromptLines(sandbox).includes("waves roll onto the sand. Locked camera, seamless loop."));
});

test("ref-video --loop needs exactly one --image and no other end frame", async (t) => {
  const sandbox = createSandbox(t);
  sourceImage(sandbox, "a.png");
  const loop = (...args) => ["ref-video", "waves roll", "--loop", ...args];

  await assertRejectedBeforeGrok(sandbox, loop(), /--loop takes exactly one --image/);
  await assertRejectedBeforeGrok(sandbox, loop("--image", "a.png", "--image", "a.png"), /--loop takes exactly one --image/);
  await assertRejectedBeforeGrok(sandbox, loop("--image", "a.png", "--first-frame", "a.png"), /--loop sets both the first and the last frame/);
  await assertRejectedBeforeGrok(sandbox, loop("--image", "a.png", "--last-frame", "a.png"), /--loop sets both the first and the last frame/);

  offerOldReferenceSchema(sandbox);
  await assertRejectedBeforeGrok(sandbox, loop("--image", "a.png"), /older reference_to_video: no first\/last frame or keyframes/);
});

test("ref-video's own options are refused elsewhere rather than silently ignored", async (t) => {
  const sandbox = createSandbox(t);
  sourceImage(sandbox, "a.png");
  const elsewhere = {
    image: ["image", "a red kite"],
    animate: ["animate", "drift", "--image", "a.png"],
    video: ["video", "a kite at dusk"]
  };
  const options = [["--loop"], ["--voice", "eve"], ["--keyframe", "a.png@2"], ["--first-frame", "a.png"], ["--last-frame", "a.png"]];

  for (const [command, args] of Object.entries(elsewhere)) {
    for (const option of options) {
      await assertRejectedBeforeGrok(sandbox, [...args, ...option], new RegExp(`${option[0]} does not apply to ${command}; it is for ref-video\\.`));
    }
  }
});

test("every ref-video file input takes @last and job:<id>[#N]", async (t) => {
  const sandbox = createSandbox(t);
  const saved = (file) => path.join(sandbox.workspace, "grok-media", file);
  await generate(sandbox, ["image", "a red kite", "--job", "kite"], [{ tool: "image_gen" }]);
  await generate(sandbox, ["image", "two boats", "--count", "2", "--job", "boats"], [{ tool: "image_gen" }, { tool: "image_gen" }]);

  await generate(
    sandbox,
    ["ref-video", PROMPT, "--image", "@last", "--first-frame", "job:kite", "--last-frame", "job:boats#1", "--keyframe", "@last@2"],
    REFERENCE_CALL
  );

  const args = toolArguments(sandbox);
  assert.deepEqual(args.images, [saved("two-boats-2.jpg")]);
  assert.equal(args.first_frame, saved("a-red-kite-1.jpg"));
  assert.equal(args.last_frame, saved("two-boats-1.jpg"));
  assert.deepEqual(args.keyframes, [{ image: saved("two-boats-2.jpg"), timestamp_s: 2 }]);
});

// Voice ids are not validated locally: xAI's public docs show the roster only
// as an example, so an unknown id goes to Grok, whose error names the voices.
test("an unknown voice is relayed with the voice list reference_to_video answers with", async (t) => {
  const sandbox = createSandbox(t);
  const error = "Unknown voice 'bob'. Available voices: ara, eve, leo, rex, sal";

  const { stdout } = await generate(
    sandbox,
    ["ref-video", "<AUDIO_0> says hello", "--voice", "bob"],
    [{ tool: "reference_to_video", error }],
    { expectCode: 2 }
  );

  assert.deepEqual(toolArguments(sandbox).voices, ["bob"]);
  assert.ok(stdout.includes(error), stdout);
});

test("ref-video sends keyframes in time order, which is how their <IMAGE_i> tags count", async (t) => {
  const sandbox = createSandbox(t);
  const early = sourceImage(sandbox, "early.png");
  const late = sourceImage(sandbox, "late.png");

  await generate(sandbox, ["ref-video", PROMPT, "--keyframe", "late.png@4", "--keyframe", "early.png@2"], REFERENCE_CALL);

  assert.deepEqual(toolArguments(sandbox).keyframes, [
    { image: early, timestamp_s: 2 },
    { image: late, timestamp_s: 4 }
  ]);
});

test("ref-video --loop adds its direction cleanly after a prompt that ends in a quote", async (t) => {
  const sandbox = createSandbox(t);
  sourceImage(sandbox, "shore.png");

  await generate(sandbox, ["ref-video", "the sign reads 'Open.'", "--image", "shore.png", "--loop"], REFERENCE_CALL);

  assert.ok(lastPromptLines(sandbox).includes("the sign reads 'Open.' Locked camera, seamless loop."));
});
