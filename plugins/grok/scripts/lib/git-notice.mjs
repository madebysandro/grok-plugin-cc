/**
 * A one-time heads-up when generated media lands in a git repository that
 * does not ignore it, so it is not committed by accident.
 *
 * The plugin never edits `.gitignore`: it only says so, once per workspace
 * (remembered in the plugin's state). Outside a repository, with the folder
 * ignored, or without git installed, it says nothing.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

import { claimNotice } from "./state.mjs";

const NOTICE = "git-unignored-media";

/** `git -C dir <args>`, or null when git cannot run at all. */
function git(dir, args) {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return result.error ? null : result;
}

/**
 * The note for `files` just saved into `outDir`, or null when there is
 * nothing to say (or it has been said in this workspace already).
 */
export function gitNotice(cwd, outDir, files) {
  if (files.length === 0) {
    return null;
  }
  // Exit 0: ignored; 1: not ignored; 128: not inside a repository.
  const check = git(outDir, ["check-ignore", "-q", "--", files[0]]);
  if (check?.status !== 1) {
    return null;
  }
  const top = git(outDir, ["rev-parse", "--show-toplevel"]);
  if (top?.status !== 0 || !claimNotice(cwd, NOTICE)) {
    return null;
  }
  const root = top.stdout.trim();
  const folder = `${path.relative(root, outDir) || "."}/`;
  return (
    `Note: ${folder} is inside the git repository at ${root} and git does not ignore it, ` +
    `so the files saved there will show up in \`git status\`. To keep them out, add \`${folder}\` to .gitignore ` +
    "(the plugin never edits it). This note is shown once per workspace."
  );
}
