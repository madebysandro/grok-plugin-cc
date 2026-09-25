/**
 * What a Grok CLI leaves in a session folder, for tests of the checks that
 * read those folders: `tool_definitions.json` shaped like Grok CLI 1.0.41's
 * (with synthetic text), and generated media with its log.
 */

import fs from "node:fs";
import path from "node:path";

import { mediaCallUpdates, sessionDirFor } from "./helpers.mjs";

export const MEDIA_TOOLS = ["image_gen", "image_edit", "image_to_video", "reference_to_video"];
export const FULL_TOOLSET = ["read_file", "list_dir", "grep", "run_terminal_command", ...MEDIA_TOOLS];

/** Parameter descriptions shaped like Grok CLI 1.0.41's (synthetic text). */
export const PARAMETERS = {
  search_tool: { query: "What to look for." },
  use_tool: { name: "Tool to call." },
  todo_write: { todos: "The todo list." },
  read_file: { path: "File to read." },
  list_dir: { path: "Directory to list." },
  grep: { pattern: "Pattern to search for." },
  run_terminal_command: { command: "Command to run." },
  image_gen: { prompt: "Prompt for the image.", aspect_ratio: "Aspect ratio of the image." },
  image_edit: { prompt: "Edit instruction.", image: "Source image(s).", aspect_ratio: "Aspect ratio for multi-image edits." },
  image_to_video: {
    image: "Source image to animate.",
    prompt: "Optional prompt to guide the video.",
    duration: "Duration of the video generation, either 6 or 10 seconds. Default to 6 unless the user requests longer.",
    resolution_name: "Resolution name of the video generation, either 480p or 720p. Defaults to 480p."
  },
  reference_to_video: {
    prompt: "Prompt to guide the video generation model.",
    images: "Reference images, up to 14 entries. Reference them in the prompt as <IMAGE_0>, <IMAGE_1>.",
    first_frame: "Optional image pinned as the video's exact FIRST frame.",
    last_frame: "Optional image pinned as the video's exact LAST frame.",
    keyframes: "Mid-video keyframe anchors, up to 4 entries.",
    voices: "Optional preset voices, up to 3 entries.",
    aspect_ratio: "Aspect ratio of the generated video.",
    duration: "Duration of the video in seconds, between 1 and 15. Defaults to 6.",
    resolution_name: "Resolution name of the video generation, either 480p or 720p. Defaults to 480p."
  }
};

/** `tool_definitions.json` the way Grok writes it; `parameters` replaces a tool's set. */
export function toolDefinitions(names, parameters = {}) {
  return names.map((name) => ({
    type: "function",
    function: {
      name,
      description: `The ${name} tool.`,
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(parameters[name] ?? PARAMETERS[name]).map(([property, description]) => [property, { type: "string", description }])
        )
      }
    }
  }));
}

let sessionCount = 0;

/**
 * A session folder as Grok leaves it. `minutesAgo` orders sessions, since
 * setup trusts the newest one that can tell. `media` writes a generated image
 * with its log: in Grok's format ("grok-log"), in Grok's format but naming the
 * file through a symlinked Grok home ("grok-log-via-symlink"), or in a format
 * the plugin cannot read ("unknown-log"). "grok-log-partial" writes a second
 * image the log never mentions.
 */
export function addSession(sandbox, { tools, parameters, media = null, minutesAgo = 0 }) {
  sessionCount += 1;
  const dir = sessionDirFor(sandbox.grokHome, `session-${sessionCount}`, "/fixture/workspace");
  fs.mkdirSync(dir, { recursive: true });
  if (tools) {
    fs.writeFileSync(path.join(dir, "tool_definitions.json"), JSON.stringify(toolDefinitions(tools, parameters)));
  }
  if (media) {
    const file = path.join(dir, "images", "1.jpg");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "jpeg-bytes");
    let logged = file;
    if (media === "grok-log-via-symlink") {
      const alias = path.join(path.dirname(sandbox.grokHome), "grok-home-alias");
      fs.symlinkSync(sandbox.grokHome, alias);
      logged = path.join(alias, path.relative(sandbox.grokHome, file));
    }
    const updates =
      media === "unknown-log"
        ? [{ type: "tool_result", tool: "image_gen", output: { file_path: file } }]
        : mediaCallUpdates({ toolCallId: "call-1", filePath: logged });
    fs.writeFileSync(path.join(dir, "updates.jsonl"), updates.map((entry) => JSON.stringify(entry)).join("\n"));
    if (media === "grok-log-partial") {
      fs.writeFileSync(path.join(dir, "images", "2.jpg"), "jpeg-bytes");
    }
  }
  const when = new Date(Date.now() - minutesAgo * 60_000);
  fs.utimesSync(dir, when, when);
  return dir;
}

/** reference_to_video as older Grok CLI builds offered it. */
export const OLD_REFERENCE_TO_VIDEO = {
  prompt: "Prompt to guide the video generation model.",
  images: "Reference images, up to 7 entries.",
  aspect_ratio: "Aspect ratio of the generated video.",
  duration: "Duration of the video in seconds, between 1 and 15.",
  resolution_name: "Resolution name of the video generation, either 480p or 720p."
};
