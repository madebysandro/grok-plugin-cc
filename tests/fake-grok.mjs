/**
 * A stand-in for the `grok` binary, for black-box tests of the companion.
 *
 * Invoked as `fake-grok.mjs <control-dir> <grok args...>` by the wrapper that
 * `companion-harness.mjs` installs as GROK_BIN. Each run appends the args, env
 * and cwd it received to `<control-dir>/calls.jsonl`, then acts out
 * `<control-dir>/scenario.json`:
 *
 *   { calls: [{ tool, prompt?, aspectRatio?, content?, error? }] }
 *
 * A call with `error` fails the way Grok logs a failed tool call. `--version`
 * just prints a version and records no session, like the real CLI.
 *
 * Every call is written into the session folder the way Grok does it — media
 * file plus `updates.jsonl` entries — and the JSON envelope goes to stdout.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { agentMessage, failedMediaCallUpdates, mediaCallUpdates, sessionDirFor, writeSession } from "./helpers.mjs";

/** How Grok CLI 1.0 names and files each media tool's output. */
const LAYOUTS = {
  image_gen: { variant: "ImageGen", folder: "images", extension: ".jpg" },
  image_edit: { variant: "ImageEdit", folder: "images", extension: ".jpg" },
  image_to_video: { variant: "ImageToVideo", folder: "videos", extension: ".mp4" },
  reference_to_video: { variant: "ReferenceToVideo", folder: "videos", extension: ".mp4" }
};

/** Set by the `/bin/sh` wrapper itself, so not part of what the companion sent. */
const WRAPPER_ENV = ["PWD", "OLDPWD", "SHLVL", "_"];

const [controlDir, ...args] = process.argv.slice(2);

const receivedEnv = { ...process.env };
for (const key of WRAPPER_ENV) {
  delete receivedEnv[key];
}
fs.appendFileSync(
  path.join(controlDir, "calls.jsonl"),
  `${JSON.stringify({ args, env: receivedEnv, cwd: process.cwd() })}\n`
);

function fail(message, code) {
  process.stderr.write(`fake grok: ${message}\n`);
  process.exit(code);
}

// Like the real CLI: print the version and stop, no session.
if (args[0] === "--version") {
  process.stdout.write("grok 1.0.41 (fake)\n");
  process.exit(0);
}

const grokHome = process.env.GROK_HOME;
if (!grokHome) {
  // Never fall back to ~/.grok: a test must not touch the real Grok folder.
  fail("GROK_HOME is not set", 90);
}

const scenarioFile = path.join(controlDir, "scenario.json");
const scenario = fs.existsSync(scenarioFile) ? JSON.parse(fs.readFileSync(scenarioFile, "utf8")) : {};

function flagValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const sessionId = flagValue("--session-id") ?? randomUUID();
const workspace = flagValue("--cwd") ?? process.cwd();
const sessionDir = sessionDirFor(grokHome, sessionId, workspace);

const updates = [];
for (const [index, call] of (scenario.calls ?? []).entries()) {
  const layout = LAYOUTS[call.tool];
  if (!layout) {
    fail(`unknown tool in scenario: ${call.tool} (expected one of ${Object.keys(LAYOUTS).join(", ")})`, 91);
  }
  const toolCall = { toolCallId: `call-${index + 1}`, tool: call.tool, variant: layout.variant, prompt: call.prompt ?? "fake prompt" };

  if (call.error) {
    updates.push(...failedMediaCallUpdates({ ...toolCall, message: call.error }));
    continue;
  }

  const filePath = path.join(sessionDir, layout.folder, `${index + 1}${layout.extension}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, call.content ?? `fake ${call.tool} output`);
  updates.push(...mediaCallUpdates({ ...toolCall, aspectRatio: call.aspectRatio, filePath }));
}
updates.push(agentMessage("DONE"));

writeSession(grokHome, sessionId, updates, { cwd: workspace });

process.stdout.write(`${JSON.stringify({ text: "DONE", sessionId, total_cost_usd: 0.01 })}\n`);
