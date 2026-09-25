/**
 * What a release ships: one version across the plugin, the marketplace and the
 * package, links to this fork rather than the original repository, and a
 * CHANGELOG section for that version.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { PLUGIN_ROOT } from "./helpers.mjs";

const REPO_ROOT = path.resolve(PLUGIN_ROOT, "..", "..");
const FORK = "madebysandro/grok-plugin-cc";

const PLUGIN_MANIFEST = "plugins/grok/.claude-plugin/plugin.json";
const MARKETPLACE = ".claude-plugin/marketplace.json";
const PACKAGE = "package.json";
const CHANGELOG = "plugins/grok/CHANGELOG.md";

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

  assert.deepEqual(
    { [`${MARKETPLACE} metadata`]: marketplace.metadata.version, [`${MARKETPLACE} plugin entry`]: listed.version, [PACKAGE]: pkg.version },
    { [`${MARKETPLACE} metadata`]: plugin.version, [`${MARKETPLACE} plugin entry`]: plugin.version, [PACKAGE]: plugin.version },
    `every manifest should carry ${PLUGIN_MANIFEST}'s version, ${plugin.version}`
  );
});

test("the plugin and the package link to this fork", () => {
  assert.equal(plugin.homepage, `https://github.com/${FORK}`, `${PLUGIN_MANIFEST}: homepage should be the fork`);
  assert.equal(pkg.repository.url, `git+https://github.com/${FORK}.git`, `${PACKAGE}: repository should be the fork`);
});

test("the README installs the plugin from this marketplace, in Claude Code and in Codex", () => {
  const selector = `${plugin.name}@${marketplace.name}`;
  const installs = [...readRepoFile("README.md").matchAll(/^(?:\/plugin install|codex plugin add) (\S+)$/gm)];

  assert.equal(installs.length, 2, "README.md: expected one `/plugin install` and one `codex plugin add` line");
  for (const [line, installed] of installs) {
    assert.equal(installed, selector, `README.md: "${line}" should install ${selector}`);
  }
});

test("the CHANGELOG's newest release is the version the manifests carry", () => {
  // An "Unreleased" section on top is work in progress, not a release.
  const newest = /^## (?!Unreleased\b)(\S+)/m.exec(readRepoFile(CHANGELOG))?.[1];
  assert.equal(newest, plugin.version, `${CHANGELOG}: the newest release should be "## ${plugin.version}", not "## ${newest}"`);
});
