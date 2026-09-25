/**
 * The companion's own usage text, as `/grok:*` users and Claude read it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createSandbox } from "./companion-harness.mjs";

async function help(t) {
  const { code, stdout } = await createSandbox(t).run(["help"]);
  assert.equal(code, 0);
  return stdout;
}

test("help keeps data: URLs to the image inputs of the Grok commands", async (t) => {
  const text = await help(t);

  // The sentence may wrap, so read the paragraph that mentions data: URLs as one line.
  const paragraph = text.split("\n\n").find((block) => block.includes("data: URL"));
  assert.ok(paragraph, text);
  const sentence = paragraph.replace(/\s+/g, " ");
  assert.match(sentence, /The image inputs of edit, animate and ref-video also take a data: URL/);
  assert.match(sentence, /overlay's --image and the other local tools' files do not/);
});

test("help describes status as every recent job, not only background ones", async (t) => {
  const text = await help(t);

  const line = text.split("\n").find((each) => /^\s+status\s/.test(each));
  assert.match(line, /List recent jobs of every kind in this workspace/);
});

/** An option's entry under "Common options": its line and the indented lines that continue it. */
function optionEntry(text, option) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`  ${option} `));
  assert.notEqual(start, -1, `help has no ${option} entry`);
  const rest = lines.slice(start + 1);
  // Continuation lines are indented deeper than the two spaces an entry starts with.
  const end = rest.findIndex((line) => !/^ {3,}\S/.test(line));
  return [lines[start], ...rest.slice(0, end === -1 ? undefined : end)].join(" ").replace(/\s+/g, " ");
}

test("help says ask brings --timeout into range while the others refuse it", async (t) => {
  const text = await help(t);

  assert.match(optionEntry(text, "--timeout SECS"), /30-3600; ask brings a value outside that into range, the other Grok commands refuse it/);
});
