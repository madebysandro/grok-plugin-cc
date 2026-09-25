/**
 * Discovery and headless invocation of the Grok CLI (`grok`).
 *
 * Everything the plugin does funnels through `runGrokHeadless`, which runs the
 * `grok -p ... --output-format json` command line built by `invocation.mjs`
 * and returns the parsed envelope.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const GROK_HOME = process.env.GROK_HOME || path.join(os.homedir(), ".grok");

/** Fallback install locations, checked in order when `grok` is not on PATH. */
const FALLBACK_BINARIES = [
  path.join(GROK_HOME, "bin", "grok"),
  "/usr/local/bin/grok",
  "/opt/homebrew/bin/grok"
];

/**
 * Media tool ids, mapped to the `rawOutput.type` value the session log records
 * (which is what `session.mjs` matches on).
 *
 * Grok CLI 1.0 exposes four of these. `video_gen` appears in the binary's tool
 * table but is NOT offered to the agent — asking for it by name just sends the
 * model hunting through MCP discovery. Text-to-video therefore runs as
 * `image_gen` followed by `image_to_video`. The entry is kept so that a future
 * CLI that does expose it is harvested correctly.
 */
export const MEDIA_TOOLS = Object.freeze({
  image_gen: "ImageGen",
  image_edit: "ImageEdit",
  image_to_video: "ImageToVideo",
  reference_to_video: "ReferenceToVideo",
  video_gen: "VideoGen"
});

/** The media tools actually callable in Grok CLI 1.0. */
export const AVAILABLE_MEDIA_TOOLS = Object.freeze([
  "image_gen",
  "image_edit",
  "image_to_video",
  "reference_to_video"
]);

function isExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Resolve the `grok` binary, honouring `GROK_BIN` first. */
export function findGrokBinary() {
  const override = process.env.GROK_BIN;
  if (override) {
    return isExecutable(override) ? override : null;
  }

  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, "grok");
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  for (const candidate of FALLBACK_BINARIES) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
}

function runCapture(binary, args, { timeoutMs = 20_000, cwd, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: String(error?.message ?? error), timedOut: false });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || String(error?.message ?? error), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * `grok --version` output, or null when the binary will not run.
 *
 * Grok checks for updates on launch; GROK_DISABLE_AUTOUPDATER keeps this a
 * purely local call (a piped stderr already suppresses the check too).
 */
export async function getGrokVersion(binary) {
  const result = await runCapture(binary, ["--version"], {
    timeoutMs: 15_000,
    env: { ...process.env, GROK_DISABLE_AUTOUPDATER: "1" }
  });
  if (result.code !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

/**
 * Read `~/.grok/auth.json` for account state.
 *
 * Credentials are never returned — only the fields the plugin needs to explain
 * what will and will not work. `dataRetentionOptOut` is the important one: xAI
 * rejects video generation for Zero Data Retention accounts.
 */
export function readGrokAuth() {
  const authFile = path.join(GROK_HOME, "auth.json");
  if (!fs.existsSync(authFile)) {
    return { authenticated: false, reason: "no-auth-file", authFile };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(authFile, "utf8"));
  } catch {
    return { authenticated: false, reason: "unreadable-auth-file", authFile };
  }

  const records = Object.values(parsed ?? {}).filter((entry) => entry && typeof entry === "object");
  if (records.length === 0) {
    return { authenticated: false, reason: "empty-auth-file", authFile };
  }

  // Most recent credential wins when several issuers are cached.
  const record = records.sort((left, right) =>
    String(right.create_time ?? "").localeCompare(String(left.create_time ?? ""))
  )[0];

  const expiresAt = record.expires_at ?? null;
  const expired = expiresAt ? Date.parse(expiresAt) < Date.now() : false;

  return {
    authenticated: true,
    authFile,
    email: record.email ?? null,
    teamId: record.team_id ?? null,
    authMode: record.auth_mode ?? null,
    expiresAt,
    // `true` means the account opted OUT of retention, i.e. Zero Data Retention.
    dataRetentionOptOut: record.coding_data_retention_opt_out === true,
    // An expired access token is not a problem: the CLI refreshes on demand.
    accessTokenExpired: expired
  };
}

/**
 * The only settings-cache fields the plugin reads, and the names it reports
 * them under. Everything else in the cache is dropped unread.
 */
const PLAN_FIELDS = Object.freeze({
  subscription_tier_display: "tier",
  image_gen_enabled: "imageGenEnabled",
  video_gen_enabled: "videoGenEnabled",
  imagine_tools_disabled: "imagineToolsDisabled"
});

/** The settings cache wraps a signed `payload`: JSON text, or base64 of it. */
function decodeSettingsPayload(payload) {
  for (const decode of [(text) => text, (text) => Buffer.from(text, "base64").toString("utf8")]) {
    try {
      const parsed = JSON.parse(decode(String(payload)));
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // try the next encoding
    }
  }
  return null;
}

/** First value of each wanted key, wherever it sits in the payload. */
function collectPlanFields(value, plan, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const field = PLAN_FIELDS[key];
    if (field && plan[field] === undefined && (typeof child === "string" || typeof child === "boolean")) {
      plan[field] = child;
    } else {
      collectPlanFields(child, plan, depth + 1);
    }
  }
}

/**
 * Plan and media switches from `~/.grok/settings_cache.json`.
 *
 * Returns `{ tier, imageGenEnabled, videoGenEnabled, imagineToolsDisabled }`
 * (null for a field that is absent), or null when the cache is missing,
 * unreadable or holds none of them. Nothing else from the cache is returned,
 * logged or stored.
 */
export function readGrokPlan() {
  let cache;
  try {
    cache = JSON.parse(fs.readFileSync(path.join(GROK_HOME, "settings_cache.json"), "utf8"));
  } catch {
    return null;
  }

  const found = {};
  collectPlanFields(decodeSettingsPayload(cache?.payload), found);
  if (Object.keys(found).length === 0) {
    return null;
  }
  return Object.fromEntries(Object.values(PLAN_FIELDS).map((field) => [field, found[field] ?? null]));
}

/**
 * xAI rejects video generation on Zero Data Retention accounts with this error.
 * Detecting it lets the plugin explain the real cause instead of surfacing a
 * bare HTTP 400.
 */
export function isZeroDataRetentionVideoError(text) {
  if (!text) {
    return false;
  }
  return /Zero Data Retention.*upload_url|upload_url.*Zero Data Retention/is.test(String(text));
}

/**
 * Run a single headless Grok turn, as built by `buildGrokInvocation`
 * (see `invocation.mjs`).
 *
 * Resolves with `{ ok, envelope, sessionId, stdout, stderr, code, timedOut }`.
 * A non-zero exit is reported, never thrown, so callers can render a useful
 * message alongside whatever the session log already captured.
 */
export function runGrokHeadless(options) {
  const { binary, args, env = process.env, cwd = process.cwd(), sessionId, timeoutMs = 900_000, onStderr } = options;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({
        ok: false,
        envelope: null,
        sessionId: sessionId ?? null,
        stdout: "",
        stderr: String(error?.message ?? error),
        code: null,
        timedOut: false
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      onStderr?.(text);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        envelope: null,
        sessionId: sessionId ?? null,
        stdout,
        stderr: stderr || String(error?.message ?? error),
        code: null,
        timedOut
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const envelope = parseGrokEnvelope(stdout);
      resolve({
        ok: code === 0 && envelope !== null,
        envelope,
        sessionId: envelope?.sessionId ?? sessionId ?? null,
        stdout,
        stderr,
        code,
        timedOut
      });
    });
  });
}

/**
 * Extract the JSON result envelope from Grok's stdout.
 *
 * `--output-format json` prints one JSON object, but banners or update notices
 * can precede it, so fall back to scanning for the last top-level object.
 */
export function parseGrokEnvelope(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    // fall through to the scanning path
  }

  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    const candidate = text.slice(start);
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // keep scanning
    }
  }

  return null;
}
