/**
 * A one-time heads-up when generated media lands in a git repository that
 * does not ignore it, so it is not committed by accident.
 *
 * The plugin never edits `.gitignore`: it only says so, once per output
 * folder and workspace (remembered in the plugin's state). Outside a
 * repository, with every file ignored, or without git, it says nothing.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { claimNotice } from "./state.mjs";

/** `git -C dir <args>` (with `input` on stdin), or null when git cannot run at all. */
function git(dir, args, input) {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", input });
  return result.error ? null : result;
}

/**
 * Which of `files` git would add: neither ignored nor already tracked.
 * `check-ignore -v -n` lists every untracked path it was given, with an
 * empty source for the ones no rule matches; tracked files are left out.
 * Paths go in and come out NUL-separated (`-z` needs `--stdin`).
 */
function unignored(outDir, files) {
  const check = git(outDir, ["check-ignore", "-v", "-n", "-z", "--stdin"], files.map((file) => `${file}\0`).join(""));
  if (check?.status !== 0 && check?.status !== 1) {
    return []; // 128: not inside a repository
  }
  const fields = check.stdout.split("\0");
  const paths = [];
  for (let index = 0; index + 3 < fields.length; index += 4) {
    if (fields[index] === "") {
      paths.push(fields[index + 3]);
    }
  }
  return paths;
}

/**
 * The note for `files` just saved into `outDir` (with its manifest), as a
 * list of zero or one entry: empty when there is nothing to say, or when it
 * has been said for this folder in this workspace already.
 */
export function gitNotes(cwd, outDir, files) {
  const manifest = path.join(outDir, "grok-manifest.json");
  const candidates = [...files, ...(fs.existsSync(manifest) ? [manifest] : [])];
  if (candidates.length === 0 || unignored(outDir, candidates).length === 0) {
    return [];
  }
  // Where git itself puts the folder, whatever symlinks led to it.
  const where = git(outDir, ["rev-parse", "--show-toplevel", "--show-prefix"]);
  if (where?.status !== 0) {
    return [];
  }
  const [root, prefix = ""] = where.stdout.split("\n");
  if (!claimNotice(cwd, `git-unignored-media:${root}:${prefix}`)) {
    return [];
  }
  const keepOut = "(the plugin never edits it). This note is shown once per folder.";
  if (!prefix) {
    return [
      `Note: the files were saved at the root of the git repository at ${root}, and git does not ignore them, ` +
        `so they will show up in \`git status\`. To keep them out, add a rule for them to .gitignore ${keepOut}`
    ];
  }
  return [
    `Note: ${prefix} is inside the git repository at ${root} and git does not ignore what was saved there, ` +
      `so it will show up in \`git status\`. To keep it out, add \`${prefix}\` to .gitignore ${keepOut}`
  ];
}
