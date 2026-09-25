import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createSandbox } from "./companion-harness.mjs";

/** Each media command as a user would type it, and the tools it needs. */
const MEDIA_COMMANDS = {
  image: { args: ["image", "a lighthouse at dusk"], tools: "image_gen" },
  edit: { args: ["edit", "make it night", "--image", "in.png"], tools: "image_edit" },
  animate: { args: ["animate", "waves roll in", "--image", "in.png"], tools: "image_to_video" },
  video: { args: ["video", "waves roll in"], tools: "image_gen,image_to_video" },
  "ref-video": { args: ["ref-video", "<IMAGE_0> walks in", "--image", "in.png"], tools: "reference_to_video" }
};

/** Grok's switches for loading the user's Claude and Cursor setup. */
const COMPAT_SWITCHES = [
  "GROK_CLAUDE_SKILLS_ENABLED",
  "GROK_CLAUDE_AGENTS_ENABLED",
  "GROK_CLAUDE_HOOKS_ENABLED",
  "GROK_CLAUDE_MCPS_ENABLED",
  "GROK_CLAUDE_RULES_ENABLED",
  "GROK_CURSOR_SKILLS_ENABLED",
  "GROK_CURSOR_AGENTS_ENABLED",
  "GROK_CURSOR_HOOKS_ENABLED",
  "GROK_CURSOR_MCPS_ENABLED",
  "GROK_CURSOR_RULES_ENABLED"
];

/** The compat switches as a grok run received them. */
function compatSwitchesOf(call) {
  return Object.fromEntries(COMPAT_SWITCHES.map((name) => [name, call.env[name]]));
}

/** Run one media command in a fresh sandbox. */
async function runMedia(t, command, options) {
  const sandbox = createSandbox(t);
  fs.writeFileSync(path.join(sandbox.workspace, "in.png"), "png-bytes");
  const result = await sandbox.run(MEDIA_COMMANDS[command].args, options);
  return { sandbox, result };
}

/** The value that follows `name` in a recorded grok command line. */
function flagValue(call, name) {
  const index = call.args.indexOf(name);
  return index === -1 ? undefined : call.args[index + 1];
}

test("ask keeps its full toolset and read-only denylist", async (t) => {
  const sandbox = createSandbox(t);

  await sandbox.run(["ask", "summarise the README"]);

  const [call] = sandbox.grokCalls();
  const withoutPrompt = call.args.toSpliced(call.args.indexOf("-p"), 2);
  assert.deepEqual(withoutPrompt, [
    "--always-approve",
    "--output-format",
    "json",
    "--cwd",
    sandbox.workspace,
    "--disallowed-tools",
    "write,search_replace,delete_file,edit_notebook"
  ]);
});

for (const [command, { tools }] of Object.entries(MEDIA_COMMANDS)) {
  test(`${command} lets grok use only ${tools}, with no subagents, web search or auto-update`, async (t) => {
    const { sandbox } = await runMedia(t, command);

    const [call] = sandbox.grokCalls();
    assert.equal(flagValue(call, "--tools"), tools);
    for (const flag of ["--no-subagents", "--disable-web-search", "--no-auto-update"]) {
      assert.ok(call.args.includes(flag), `missing ${flag}`);
    }
  });
}

test("media runs open a new grok session under a UUID the plugin generates", async (t) => {
  const sandbox = createSandbox(t);
  sandbox.scenario({ calls: [{ tool: "image_gen" }] });

  const first = await sandbox.run(["image", "a lighthouse at dusk", "--json"]);
  await sandbox.run(["image", "a lighthouse at dusk"]);

  const [one, two] = sandbox.grokCalls().map((call) => flagValue(call, "--session-id"));
  assert.match(one, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(one, two);
  assert.equal(JSON.parse(first.stdout).sessionId, one);
});

for (const command of Object.keys(MEDIA_COMMANDS)) {
  test(`${command} keeps the user's Claude and Cursor setup out of grok`, async (t) => {
    const { sandbox } = await runMedia(t, command);

    const [call] = sandbox.grokCalls();
    assert.deepEqual(compatSwitchesOf(call), Object.fromEntries(COMPAT_SWITCHES.map((name) => [name, "false"])));
  });

  test(`${command} marks grok as started by the plugin`, async (t) => {
    const { sandbox } = await runMedia(t, command);

    const [call] = sandbox.grokCalls();
    assert.equal(call.env.GROK_PLUGIN_CC_WORKER, "1");
  });
}

// `ask` keeps the user's full setup, but its grok has a shell: the marker is
// what stops it from starting Grok runs through the plugin again.
test("ask marks grok as started by the plugin without isolating it", async (t) => {
  const sandbox = createSandbox(t);

  await sandbox.run(["ask", "summarise the README"]);

  const [call] = sandbox.grokCalls();
  assert.equal(call.env.GROK_PLUGIN_CC_WORKER, "1");
  assert.deepEqual(compatSwitchesOf(call), Object.fromEntries(COMPAT_SWITCHES.map((name) => [name, undefined])));
});

for (const command of Object.keys(MEDIA_COMMANDS)) {
  test(`${command} refuses to run inside a grok the plugin started`, async (t) => {
    const { sandbox, result } = await runMedia(t, command, { env: { GROK_PLUGIN_CC_WORKER: "1" } });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /inside a Grok run started by this plugin/);
    assert.deepEqual(sandbox.grokCalls(), []);
    const status = await sandbox.run(["status", "--json"]);
    assert.deepEqual(JSON.parse(status.stdout).jobs, []);
  });
}

// Grok → ask → Grok could loop as well as a media command, and every run draws on the plan's pool.
test("ask refuses to run inside a grok the plugin started", async (t) => {
  const sandbox = createSandbox(t);

  const { code, stderr } = await sandbox.run(["ask", "summarise the README"], { env: { GROK_PLUGIN_CC_WORKER: "1" } });

  assert.equal(code, 1);
  assert.match(stderr, /Refusing to run `ask` inside a Grok run started by this plugin/);
  assert.deepEqual(sandbox.grokCalls(), []);
  const status = await sandbox.run(["status", "--json"]);
  assert.deepEqual(JSON.parse(status.stdout).jobs, []);
});
