import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { LIB } from "./helpers.mjs";

const { buildAnimatePrompt, buildAskPrompt, buildEditPrompt, buildImagePrompt, buildVideoPrompt } = await import(
  path.join(LIB, "prompts.mjs")
);

const PROMPT = "a brass telescope on a wooden desk";

test("image prompt passes the user's text through verbatim", () => {
  const built = buildImagePrompt({ prompt: PROMPT, aspect: "16:9", count: 1 });

  assert.ok(built.includes(PROMPT));
  assert.match(built, /exactly as written/);
  assert.match(built, /aspect_ratio: 16:9/);
  assert.match(built, /Call `image_gen` exactly 1 time\./);
});

test("image prompt asks for variation when several are requested", () => {
  const built = buildImagePrompt({ prompt: PROMPT, count: 3 });

  assert.match(built, /Call `image_gen` exactly 3 times\./);
  assert.match(built, /Vary composition/);
});

test("verbatim can be turned off to let Grok rewrite", () => {
  const built = buildImagePrompt({ prompt: PROMPT, count: 1, verbatim: false });

  assert.doesNotMatch(built, /exactly as written/);
  assert.ok(built.includes(PROMPT));
});

test("every media prompt forbids copying, re-reading, and shell use", () => {
  const built = [
    buildImagePrompt({ prompt: PROMPT, count: 1 }),
    buildEditPrompt({ prompt: PROMPT, images: ["/tmp/a.png"], count: 1 }),
    buildVideoPrompt({ prompt: PROMPT }),
    buildAnimatePrompt({ prompt: PROMPT, image: "/tmp/a.png" })
  ];

  for (const text of built) {
    assert.match(text, /Do NOT copy, move, rename/);
    assert.match(text, /Do NOT read the generated files back/);
    assert.match(text, /Do NOT run shell commands/);
  }
});

test("edit prompt lists every source image and stays an edit", () => {
  const built = buildEditPrompt({ prompt: "make it blue", images: ["/tmp/a.png", "/tmp/b.png"], count: 1 });

  assert.ok(built.includes("/tmp/a.png"));
  assert.ok(built.includes("/tmp/b.png"));
  assert.match(built, /Do not call `image_gen`/);
});

test("video prompt drives the two-step image_gen -> image_to_video path", () => {
  // Grok CLI 1.0 has no text-to-video tool, so naming one just sends the agent
  // hunting through MCP discovery.
  const built = buildVideoPrompt({ prompt: PROMPT, aspect: "16:9", duration: 6 });

  assert.match(built, /call `image_gen` once/);
  assert.match(built, /call `image_to_video` once/);
  assert.match(built, /There is no `video_gen` tool/);
  assert.match(built, /duration: 6 seconds/);
});

test("animate prompt animates the supplied still and makes no new one", () => {
  const built = buildAnimatePrompt({ prompt: "slow push-in", image: "/tmp/a.png" });

  assert.ok(built.includes("/tmp/a.png"));
  assert.match(built, /Call `image_to_video` exactly once\./);
  assert.match(built, /Do not generate a new still image/);
});

test("ask passes the prompt through untouched unless read-only is requested", () => {
  assert.equal(buildAskPrompt({ prompt: PROMPT, readOnly: false }), PROMPT);

  const readOnly = buildAskPrompt({ prompt: PROMPT, readOnly: true });
  assert.ok(readOnly.startsWith(PROMPT));
  assert.match(readOnly, /read-only task/);
});
