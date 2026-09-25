/**
 * Per-workspace job bookkeeping, so `/grok:status` and `/grok:result` can
 * report on runs launched as background tasks in an earlier turn.
 *
 * State lives outside the repository: under `CLAUDE_PLUGIN_DATA` when the host
 * provides it, otherwise a temp directory keyed by workspace.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_VERSION = 1;
const STATE_FILE = "state.json";
const JOBS_DIR = "jobs";
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

  const base = process.env.CLAUDE_PLUGIN_DATA
    ? path.join(process.env.CLAUDE_PLUGIN_DATA, "state")
    : path.join(os.tmpdir(), "grok-companion");

  return path.join(base, `${slug}-${hash}`);
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
  return { version: STATE_VERSION, jobs: [], notices: {} };
}

export function loadState(cwd) {
  const file = path.join(resolveStateDir(cwd), STATE_FILE);
  if (!fs.existsSync(file)) {
    return defaultState();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      version: STATE_VERSION,
      jobs: Array.isArray(parsed?.jobs) ? parsed.jobs : [],
      notices: parsed?.notices && typeof parsed.notices === "object" ? parsed.notices : {}
    };
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

  const next = { version: STATE_VERSION, jobs, notices: state.notices ?? {} };
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
 */
export function claimNotice(cwd, name) {
  const state = loadState(cwd);
  if (state.notices[name]) {
    return false;
  }
  state.notices[name] = new Date().toISOString();
  saveState(cwd, state);
  return true;
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
