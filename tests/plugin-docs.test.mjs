/**
 * Consistency checks on what Claude reads: the skills, the grok-media agent,
 * the slash-command files and the README. They catch a router that forgets a
 * command, a document naming a command that does not exist, and a generation
 * example that would run into the Bash tool's 2-minute default timeout.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { PLUGIN_ROOT } from "./helpers.mjs";

const REPO_ROOT = path.resolve(PLUGIN_ROOT, "..", "..");
const GENERATION_COMMANDS = ["image", "edit", "animate", "video", "ref-video"];

const COMMANDS = fs
  .readdirSync(path.join(PLUGIN_ROOT, "commands"))
  .filter((file) => file.endsWith(".md"))
  .map((file) => file.slice(0, -".md".length));

const SKILLS = fs.readdirSync(path.join(PLUGIN_ROOT, "skills")).filter((name) => fs.existsSync(path.join(PLUGIN_ROOT, "skills", name, "SKILL.md")));

/** Every document Claude reads, as `[label, text]`. The CHANGELOG and docs/ are history, and left out. */
function documents() {
  return [
    ...SKILLS.map((name) => [`skills/${name}/SKILL.md`, fs.readFileSync(path.join(PLUGIN_ROOT, "skills", name, "SKILL.md"), "utf8")]),
    ...fs
      .readdirSync(path.join(PLUGIN_ROOT, "agents"))
      .filter((file) => file.endsWith(".md"))
      .map((file) => [`agents/${file}`, fs.readFileSync(path.join(PLUGIN_ROOT, "agents", file), "utf8")]),
    ...COMMANDS.map((name) => [`commands/${name}.md`, fs.readFileSync(path.join(PLUGIN_ROOT, "commands", `${name}.md`), "utf8")]),
    ["README.md", fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8")]
  ];
}

/** The `/grok:<command>` names a text mentions (a `/grok:*` wildcard is not a name). */
function commandsMentioned(text) {
  return new Set([...text.matchAll(/\/grok:([a-z][a-z-]*)/g)].map((match) => match[1]));
}

/** YAML-ish frontmatter: the `key: value` lines between the opening `---` pair. */
function frontmatter(text, label) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text.replaceAll("\r\n", "\n"));
  assert.ok(match, `${label}: missing the --- frontmatter block at the top`);
  const fields = {};
  let key = null;
  for (const line of match[1].split("\n")) {
    const field = /^([a-z-]+):\s?(.*)$/.exec(line);
    if (field) {
      [, key] = field;
      fields[key] = field[2].trim();
    } else if (key) {
      fields[key] = `${fields[key]} ${line.trim()}`.trim();
    }
  }
  return fields;
}

function skillText(name) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, "skills", name, "SKILL.md"), "utf8");
}

test("every skill names itself after its folder and says when to use it", () => {
  for (const name of SKILLS) {
    const fields = frontmatter(skillText(name), `skills/${name}/SKILL.md`);
    assert.equal(fields.name, name, `skills/${name}/SKILL.md: frontmatter name should be "${name}"`);
    assert.ok(fields.description?.length > 40, `skills/${name}/SKILL.md: frontmatter description is missing or too short`);
  }
});

test("grok-generate's routing table covers every command the plugin has", () => {
  const text = skillText("grok-generate");
  const start = text.indexOf("## Intent → command");
  assert.notEqual(start, -1, "skills/grok-generate/SKILL.md: the \"## Intent → command\" section is missing");
  const end = text.indexOf("\n## ", start + 1);
  const mentioned = commandsMentioned(text.slice(start, end === -1 ? undefined : end));

  const missing = COMMANDS.filter((command) => !mentioned.has(command));
  assert.deepEqual(missing, [], `skills/grok-generate/SKILL.md: its "Intent → command" section never routes to ${missing.map((c) => `/grok:${c}`).join(", ")}`);
});

test("no document names a /grok: command that does not exist", () => {
  const known = new Set(COMMANDS);
  for (const [label, text] of documents()) {
    const unknown = [...commandsMentioned(text)].filter((command) => !known.has(command));
    assert.deepEqual(unknown, [], `${label} names commands that do not exist: ${unknown.map((c) => `/grok:${c}`).join(", ")}`);
  }
});

test("every example that runs a generation in the foreground gives Bash a 10-minute timeout", () => {
  const generationCall = new RegExp(`grok-companion\\.mjs"?\\s+(${GENERATION_COMMANDS.join("|")})\\b`, "g");
  // What Claude runs; the README's shell examples are for people at a terminal, where no Bash-tool timeout applies.
  for (const [label, text] of documents().filter(([label]) => label !== "README.md")) {
    for (const call of text.matchAll(generationCall)) {
      // The Bash({ … }) call this command line belongs to; a bare shell example has none, and would run with the default timeout.
      const open = text.lastIndexOf("Bash(", call.index);
      const close = text.indexOf("})", call.index);
      const bash = open === -1 || close === -1 || text.lastIndexOf("})", call.index) > open ? "" : text.slice(open, close);
      const line = text.slice(text.lastIndexOf("\n", call.index) + 1, text.indexOf("\n", call.index));
      if (/run_in_background:\s*true/.test(bash)) {
        continue;
      }
      assert.match(
        bash,
        /timeout:\s*600000/,
        `${label}: a foreground generation must be a Bash({ … }) call with \`timeout: 600000\` (the default of 2 minutes cuts video short):\n${line}`
      );
    }
  }
});

test("grok-generate only answers an explicit request for Grok", () => {
  const { description } = frontmatter(skillText("grok-generate"), "skills/grok-generate/SKILL.md");

  // A wording check: it cannot prove how the description triggers, only that it states the rule.
  assert.match(description, /explicitly/i, "skills/grok-generate/SKILL.md: the description must say it is only for requests that explicitly name Grok");
  assert.match(description, /not for/i, "skills/grok-generate/SKILL.md: the description must say which requests it is not for (generic ones)");
});

/** The options specific to each generation command, which its argument-hint must show. */
const HINTED_OPTIONS = {
  image: ["--aspect", "--count", "--image-model"],
  edit: ["--image", "--aspect", "--count", "--image-model"],
  animate: ["--image", "--duration", "--resolution", "--draft"],
  video: ["--aspect", "--duration", "--resolution", "--draft", "--image-model"],
  "ref-video": ["--image", "--first-frame", "--last-frame", "--keyframe", "--voice", "--loop", "--aspect", "--duration", "--resolution", "--draft"]
};

function commandText(name) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, "commands", `${name}.md`), "utf8");
}

test("each generation command's argument-hint shows the options it takes", () => {
  for (const [command, options] of Object.entries(HINTED_OPTIONS)) {
    const hint = frontmatter(commandText(command), `commands/${command}.md`)["argument-hint"] ?? "";
    const missing = options.filter((option) => !new RegExp(`${option}(?![\\w-])`).test(hint));
    assert.deepEqual(missing, [], `commands/${command}.md: the argument-hint leaves out ${missing.join(", ")}`);
  }
});

test("no command file talks of money: a run draws on the plan's quota", () => {
  for (const name of COMMANDS) {
    const match = /\b(?:money|bill(?:ed|ing)?|paid|charged?)\b/i.exec(commandText(name));
    assert.equal(match, null, `commands/${name}.md says "${match?.[0]}"; the plugin spends the subscription's weekly quota, not money`);
  }
});

test("every command file defines @last the same way", () => {
  const definition = "the last file the plugin saved in this workspace, by a generation or a local tool";
  for (const name of COMMANDS) {
    for (const [, meaning] of commandText(name).matchAll(/`@last` \(([^)]*)\)/g)) {
      assert.ok(meaning.startsWith(definition), `commands/${name}.md defines @last as "${meaning}"; use "${definition}"`);
    }
  }
});
