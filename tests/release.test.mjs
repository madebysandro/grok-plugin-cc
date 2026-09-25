/**
 * What a release ships: one version across the plugin, the marketplace and the
 * package, links to this fork rather than the original repository, README
 * install lines that add this fork's marketplace and install from it, and a
 * CHANGELOG section for that version.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { REPO_ROOT } from "./helpers.mjs";

const FORK = "madebysandro/grok-plugin-cc";

const PLUGIN_MANIFEST = "plugins/grok/.claude-plugin/plugin.json";
const MARKETPLACE = ".claude-plugin/marketplace.json";
const PACKAGE = "package.json";
const CHANGELOG = "plugins/grok/CHANGELOG.md";
const README = "README.md";

/** A file by its path from the repository root, which is also how failure messages name it. */
function readRepoFile(file) {
  return fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
}

const plugin = JSON.parse(readRepoFile(PLUGIN_MANIFEST));
const marketplace = JSON.parse(readRepoFile(MARKETPLACE));
const pkg = JSON.parse(readRepoFile(PACKAGE));

test("the plugin, the marketplace and the package carry one version", () => {
  const listed = marketplace.plugins.find((entry) => entry.name === plugin.name);
  assert.ok(listed, `${MARKETPLACE}: no entry for the "${plugin.name}" plugin`);

  const versions = {
    [`${MARKETPLACE} metadata`]: marketplace.metadata.version,
    [`${MARKETPLACE} plugin entry`]: listed.version,
    [PACKAGE]: pkg.version
  };
  const expected = Object.fromEntries(Object.keys(versions).map((where) => [where, plugin.version]));
  assert.deepEqual(versions, expected, `every manifest should carry ${PLUGIN_MANIFEST}'s version, ${plugin.version}`);
});

test("the plugin and the package link to this fork", () => {
  assert.equal(plugin.homepage, `https://github.com/${FORK}`, `${PLUGIN_MANIFEST}: homepage should be the fork`);
  assert.equal(pkg.repository.url, `git+https://github.com/${FORK}.git`, `${PACKAGE}: repository should be the fork`);
});

test("the README adds this fork's marketplace and installs the plugin from it, in Claude Code and in Codex", () => {
  const readme = readRepoFile(README);
  const expected = [
    [/^\/plugin marketplace add (\S+)$/gm, FORK],
    [/^\/plugin install (\S+)$/gm, `${plugin.name}@${marketplace.name}`],
    [/^codex plugin marketplace add (\S+)$/gm, `https://github.com/${FORK}`],
    [/^codex plugin add (\S+)$/gm, `${plugin.name}@${marketplace.name}`]
  ];

  for (const [pattern, argument] of expected) {
    const lines = [...readme.matchAll(pattern)];
    assert.equal(lines.length, 1, `${README}: expected exactly one line matching ${pattern}, found ${lines.length}`);
    assert.equal(lines[0][1], argument, `${README}: "${lines[0][0]}" should end in ${argument}`);
  }
});

test("the CHANGELOG's newest release is the version the manifests carry", () => {
  // An "Unreleased" section on top is work in progress, not a release.
  const newest = /^## (?!Unreleased\b)(\S+)/m.exec(readRepoFile(CHANGELOG))?.[1];
  assert.equal(newest, plugin.version, `${CHANGELOG}: the newest release should be "## ${plugin.version}", not "## ${newest}"`);
});
