/**
 * What the plugin asks of Grok: the command line and environment of every
 * headless run.
 *
 * Media runs are locked down: only the tools their command needs, and none of
 * the user's Claude or Cursor setup. `ask` keeps Grok's full toolset, and the
 * caller decides read-only versus read-write.
 */

import { randomUUID } from "node:crypto";

import { SERVER_IMAGE_MODEL } from "./media-spec.mjs";

/** Built-in tools each media command needs; Grok is offered nothing else. */
export const MEDIA_TOOL_ALLOWLIST = Object.freeze({
  image: ["image_gen"],
  edit: ["image_edit"],
  animate: ["image_to_video"],
  video: ["image_gen", "image_to_video"],
  "ref-video": ["reference_to_video"]
});

/**
 * Tools that only slow a media run down (and cost tokens).
 *
 * `search_tool`/`use_tool` matter most: without them the agent responds to a
 * missing tool by trawling MCP discovery for several turns instead of failing
 * fast. Both the current and legacy spellings of the shell tool are listed;
 * Grok silently ignores names it does not recognise.
 */
export const MEDIA_DISALLOWED_TOOLS = [
  "run_terminal_command",
  "run_terminal_cmd",
  "write",
  "search_replace",
  "delete_file",
  "edit_notebook",
  "todo_write",
  "web_fetch",
  "web_search",
  "search_tool",
  "use_tool",
  "spawn_subagent",
  "task",
  "Agent"
];

/**
 * Grok loads the user's Claude and Cursor skills, agents, hooks, MCPs and rules
 * into every session unless these say otherwise. A media run needs none of it,
 * and loading it costs time and input tokens on every call.
 */
export const ISOLATION_ENV = Object.freeze(
  Object.fromEntries(
    ["CLAUDE", "CURSOR"].flatMap((source) =>
      ["SKILLS", "AGENTS", "HOOKS", "MCPS", "RULES"].map((kind) => [`GROK_${source}_${kind}_ENABLED`, "false"])
    )
  )
);

/**
 * Set on every Grok process the plugin starts. The companion refuses the
 * commands that start a Grok run (the media commands and `ask`) when it sees
 * it, so a Grok run can never loop back through the plugin into another
 * (quota-spending) Grok run.
 */
export const WORKER_ENV_VAR = "GROK_PLUGIN_CC_WORKER";

/** The variable that picks each image tool's model. */
const IMAGE_MODEL_ENV = Object.freeze({
  image_gen: "GROK_IMAGE_GEN_MODEL_OVERRIDE",
  image_edit: "GROK_IMAGE_EDIT_MODEL_OVERRIDE"
});

/** Removed from `ask` unless the caller opts into writes. */
const ASK_WRITE_TOOLS = ["write", "search_replace", "delete_file", "edit_notebook"];

/**
 * Build one headless run for `command` (a media command or `ask`).
 *
 * Returns `{ args, env, cwd, sessionId }`, ready for `runGrokHeadless`. Media
 * runs open a new session under a UUID generated here, so its folder is known
 * up front. `readOnly` only applies to `ask`; `imageModel` (a model id, or
 * `SERVER_IMAGE_MODEL`) only to the image tools a media command allows.
 */
export function buildGrokInvocation(command, { prompt, cwd, model, effort, maxTurns, readOnly, imageModel }) {
  const args = ["-p", prompt, "--always-approve", "--output-format", "json", "--cwd", cwd];

  if (model) {
    args.push("--model", model);
  }
  if (effort) {
    args.push("--reasoning-effort", effort);
  }
  if (Number.isFinite(maxTurns)) {
    args.push("--max-turns", String(maxTurns));
  }

  const workerEnv = { ...process.env, [WORKER_ENV_VAR]: "1" };

  if (command === "ask") {
    if (readOnly) {
      args.push("--disallowed-tools", ASK_WRITE_TOOLS.join(","));
    }
    return { args, env: workerEnv, cwd };
  }

  const tools = MEDIA_TOOL_ALLOWLIST[command];
  if (!tools) {
    throw new Error(`Unknown media command: ${command}`);
  }

  const sessionId = randomUUID();

  // The denylist still matters: `--tools` keeps Grok's always-on MCP
  // meta-tools (`search_tool`, `use_tool`), and the denylist wins over it.
  args.push(
    "--tools",
    tools.join(","),
    "--disallowed-tools",
    MEDIA_DISALLOWED_TOOLS.join(","),
    "--no-subagents",
    "--disable-web-search",
    "--no-auto-update",
    "--session-id",
    sessionId
  );
  const env = { ...workerEnv, ...ISOLATION_ENV };
  for (const variable of tools.map((tool) => IMAGE_MODEL_ENV[tool]).filter(Boolean)) {
    if (imageModel === SERVER_IMAGE_MODEL) {
      // Also drop an override inherited from the user's shell: "server" means xAI's default.
      delete env[variable];
    } else if (imageModel) {
      env[variable] = imageModel;
    }
  }
  return { args, env, cwd, sessionId };
}
