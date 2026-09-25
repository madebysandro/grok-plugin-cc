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
function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, "missing frontmatter");
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

function skill(name) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, "skills", name, "SKILL.md"), "utf8");
}

test("every skill names itself after its folder and says when to use it", () => {
  for (const name of SKILLS) {
    const fields = frontmatter(skill(name));
    assert.equal(fields.name, name, `skills/${name}/SKILL.md: frontmatter name should be "${name}"`);
    assert.ok(fields.description?.length > 40, `skills/${name}/SKILL.md: frontmatter description is missing or too short`);
  }
});

test("grok-generate routes to every command the plugin has", () => {
  const mentioned = commandsMentioned(skill("grok-generate"));

  const missing = COMMANDS.filter((command) => !mentioned.has(command));
  assert.deepEqual(missing, [], `skills/grok-generate/SKILL.md never mentions: ${missing.map((c) => `/grok:${c}`).join(", ")}`);
});

test("no document names a /grok: command that does not exist", () => {
  const known = new Set(COMMANDS);
  for (const [label, text] of documents()) {
    const unknown = [...commandsMentioned(text)].filter((command) => !known.has(command));
    assert.deepEqual(unknown, [], `${label} names commands that do not exist: ${unknown.map((c) => `/grok:${c}`).join(", ")}`);
  }
});

test("every example that runs a generation in the foreground gives Bash a 10-minute timeout", () => {
  const generation = new RegExp(`grok-companion\\.mjs"?\\s+(${GENERATION_COMMANDS.join("|")})\\b`);
  // What Claude runs; the README's shell examples are for people at a terminal, where no Bash-tool timeout applies.
  for (const [label, text] of documents().filter(([label]) => label !== "README.md")) {
    for (const [, block] of text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
      if (!generation.test(block) || /run_in_background:\s*true/.test(block)) {
        continue;
      }
      assert.match(
        block,
        /timeout:\s*600000/,
        `${label}: this foreground generation example needs \`timeout: 600000\` (the Bash default of 2 minutes cuts video short):\n${block}`
      );
    }
  }
});

test("grok-generate only answers an explicit request for Grok", () => {
  const { description } = frontmatter(skill("grok-generate"));

  assert.match(description, /Grok/);
  assert.match(description, /explicitly/i, "the description must say it is only for requests that name Grok");
  assert.match(description, /not for/i, "the description must say which requests it is not for");
});
