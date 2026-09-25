/**
 * Per-workspace job bookkeeping, so `/grok:status` and `/grok:result` can
 * report on runs launched as background tasks in an earlier turn.
 *
 * State lives outside the repository, in the plugin's own data folder
 * (`resolveDataDir`), otherwise a temp directory keyed by workspace.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The plugin's name: Claude Code names its data folder `<plugin>-<marketplace>`. */
const PLUGIN_NAME = "grok";
/** Points the plugin's data somewhere else. */
export const DATA_DIR_ENV = "GROK_PLUGIN_DATA";

const STATE_VERSION = 1;
const STATE_FILE = "state.json";
const JOBS_DIR = "jobs";
const NOTICES_DIR = "notices";
const MAX_JOBS = 40;

/** Walk up to the nearest git root so sibling subdirectories share one job list. */
export function resolveWorkspaceRoot(cwd) {
  let current = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(cwd);
    }
    current = parent;
  }
}

export function resolveStateDir(cwd) {
  const root = resolveWorkspaceRoot(cwd);

  let canonical = root;
  try {
    canonical = fs.realpathSync.native(root);
  } catch {
    canonical = root;
  }

  const slug =
    (path.basename(root) || "workspace").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);

  const dataDir = resolveDataDir();
  const base = dataDir ? path.join(dataDir, "state") : path.join(os.tmpdir(), "grok-companion");

  return path.join(base, `${slug}-${hash}`);
}

/**
 * The folder the plugin keeps its data in, or null for a temp directory:
 *
 *  1. `GROK_PLUGIN_DATA`, when set.
 *  2. `CLAUDE_PLUGIN_DATA`, when it is this plugin's own. Another plugin can
 *     export its own into every command of a session — the Codex plugin's
 *     SessionStart hook does — and its `state/` has this plugin's layout, so
 *     sharing it would put both plugins' jobs in one `state.json`, and this
 *     plugin rewriting that file would drop the other's settings. A data
 *     folder named for another plugin is ignored.
 *  3. The data folder Claude Code keeps for this plugin, found from where it
 *     is installed: `<config>/plugins/cache/<marketplace>/<plugin>/<version>/`
 *     goes with `<config>/plugins/data/<plugin>-<marketplace>`.
 */
export function resolveDataDir({ env = process.env, moduleFile = fileURLToPath(import.meta.url) } = {}) {
  if (env[DATA_DIR_ENV]) {
    return env[DATA_DIR_ENV];
  }
  const host = env.CLAUDE_PLUGIN_DATA;
  if (host && path.basename(host).startsWith(`${PLUGIN_NAME}-`)) {
    return host;
  }
  return installedDataDir(moduleFile);
}

/** `<config>/plugins/data/grok-<marketplace>` for a copy installed in Claude Code's plugin cache, else null. */
function installedDataDir(moduleFile) {
  const parts = moduleFile.split(path.sep);
  const cache = parts.lastIndexOf("cache");
  if (cache < 1 || parts[cache - 1] !== "plugins" || parts.length < cache + 4) {
    return null;
  }
  const [marketplace, plugin] = parts.slice(cache + 1, cache + 3);
  if (plugin !== PLUGIN_NAME || !marketplace) {
    return null;
  }
  return path.join(parts.slice(0, cache).join(path.sep) || path.sep, "data", `${plugin}-${marketplace}`);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR);
}

export function ensureStateDir(cwd) {
  const dir = resolveJobsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function defaultState() {
  return { version: STATE_VERSION, jobs: [] };
}

export function loadState(cwd) {
  const file = path.join(resolveStateDir(cwd), STATE_FILE);
  if (!fs.existsSync(file)) {
    return defaultState();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return { version: STATE_VERSION, jobs: Array.isArray(parsed?.jobs) ? parsed.jobs : [] };
  } catch {
    return defaultState();
  }
}

export function saveState(cwd, state) {
  ensureStateDir(cwd);

  const jobs = [...(state.jobs ?? [])]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);

  const retained = new Set(jobs.map((job) => job.id));
  for (const job of loadState(cwd).jobs) {
    if (retained.has(job.id)) {
      continue;
    }
    // Drop the evicted job's log so the state directory cannot grow forever.
    removeIfExists(job.logFile);
  }

  const next = { version: STATE_VERSION, jobs };
  fs.writeFileSync(path.join(resolveStateDir(cwd), STATE_FILE), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function removeIfExists(file) {
  if (!file) {
    return;
  }
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // best effort
  }
}

export function generateJobId(prefix = "grok") {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

/** Insert or merge a job record, stamping `updatedAt`. */
export function upsertJob(cwd, patch) {
  const state = loadState(cwd);
  const timestamp = new Date().toISOString();
  const index = state.jobs.findIndex((job) => job.id === patch.id);

  if (index === -1) {
    state.jobs.unshift({ createdAt: timestamp, updatedAt: timestamp, ...patch });
  } else {
    state.jobs[index] = { ...state.jobs[index], ...patch, updatedAt: timestamp };
  }

  return saveState(cwd, state);
}

/**
 * Record that the one-time notice `name` has been shown in this workspace.
 * Returns false when it already had been, so the caller stays quiet.
 *
 * Each notice is a marker file created exclusively, so of several runs in
 * parallel exactly one wins.
 */
export function claimNotice(cwd, name) {
  const dir = path.join(resolveStateDir(cwd), NOTICES_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, createHash("sha256").update(name).digest("hex").slice(0, 32));
  try {
    fs.writeFileSync(marker, `${name}\n${new Date().toISOString()}\n`, { flag: "wx" });
    return true;
  } catch (error) {
    if (error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function findJob(cwd, jobId) {
  const jobs = listJobs(cwd);
  if (!jobId) {
    return jobs[0] ?? null;
  }
  return jobs.find((job) => job.id === jobId) ?? null;
}

export function resolveJobLogFile(cwd, jobId) {
  return path.join(ensureStateDir(cwd), `${jobId}.log`);
}

/**
 * A job is only "running" if its process is actually alive; a killed terminal
 * would otherwise leave records stuck at `running` for ever.
 */
export function reconcileJobStatus(job) {
  if (!job || job.status !== "running" || !job.pid) {
    return job;
  }
  try {
    process.kill(job.pid, 0);
    return job;
  } catch {
    return { ...job, status: "interrupted" };
  }
}
