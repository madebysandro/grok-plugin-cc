#!/usr/bin/env node
/**
 * grok-companion — the runtime behind every `/grok:*` slash command.
 *
 * It drives the Grok CLI headlessly, harvests whatever media the run produced
 * from Grok's own session log, and copies it into the user's workspace.
 *
 * Usage: node grok-companion.mjs <command> [options]
 */

import fs from "node:fs";
import path from "node:path";

import { parseArgs, parseCount, splitArgumentString } from "./lib/args.mjs";
import {
  findGrokBinary,
  getGrokVersion,
  isZeroDataRetentionVideoError,
  readGrokAuth,
  runGrokHeadless
} from "./lib/grok.mjs";
import { MEDIA_TOOL_ALLOWLIST, WORKER_ENV_VAR, buildGrokInvocation } from "./lib/invocation.mjs";
import {
  extractAgentMessage,
  extractMediaCalls,
  listSessionMediaFiles,
  readSessionUpdates,
  resolveSessionDir
} from "./lib/session.mjs";
import { collectAssets, resolveInputImage, resolveOutDir, slugify, writeManifest } from "./lib/assets.mjs";
import {
  findJob,
  generateJobId,
  listJobs,
  reconcileJobStatus,
  resolveJobLogFile,
  upsertJob
} from "./lib/state.mjs";
import { indent, renderJobList, renderMediaFailure, renderMediaResult, truncate } from "./lib/render.mjs";
import {
  buildAnimatePrompt,
  buildAskPrompt,
  buildEditPrompt,
  buildImagePrompt,
  buildVideoPrompt
} from "./lib/prompts.mjs";

const COMMANDS = new Set(["setup", "image", "edit", "video", "animate", "ask", "status", "result", "cancel", "help"]);
const MEDIA_COMMANDS = new Set(Object.keys(MEDIA_TOOL_ALLOWLIST));

const SHARED_VALUE_OPTIONS = ["out", "aspect", "count", "name", "model", "effort", "timeout", "duration", "job"];
const SHARED_BOOLEAN_OPTIONS = ["json", "verbatim", "raw", "keep-session", "read-only", "write"];

const ZDR_HINT = [
  "Cause: this xAI account has Zero Data Retention enabled",
  "(`coding_data_retention_opt_out: true` in ~/.grok/auth.json).",
  "xAI rejects video generation for ZDR accounts unless the caller supplies an",
  "`output.upload_url`, and the Grok CLI does not expose that parameter.",
  "",
  "Fix: turn data retention back on for this account/team in the xAI console,",
  "then re-run. Image generation and editing are unaffected and keep working."
].join("\n");

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function emit({ json, payload, text }) {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${text}\n`);
}

/**
 * Slash commands hand us `$ARGUMENTS` as one shell-quoted string; a direct
 * invocation hands us a normal argv. Flatten both into tokens.
 */
function normaliseArgv(argv) {
  if (argv.length === 1 && /\s/.test(argv[0]) && /(^|\s)--/.test(argv[0])) {
    return splitArgumentString(argv[0]);
  }
  return argv.flatMap((token) =>
    typeof token === "string" && /\s/.test(token) && /(^|\s)--/.test(token) ? splitArgumentString(token) : [token]
  );
}

function requireGrok() {
  const binary = findGrokBinary();
  if (!binary) {
    fail(
      [
        "Grok CLI not found.",
        "",
        "Install it from https://x.ai/build, then run `grok login`.",
        "If it is installed somewhere unusual, set GROK_BIN to its full path.",
        "",
        "Run `/grok:setup` for a full readiness check."
      ].join("\n")
    );
  }
  return binary;
}

/** Shared driver for the four media commands. */
async function runMediaCommand({ command, options, positionals, cwd, promptBuilder, title, defaultOutDir, extra = {} }) {
  const binary = requireGrok();
  const json = Boolean(options.json);

  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    fail(`No prompt given. Usage: /grok:${command} <prompt> [--out DIR] [--aspect 16:9]`);
  }

  const outDir = resolveOutDir(options.out, cwd, defaultOutDir);
  const count = parseCount(options.count, { fallback: 1, min: 1, max: 8 });
  const timeoutMs = parseCount(options.timeout, { fallback: extra.defaultTimeoutSeconds ?? 900, min: 30, max: 3600 }) * 1000;

  const grokPrompt = promptBuilder({
    prompt,
    aspect: options.aspect ?? null,
    duration: options.duration ?? null,
    count,
    verbatim: options.verbatim !== false,
    ...extra.promptExtras
  });

  const jobId = options.job || generateJobId(command);
  const logFile = resolveJobLogFile(cwd, jobId);
  fs.writeFileSync(logFile, "", "utf8");

  upsertJob(cwd, {
    id: jobId,
    command,
    status: "running",
    prompt: truncate(prompt, 300),
    outDir,
    pid: process.pid,
    logFile
  });

  const startedAt = Date.now();

  const run = await runGrokHeadless({
    binary,
    ...buildGrokInvocation(command, {
      prompt: grokPrompt,
      cwd,
      model: options.model,
      effort: options.effort,
      maxTurns: extra.maxTurns ?? 8
    }),
    timeoutMs,
    onStderr: (chunk) => {
      try {
        fs.appendFileSync(logFile, chunk);
      } catch {
        // logging is best-effort
      }
    }
  });

  const elapsedMs = Date.now() - startedAt;
  const sessionId = run.sessionId;

  // Harvest from the session log regardless of exit code — a run can produce
  // valid assets and still exit non-zero (timeout, max-turns, late failure).
  const sessionDir = sessionId ? resolveSessionDir(sessionId, cwd) : null;
  const updates = sessionDir ? readSessionUpdates(sessionDir) : [];
  const calls = extractMediaCalls(updates);
  const agentMessage = extractAgentMessage(updates) || run.envelope?.text || "";

  const { saved, missing } = collectAssets({
    calls,
    outDir,
    baseName: options.name ? slugify(options.name) : slugify(prompt)
  });

  const failedCalls = calls.filter((call) => call.status === "failed" && call.error);
  const costUsd = Number(run.envelope?.total_cost_usd);

  // `video`/`animate` must actually yield a video. Without this check a run
  // whose animation step failed would still report success on the intermediate
  // still frame, which is exactly the wrong answer.
  const requiredTypes = extra.requiredOutputTypes ?? null;
  const producedRequired =
    !requiredTypes || saved.some((asset) => requiredTypes.includes(asset.outputType));

  if (saved.length > 0 && producedRequired) {
    writeManifest({
      outDir,
      entries: saved,
      meta: { command, requestedPrompt: prompt, sessionId, aspect: options.aspect ?? null, costUsd: Number.isFinite(costUsd) ? costUsd : null }
    });

    upsertJob(cwd, { id: jobId, status: "completed", assetCount: saved.length, sessionId, files: saved.map((asset) => asset.file) });

    const notes = [];
    if (missing.length > 0) {
      notes.push(`Note: ${missing.length} generated file(s) were reported by Grok but no longer exist on disk.`);
    }
    if (failedCalls.length > 0) {
      notes.push(`Note: ${failedCalls.length} tool call(s) failed; the files above are the ones that succeeded.`);
    }

    emit({
      json,
      payload: { ok: true, command, outDir, sessionId, elapsedMs, costUsd: Number.isFinite(costUsd) ? costUsd : null, assets: saved, failedCalls, missing },
      text: renderMediaResult({ title, saved, outDir, elapsedMs, costUsd, sessionId, notes })
    });
    return;
  }

  // The run did not deliver what was asked for — work out why, and say so precisely.
  const errorText = [run.stderr, agentMessage, ...failedCalls.map((call) => call.error)].filter(Boolean).join("\n");
  const zdrBlocked = isZeroDataRetentionVideoError(errorText);

  let reason;
  if (run.timedOut) {
    reason = `The Grok run exceeded the ${Math.round(timeoutMs / 1000)}s timeout. Re-run with --timeout <seconds> to allow longer.`;
  } else if (zdrBlocked) {
    reason = "xAI rejected the video request.";
  } else if (saved.length > 0 && !producedRequired) {
    reason = "The still frame was generated, but the animation step produced no video.";
  } else if (failedCalls.length > 0) {
    reason = "Grok called the generation tool, but it returned an error.";
  } else if (calls.length === 0) {
    reason = "Grok never called a media generation tool.";
  } else {
    reason = "The generation tool ran but reported no output file.";
  }

  let hint = null;
  if (zdrBlocked) {
    hint = ZDR_HINT;
  } else if (calls.length === 0 && !run.ok) {
    hint = run.stderr ? `Grok CLI stderr:\n${indent(truncate(run.stderr, 600))}` : "Run `/grok:setup` to check the CLI is installed and logged in.";
  }

  // Last-resort sweep: the log may be missing while the files are on disk.
  if (sessionDir && calls.length === 0) {
    const orphans = listSessionMediaFiles(sessionDir);
    if (orphans.length > 0) {
      hint = `${hint ? `${hint}\n\n` : ""}Grok's session folder does contain ${orphans.length} media file(s):\n${indent(orphans.join("\n"))}`;
    }
  }

  // Anything that did land is still worth keeping and reporting.
  if (saved.length > 0) {
    writeManifest({
      outDir,
      entries: saved,
      meta: { command, requestedPrompt: prompt, sessionId, partial: true, costUsd: Number.isFinite(costUsd) ? costUsd : null }
    });
  }

  upsertJob(cwd, {
    id: jobId,
    status: saved.length > 0 ? "partial" : "failed",
    assetCount: saved.length,
    sessionId,
    reason,
    files: saved.map((asset) => asset.file)
  });

  const text = renderMediaFailure({ title, reason, hint, agentMessage, sessionId, failedCalls, partialAssets: saved, outDir });
  if (json) {
    emit({
      json,
      payload: { ok: false, command, reason, hint, sessionId, elapsedMs, failedCalls, agentMessage, zeroDataRetentionBlocked: zdrBlocked, partialAssets: saved, outDir },
      text
    });
  } else {
    process.stdout.write(`${text}\n`);
  }
  process.exit(2);
}

async function commandSetup({ options }) {
  const json = Boolean(options.json);
  const binary = findGrokBinary();
  const version = binary ? await getGrokVersion(binary) : null;
  const auth = binary ? readGrokAuth() : { authenticated: false, reason: "grok-not-installed" };

  const videoBlocked = Boolean(auth.authenticated && auth.dataRetentionOptOut);

  const checks = [
    { name: "Grok CLI installed", ok: Boolean(binary), detail: binary ?? "not found on PATH, ~/.grok/bin, or $GROK_BIN" },
    { name: "Grok CLI runs", ok: Boolean(version), detail: version ?? "could not execute `grok --version`" },
    { name: "Signed in", ok: Boolean(auth.authenticated), detail: auth.authenticated ? (auth.email ?? "authenticated") : "run `grok login`" },
    { name: "Image generation", ok: Boolean(binary && auth.authenticated), detail: binary && auth.authenticated ? "available" : "needs an installed, signed-in CLI" },
    {
      name: "Video generation",
      ok: Boolean(binary && auth.authenticated && !videoBlocked),
      detail: videoBlocked ? "blocked by Zero Data Retention on this account" : binary && auth.authenticated ? "available" : "needs an installed, signed-in CLI"
    }
  ];

  const ready = checks.every((check) => check.ok);

  const lines = ["Grok plugin readiness", ""];
  for (const check of checks) {
    lines.push(`  ${check.ok ? "ok  " : "FAIL"}  ${check.name}: ${check.detail}`);
  }
  lines.push("");

  if (!binary) {
    lines.push("Install the Grok CLI from https://x.ai/build, then run `grok login`.");
  } else if (!auth.authenticated) {
    lines.push("Run `!grok login` to sign in.");
  } else if (videoBlocked) {
    lines.push("Images and image editing are ready to use.");
    lines.push("");
    lines.push("Video generation will fail on this account:");
    lines.push(indent(ZDR_HINT));
  } else {
    lines.push("Everything is ready. Try `/grok:image a neon-lit rooftop at dusk`.");
  }

  emit({
    json,
    payload: {
      ready,
      binary,
      version,
      authenticated: Boolean(auth.authenticated),
      email: auth.email ?? null,
      teamId: auth.teamId ?? null,
      zeroDataRetention: Boolean(auth.dataRetentionOptOut),
      videoAvailable: Boolean(binary && auth.authenticated && !videoBlocked),
      checks
    },
    text: lines.join("\n")
  });
}

async function commandAsk({ options, positionals, cwd }) {
  const binary = requireGrok();
  const json = Boolean(options.json);

  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    fail("No prompt given. Usage: /grok:ask <prompt> [--write] [--model M]");
  }

  // Read-only unless the caller explicitly opts into writes.
  const readOnly = options.write !== true;
  const timeoutMs = parseCount(options.timeout, { fallback: 900, min: 30, max: 3600 }) * 1000;

  const jobId = generateJobId("ask");
  upsertJob(cwd, { id: jobId, command: "ask", status: "running", prompt: truncate(prompt, 300), pid: process.pid });

  const startedAt = Date.now();
  const run = await runGrokHeadless({
    binary,
    ...buildGrokInvocation("ask", {
      prompt: buildAskPrompt({ prompt, readOnly }),
      cwd,
      model: options.model,
      effort: options.effort,
      readOnly
    }),
    timeoutMs
  });

  const elapsedMs = Date.now() - startedAt;
  const text = run.envelope?.text ?? "";
  const costUsd = Number(run.envelope?.total_cost_usd);

  if (!run.ok && !text) {
    upsertJob(cwd, { id: jobId, status: "failed", sessionId: run.sessionId });
    const message = run.timedOut
      ? `Grok exceeded the ${Math.round(timeoutMs / 1000)}s timeout.`
      : `Grok exited with code ${run.code}.\n${truncate(run.stderr, 800)}`;
    if (json) {
      emit({ json, payload: { ok: false, reason: message, sessionId: run.sessionId }, text: message });
    } else {
      process.stdout.write(`${message}\n`);
    }
    process.exit(2);
  }

  upsertJob(cwd, { id: jobId, status: "completed", sessionId: run.sessionId });

  emit({
    json,
    payload: { ok: true, text, sessionId: run.sessionId, elapsedMs, costUsd: Number.isFinite(costUsd) ? costUsd : null, readOnly },
    text
  });
}

function commandStatus({ options, cwd }) {
  const jobs = listJobs(cwd).map(reconcileJobStatus);
  emit({ json: Boolean(options.json), payload: { jobs }, text: renderJobList(jobs) });
}

function commandResult({ options, positionals, cwd }) {
  const jobId = options.job ?? positionals[0] ?? null;
  const job = reconcileJobStatus(findJob(cwd, jobId));

  if (!job) {
    const message = jobId ? `No Grok job found with id ${jobId}.` : "No Grok jobs recorded for this workspace yet.";
    emit({ json: Boolean(options.json), payload: { ok: false, reason: message }, text: message });
    return;
  }

  const lines = [`Job ${job.id} [${job.command}] — ${job.status}`, ""];
  if (job.prompt) {
    lines.push(`Prompt: ${job.prompt}`, "");
  }
  if (job.outDir) {
    lines.push(`Output directory: ${job.outDir}`);
  }

  const existing = (job.files ?? []).filter((file) => fs.existsSync(file));
  if (existing.length > 0) {
    lines.push("", "Files:");
    for (const file of existing) {
      lines.push(`  ${file}`);
    }
  }

  const removed = (job.files ?? []).length - existing.length;
  if (removed > 0) {
    lines.push("", `${removed} file(s) recorded for this job no longer exist on disk.`);
  }

  if (job.reason) {
    lines.push("", job.reason);
  }
  if (job.status === "running" && job.logFile && fs.existsSync(job.logFile)) {
    const tail = fs.readFileSync(job.logFile, "utf8").split("\n").slice(-12).join("\n").trim();
    if (tail) {
      lines.push("", "Recent output:", indent(tail));
    }
  }

  emit({ json: Boolean(options.json), payload: { ok: true, job, files: existing }, text: lines.join("\n") });
}

function commandCancel({ options, positionals, cwd }) {
  const jobId = options.job ?? positionals[0] ?? null;
  const job = reconcileJobStatus(findJob(cwd, jobId));

  if (!job) {
    const message = jobId ? `No Grok job found with id ${jobId}.` : "No Grok jobs recorded for this workspace yet.";
    emit({ json: Boolean(options.json), payload: { ok: false, reason: message }, text: message });
    return;
  }

  if (job.status !== "running") {
    const message = `Job ${job.id} is not running (status: ${job.status}). Nothing to cancel.`;
    emit({ json: Boolean(options.json), payload: { ok: false, reason: message, job }, text: message });
    return;
  }

  let killed = false;
  if (job.pid) {
    try {
      process.kill(job.pid, "SIGTERM");
      killed = true;
    } catch {
      killed = false;
    }
  }

  upsertJob(cwd, { id: job.id, status: killed ? "cancelled" : "interrupted" });

  const message = killed
    ? `Cancelled job ${job.id}.`
    : `Job ${job.id} was already gone; marked as interrupted.`;
  emit({ json: Boolean(options.json), payload: { ok: killed, job: { ...job, status: killed ? "cancelled" : "interrupted" } }, text: message });
}

function commandHelp() {
  process.stdout.write(
    [
      "grok-companion — drive the Grok CLI from Claude Code / Codex",
      "",
      "Commands:",
      "  setup                       Check the Grok CLI is installed, signed in, and what it can generate",
      "  image   <prompt>            Generate image(s) with image_gen",
      "  edit    <prompt> --image P  Edit an existing image with image_edit",
      "  video   <prompt>            Generate a video (image_gen, then image_to_video)",
      "  animate <prompt> --image P  Animate a still with image_to_video",
      "  ask     <prompt>            Delegate a general task to Grok",
      "  status                      List background jobs for this workspace",
      "  result  [job-id]            Show a job's output files",
      "  cancel  [job-id]            Cancel a running job",
      "",
      "Common options:",
      "  --out DIR        Output directory (default: grok-media/)",
      "  --aspect RATIO   1:1, 16:9, 9:16, 4:3, 3:4",
      "  --count N        Number of images (1-8)",
      "  --name SLUG      Filename stem",
      "  --model M        Grok model id",
      "  --effort LEVEL   low | medium | high",
      "  --timeout SECS   Run timeout",
      "  --json           Machine-readable output",
      "  --verbatim=false Let Grok rewrite the prompt instead of passing it through"
    ].join("\n") + "\n"
  );
}

async function main() {
  const argv = normaliseArgv(process.argv.slice(2));
  const command = argv[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    commandHelp();
    return;
  }

  if (!COMMANDS.has(command)) {
    fail(`Unknown command: ${command}\nRun with no arguments for usage.`);
  }

  // Recursion guard: this process was started by a Grok run the plugin itself
  // launched. Going on would start yet another Grok run and spend quota again.
  if (MEDIA_COMMANDS.has(command) && process.env[WORKER_ENV_VAR]) {
    fail(
      [
        `Refusing to run \`${command}\` inside a Grok run started by this plugin (${WORKER_ENV_VAR} is set).`,
        "Grok calling back into the plugin would start another Grok run and spend quota again.",
        "Run the command from Claude Code or a normal shell instead."
      ].join("\n")
    );
  }

  const { options, positionals } = parseArgs(argv.slice(1), {
    valueOptions: SHARED_VALUE_OPTIONS,
    booleanOptions: SHARED_BOOLEAN_OPTIONS,
    repeatOptions: ["image"],
    aliases: { o: "out", n: "count", m: "model" }
  });

  const cwd = process.env.CLAUDE_PROJECT_DIR ? path.resolve(process.env.CLAUDE_PROJECT_DIR) : process.cwd();

  switch (command) {
    case "setup":
      await commandSetup({ options, cwd });
      return;

    case "image":
      await runMediaCommand({
        command: "image",
        options,
        positionals,
        cwd,
        promptBuilder: buildImagePrompt,
        title: "Generated",
        defaultOutDir: "grok-media",
        extra: { maxTurns: 6, defaultTimeoutSeconds: 600 }
      });
      return;

    case "edit": {
      const rawImages = options.image ? (Array.isArray(options.image) ? options.image : [options.image]) : [];
      if (rawImages.length === 0) {
        fail("No source image given. Usage: /grok:edit <instruction> --image path/to/image.png");
      }
      let images;
      try {
        images = rawImages.map((image) => resolveInputImage(image, cwd));
      } catch (error) {
        fail(String(error?.message ?? error));
      }
      await runMediaCommand({
        command: "edit",
        options,
        positionals,
        cwd,
        promptBuilder: buildEditPrompt,
        title: "Edited",
        defaultOutDir: "grok-media",
        extra: { maxTurns: 6, defaultTimeoutSeconds: 600, promptExtras: { images } }
      });
      return;
    }

    case "video":
      await runMediaCommand({
        command: "video",
        options,
        positionals,
        cwd,
        promptBuilder: buildVideoPrompt,
        title: "Generated video",
        defaultOutDir: "grok-media",
        // Two tool calls plus wrap-up; the still keyframe is harvested too.
        extra: {
          maxTurns: 8,
          defaultTimeoutSeconds: 1200,
          requiredOutputTypes: ["ImageToVideo", "ReferenceToVideo", "VideoGen"]
        }
      });
      return;

    case "animate": {
      const rawImage = Array.isArray(options.image) ? options.image[0] : options.image;
      if (!rawImage) {
        fail("No source image given. Usage: /grok:animate <motion> --image path/to/image.png");
      }
      let image;
      try {
        image = resolveInputImage(rawImage, cwd);
      } catch (error) {
        fail(String(error?.message ?? error));
      }
      await runMediaCommand({
        command: "animate",
        options,
        positionals,
        cwd,
        promptBuilder: buildAnimatePrompt,
        title: "Animated",
        defaultOutDir: "grok-media",
        extra: {
          maxTurns: 5,
          defaultTimeoutSeconds: 1200,
          promptExtras: { image },
          requiredOutputTypes: ["ImageToVideo", "ReferenceToVideo", "VideoGen"]
        }
      });
      return;
    }

    case "ask":
      await commandAsk({ options, positionals, cwd });
      return;

    case "status":
      commandStatus({ options, cwd });
      return;

    case "result":
      commandResult({ options, positionals, cwd });
      return;

    case "cancel":
      commandCancel({ options, positionals, cwd });
      return;

    default:
      commandHelp();
  }
}

main().catch((error) => {
  fail(`grok-companion failed: ${error?.stack ?? error}`);
});
