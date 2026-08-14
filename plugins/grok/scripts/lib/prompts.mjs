/**
 * Instruction wrappers sent to the Grok agent.
 *
 * Two rules drive every template here:
 *
 *  1. The user's prompt is passed through verbatim. Grok's bundled `imagine`
 *     skill otherwise rewrites it, which quietly discards art direction the
 *     caller was explicit about.
 *  2. The agent must not copy, move or re-read the generated files. The plugin
 *     harvests them from the session log instead, so an extra shell turn is
 *     pure latency and cost.
 */

const NO_HANDLING_RULES = [
  "Do NOT copy, move, rename, or re-save the generated files. Leave them where the tool puts them.",
  "Do NOT read the generated files back, and do NOT describe how they look.",
  "Do NOT run shell commands and do NOT write any files."
];

function block(lines) {
  return lines.filter(Boolean).join("\n");
}

function rulesSection(extra = []) {
  return block(["Rules:", ...[...extra, ...NO_HANDLING_RULES].map((rule) => `- ${rule}`)]);
}

function finalLine(marker = "DONE") {
  return `When every call has returned, reply with exactly: ${marker}`;
}

/** Text-to-image via `image_gen`. */
export function buildImagePrompt({ prompt, aspect, count = 1, verbatim = true }) {
  return block([
    `Use the \`image_gen\` tool to generate ${count} image${count === 1 ? "" : "s"}.`,
    "",
    verbatim
      ? "IMAGE PROMPT — pass this to `image_gen` exactly as written, do not rewrite, expand, or summarise it:"
      : "Subject to illustrate (you may refine the wording into a strong image prompt):",
    prompt,
    "",
    aspect ? `aspect_ratio: ${aspect}` : null,
    "",
    rulesSection([
      `Call \`image_gen\` exactly ${count} time${count === 1 ? "" : "s"}.`,
      count > 1
        ? "Vary composition, angle, and lighting between calls while keeping the same subject and style."
        : null,
      "Do not call any other generation tool."
    ]),
    "",
    finalLine()
  ]);
}

/** Image editing / reference-driven generation via `image_edit`. */
export function buildEditPrompt({ prompt, images, aspect, count = 1, verbatim = true }) {
  const imageList = images.map((image) => `- ${image}`).join("\n");
  return block([
    `Use the \`image_edit\` tool to produce ${count} edited image${count === 1 ? "" : "s"}.`,
    "",
    "Source image(s) — pass these as the `image` argument:",
    imageList,
    "",
    verbatim
      ? "EDIT INSTRUCTION — pass this to `image_edit` exactly as written, do not rewrite it:"
      : "Desired change (you may refine the wording):",
    prompt,
    "",
    aspect && images.length > 1 ? `aspect_ratio: ${aspect}` : null,
    "",
    rulesSection([
      `Call \`image_edit\` exactly ${count} time${count === 1 ? "" : "s"}.`,
      "Preserve everything the instruction does not ask you to change.",
      "Do not call `image_gen`; this is an edit of the supplied source image(s)."
    ]),
    "",
    finalLine()
  ]);
}

/**
 * Text-to-video, as a two-step run.
 *
 * Grok CLI 1.0 exposes no text-to-video tool — the media toolset is `image_gen`,
 * `image_edit`, `image_to_video` and `reference_to_video`. So a text prompt has
 * to become a still first, then get animated. Both artefacts are harvested, and
 * the still doubles as the clip's opening keyframe.
 */
export function buildVideoPrompt({ prompt, aspect, duration, verbatim = true }) {
  return block([
    "Produce one video in two steps.",
    "",
    "Step 1 — call `image_gen` once to create the opening frame.",
    "Step 2 — call `image_to_video` once, passing the image from step 1, to animate it.",
    "",
    verbatim
      ? "SCENE PROMPT — use this text for both calls exactly as written, do not rewrite, expand, or summarise it:"
      : "Scene to render and animate (you may refine the wording):",
    prompt,
    "",
    aspect ? `aspect_ratio: ${aspect} (use for both steps)` : null,
    duration ? `duration: ${duration} seconds` : null,
    "",
    rulesSection([
      "Call `image_gen` exactly once, then `image_to_video` exactly once.",
      "There is no `video_gen` tool. Do not search for one and do not use `use_tool`.",
      "If a tool returns an error, report the error text verbatim and stop. Do not retry and do not switch tools."
    ]),
    "",
    finalLine()
  ]);
}

/** Image-to-video via `image_to_video` (or `reference_to_video` for refs). */
export function buildAnimatePrompt({ prompt, image, aspect, duration, tool = "image_to_video", verbatim = true }) {
  return block([
    `Use the \`${tool}\` tool to animate the supplied image into one video.`,
    "",
    "Source image — pass this as the image argument:",
    image,
    "",
    verbatim
      ? "MOTION PROMPT — pass this to the tool exactly as written, do not rewrite it:"
      : "Motion to apply (you may refine the wording):",
    prompt,
    "",
    aspect ? `aspect_ratio: ${aspect}` : null,
    duration ? `duration: ${duration} seconds` : null,
    "",
    rulesSection([
      `Call \`${tool}\` exactly once.`,
      "Do not generate a new still image; animate the image given above.",
      "There is no `video_gen` tool. Do not search for one and do not use `use_tool`.",
      "If the tool returns an error, report the error text verbatim and stop. Do not retry and do not fall back to another tool."
    ]),
    "",
    finalLine()
  ]);
}

/**
 * General delegation. Unlike the media templates this keeps the agent's full
 * toolset, so the caller decides read-only versus read-write.
 */
export function buildAskPrompt({ prompt, readOnly }) {
  if (!readOnly) {
    return prompt;
  }
  return block([
    prompt,
    "",
    "Rules:",
    "- This is a read-only task.",
    "- Do not modify, create, or delete any file.",
    "- Read-only inspection commands are fine; do not write anything.",
    "- Report your findings as text."
  ]);
}
