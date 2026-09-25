import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { LIB, cleanup, makeTempDir } from "./helpers.mjs";

const { findJob, generateJobId, listJobs, reconcileJobStatus, resolveDataDir, resolveStateDir, resolveWorkspaceRoot, upsertJob } =
  await import(path.join(LIB, "state.mjs"));

/** Point plugin state at a scratch directory for the duration of `run`. */
function withStateDir(run) {
  const dataDir = makeTempDir("grok-plugin-state-");
  const workspace = makeTempDir("grok-plugin-ws-");
  const previous = process.env.GROK_PLUGIN_DATA;
  process.env.GROK_PLUGIN_DATA = dataDir;
  try {
    return run(workspace);
  } finally {
    if (previous === undefined) {
      delete process.env.GROK_PLUGIN_DATA;
    } else {
      process.env.GROK_PLUGIN_DATA = previous;
    }
    cleanup(dataDir);
    cleanup(workspace);
  }
}

test("job ids are unique", () => {
  const ids = new Set(Array.from({ length: 50 }, () => generateJobId("image")));
  assert.equal(ids.size, 50);
  assert.ok([...ids].every((id) => id.startsWith("image-")));
});

test("state lives outside the workspace", () => {
  withStateDir((workspace) => {
    const stateDir = resolveStateDir(workspace);
    assert.ok(stateDir.startsWith(process.env.GROK_PLUGIN_DATA));
    assert.ok(!stateDir.startsWith(workspace));
  });
});

test("the data folder is GROK_PLUGIN_DATA, else the plugin's own CLAUDE_PLUGIN_DATA, else the one Claude Code keeps for it", () => {
  const installed = "/Users/me/.claude/plugins/cache/madebysandro-grok/grok/3.0.0/scripts/lib/state.mjs";
  const checkout = "/Users/me/src/grok-plugin-cc/plugins/grok/scripts/lib/state.mjs";
  const codex = "/Users/me/.claude/plugins/data/codex-openai-codex";
  const own = "/Users/me/.claude/plugins/data/grok-madebysandro-grok";

  assert.equal(resolveDataDir({ env: { GROK_PLUGIN_DATA: "/data/grok", CLAUDE_PLUGIN_DATA: own }, moduleFile: installed }), "/data/grok");
  assert.equal(resolveDataDir({ env: { CLAUDE_PLUGIN_DATA: own }, moduleFile: checkout }), own);
  // Another plugin's folder, exported into the session by its hook, is never used.
  assert.equal(resolveDataDir({ env: { CLAUDE_PLUGIN_DATA: codex }, moduleFile: installed }), own);
  assert.equal(resolveDataDir({ env: { CLAUDE_PLUGIN_DATA: codex }, moduleFile: checkout }), null);
  assert.equal(resolveDataDir({ env: {}, moduleFile: installed }), own);
  assert.equal(resolveDataDir({ env: {}, moduleFile: "/Users/me/.claude/plugins/cache/other-market/other/1.0.0/lib/state.mjs" }), null);
});

test("workspace root walks up to the git root", () => {
  withStateDir((workspace) => {
    fs.mkdirSync(path.join(workspace, ".git"));
    const nested = path.join(workspace, "a", "b");
    fs.mkdirSync(nested, { recursive: true });

    assert.equal(resolveWorkspaceRoot(nested), workspace);
  });
});

test("a git-less directory is its own workspace root", () => {
  withStateDir((workspace) => {
    const nested = path.join(workspace, "solo");
    fs.mkdirSync(nested);
    assert.equal(resolveWorkspaceRoot(nested), nested);
  });
});

test("jobs are inserted newest-first and merged on update", () => {
  withStateDir((workspace) => {
    upsertJob(workspace, { id: "job-1", command: "image", status: "running", prompt: "one" });
    upsertJob(workspace, { id: "job-2", command: "video", status: "running", prompt: "two" });
    upsertJob(workspace, { id: "job-1", status: "completed", assetCount: 2 });

    const jobs = listJobs(workspace);
    assert.equal(jobs.length, 2);

    const job = findJob(workspace, "job-1");
    assert.equal(job.status, "completed");
    assert.equal(job.assetCount, 2);
    // The merge must not lose fields set on insert.
    assert.equal(job.prompt, "one");
    assert.equal(job.command, "image");
  });
});

test("findJob with no id returns the most recent job", () => {
  withStateDir((workspace) => {
    upsertJob(workspace, { id: "job-1", command: "image", status: "completed" });
    upsertJob(workspace, { id: "job-2", command: "image", status: "completed" });

    assert.equal(findJob(workspace, null).id, "job-2");
    assert.equal(findJob(workspace, "nope"), null);
  });
});

test("a running job whose process is gone is reported as interrupted", () => {
  const alive = reconcileJobStatus({ id: "a", status: "running", pid: process.pid });
  assert.equal(alive.status, "running");

  // PID 1 exists but is not ours; an unused high PID reliably does not.
  const dead = reconcileJobStatus({ id: "b", status: "running", pid: 2 ** 22 });
  assert.equal(dead.status, "interrupted");

  const finished = reconcileJobStatus({ id: "c", status: "completed", pid: 2 ** 22 });
  assert.equal(finished.status, "completed");
});

test("missing state reads as an empty job list", () => {
  withStateDir((workspace) => {
    assert.deepEqual(listJobs(workspace), []);
    assert.equal(findJob(workspace, null), null);
  });
});
