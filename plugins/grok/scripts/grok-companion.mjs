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

import { parseArgs, parseCount, parseWholeNumber, splitArgumentString } from "./lib/args.mjs";
import {
  findGrokBinary,
  getGrokVersion,
  isZeroDataRetentionVideoError,
  readGrokAuth,
  readGrokPlan,
  runGrokHeadless
} from "./lib/grok.mjs";
import { MEDIA_TOOL_ALLOWLIST, WORKER_ENV_VAR, buildGrokInvocation } from "./lib/invocation.mjs";
import { checkCompatibility, referenceInputLimits } from "./lib/compat.mjs";
import { checkLatestModels } from "./lib/model-watch.mjs";
import { gitNotes } from "./lib/git-notice.mjs";
import { buildReadinessReport } from "./lib/readiness.mjs";
import {
  extractAgentMessage,
  extractMediaCalls,
  listSessionMediaFiles,
  readSessionUpdates,
  resolveSessionDir
} from "./lib/session.mjs";
import { collectAssets, resolveOutDir, slugify, writeManifest } from "./lib/assets.mjs";
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_MODEL_CHOICE,
  DEFAULT_REFERENCE_ASPECT,
  DEFAULT_VIDEO_DURATION,
  DEFAULT_VIDEO_RESOLUTION,
  DRAFT_VIDEO_RESOLUTION,
  EDIT_IMAGE_LIMIT,
  IMAGE_ASPECTS,
  IMAGE_MODEL_CHOICES,
  IMAGE_TO_VIDEO_DURATIONS,
  MediaOptionError,
  OLDER_EDIT_IMAGE_LIMIT,
  OLDER_REFERENCE_IMAGES,
  REFERENCE_LIMITS,
  REFERENCE_VIDEO_ASPECTS,
  REFERENCE_VIDEO_DURATION,
  SERVER_IMAGE_MODEL,
  VIDEO_RESOLUTIONS,
  imageModelNote,
  nearestReferenceAspect,
  optionNotApplicable,
  resolveMediaSpec,
  resolveReferenceInputs
} from "./lib/media-spec.mjs";
import { readImageSize } from "./lib/image-size.mjs";
import { MediaToolError } from "./lib/ffmpeg.mjs";
import { LOCAL_TOOLS, runLocalTool } from "./lib/local-tools.mjs";
import { prepareEditReferences } from "./lib/ref-prep.mjs";
import { resolveImageArg } from "./lib/refs.mjs";
import {
  findJob,
  generateJobId,
  listJobs,
  reconcileJobStatus,
  resolveJobLogFile,
  resolveStateDir,
  upsertJob
} from "./lib/state.mjs";
import { indent, renderJobList, renderMediaFailure, renderMediaResult, truncate } from "./lib/render.mjs";
import {
  buildAnimatePrompt,
  buildAskPrompt,
  buildEditPrompt,
  buildImagePrompt,
  buildReferenceVideoPrompt,
  buildVideoPrompt
} from "./lib/prompts.mjs";

const COMMANDS = new Set([
  "setup", "image", "edit", "video", "animate", "ref-video", "ask", "status", "result", "cancel", "help",
  ...Object.keys(LOCAL_TOOLS)
]);
const MEDIA_COMMANDS = new Set(Object.keys(MEDIA_TOOL_ALLOWLIST));
/** The commands that start a Grok run. */
const GROK_COMMANDS = new Set([...MEDIA_COMMANDS, "ask"]);

const SHARED_VALUE_OPTIONS = [
  "out", "aspect", "count", "name", "model", "effort", "timeout", "duration", "resolution", "image-model", "job",
  "first-frame", "last-frame", "mode", "anchor", "text", "sub", "brand", "position", "style",
  "key", "tolerance", "expect", "bg"
];
// `--background` is an instruction to Claude, which runs the command as a background task; it is
// consumed here so it never ends up in the prompt, and it changes nothing about the run itself.
const SHARED_BOOLEAN_OPTIONS = ["json", "verbatim", "write", "draft", "loop", "reencode", "background"];

/**
 * Flags the original plugin parsed but never acted on. Someone used to them may
 * still type them; they are refused, so they neither vanish nor slip into a
 * Grok prompt as text. The original plugin's commands other than the
 * generation ones (`KEEP_DEAD_OPTIONS`) take them as they always did, accepted
 * and inert (`ask` is read-only by default, so `--read-only` already held).
 */
const DEAD_OPTIONS = ["raw", "keep-session", "read-only"];
const KEEP_DEAD_OPTIONS = new Set(["ask", "status", "result", "cancel", "setup"]);

/**
 * The options the original plugin's `ask` took (`--background` was in its
 * argument hint). `ask` keeps taking them exactly as before, whether or not
 * they do anything for it, and refuses every option added since.
 */
const ASK_OPTIONS = new Set([
  "out", "aspect", "count", "name", "model", "effort", "timeout", "duration", "job",
  "json", "verbatim", "write", "background", ...DEAD_OPTIONS
]);

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

/** Shared driver for the media commands. */
async function runMediaCommand({ command, options, positionals, cwd, promptBuilder, title, defaultOutDir, extra = {} }) {
  const binary = requireGrok();
  const json = Boolean(options.json);

  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    fail(`No prompt given. Usage: /grok:${command} <prompt> [options]`);
  }

  // Options Grok would reject are refused here, before a job exists or quota is spent.
  let spec;
  try {
    spec = resolveMediaSpec(command, options);
  } catch (error) {
    if (!(error instanceof MediaOptionError)) {
      throw error;
    }
    fail(error.message);
  }
  let count;
  let timeoutMs;
  try {
    count = parseWholeNumber(options.count, { flag: "--count", fallback: 1, min: 1, max: 8 });
    timeoutMs =
      parseWholeNumber(options.timeout, { flag: "--timeout", fallback: extra.defaultTimeoutSeconds ?? 900, min: 30, max: 3600 }) * 1000;
  } catch (error) {
    fail(error.message);
  }

  // Input files are checked against the resolved spec (keyframes must fall
  // inside the clip) — still before any job or Grok run. They may come with
  // notes for the result, and an aspect ratio worked out from them.
  let inputs = {};
  if (extra.resolveInputs) {
    try {
      inputs = extra.resolveInputs(spec);
    } catch (error) {
      fail(String(error?.message ?? error));
    }
  }
  const { notes: inputNotes = [], ...promptInputs } = inputs;

  // Inputs Grok should get in another form (an edit's large photos), once every check has passed.
  let preparation = { promptExtras: {}, notes: [], meta: {}, cleanup: () => {} };
  if (extra.prepare) {
    preparation = await extra.prepare();
  }
  const requestNotes = [imageModelNote(spec.imageModel), ...inputNotes, ...preparation.notes].filter(Boolean);

  // What the manifest records: the settings as sent, not how the plugin chose the tool.
  const { videoTool, ...recorded } = spec;
  if (!recorded.aspect && promptInputs.aspect) {
    recorded.aspect = promptInputs.aspect;
  }
  Object.assign(recorded, preparation.meta);

  const outDir = resolveOutDir(options.out, cwd, defaultOutDir);

  const grokPrompt = promptBuilder({
    prompt,
    aspect: spec.aspect ?? null,
    duration: spec.duration ?? null,
    resolution: spec.resolution ?? null,
    count,
    verbatim: options.verbatim !== false,
    ...(videoTool ? { tool: videoTool } : {}),
    ...extra.promptExtras,
    ...preparation.promptExtras,
    ...promptInputs
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

  let run;
  try {
    run = await runGrokHeadless({
      binary,
      ...buildGrokInvocation(command, {
        prompt: grokPrompt,
        cwd,
        model: options.model,
        effort: options.effort,
        maxTurns: extra.maxTurns ?? 8,
        imageModel: spec.imageModel,
        tools: videoTool ? [videoTool] : undefined
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
  } finally {
    // Grok has read the prepared copies by now; they were only ever for this run.
    preparation.cleanup();
  }

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

  // `video`, `animate` and `ref-video` must actually yield a video. Without this
  // check a run whose animation step failed would still report success on the
  // intermediate still frame, which is exactly the wrong answer.
  const requiredTypes = extra.requiredOutputTypes ?? null;
  const producedRequired =
    !requiredTypes || saved.some((asset) => requiredTypes.includes(asset.outputType));

  if (saved.length > 0 && producedRequired) {
    writeManifest({
      outDir,
      entries: saved,
      meta: { command, requestedPrompt: prompt, sessionId, ...recorded, costUsd: Number.isFinite(costUsd) ? costUsd : null }
    });

    const notes = [...requestNotes];
    if (missing.length > 0) {
      notes.push(`Note: ${missing.length} generated file(s) were reported by Grok but no longer exist on disk.`);
    }
    if (failedCalls.length > 0) {
      notes.push(`Note: ${failedCalls.length} tool call(s) failed; the files above are the ones that succeeded.`);
    }
    notes.push(...gitNotes(cwd, outDir, saved.map((asset) => asset.file)));

    // The notes go into the job too, so /grok:result shows them after a background run.
    upsertJob(cwd, { id: jobId, status: "completed", assetCount: saved.length, sessionId, files: saved.map((asset) => asset.file), notes });

    emit({
      json,
      payload: { ok: true, command, jobId, outDir, sessionId, elapsedMs, costUsd: Number.isFinite(costUsd) ? costUsd : null, assets: saved, failedCalls, missing, notes },
      text: renderMediaResult({ title, saved, outDir, elapsedMs, costUsd, sessionId, jobId, notes })
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
      meta: { command, requestedPrompt: prompt, sessionId, ...recorded, partial: true, costUsd: Number.isFinite(costUsd) ? costUsd : null }
    });
  }

  const notes = [...requestNotes, ...gitNotes(cwd, outDir, saved.map((asset) => asset.file))];
  upsertJob(cwd, {
    id: jobId,
    status: saved.length > 0 ? "partial" : "failed",
    assetCount: saved.length,
    sessionId,
    reason,
    files: saved.map((asset) => asset.file),
    notes
  });

  const text = renderMediaFailure({ title, reason, hint, agentMessage, sessionId, failedCalls, partialAssets: saved, outDir, notes });
  if (json) {
    emit({
      json,
      payload: { ok: false, command, jobId, reason, hint, sessionId, elapsedMs, failedCalls, agentMessage, zeroDataRetentionBlocked: zdrBlocked, partialAssets: saved, outDir, notes },
      text
    });
  } else {
    process.stdout.write(`${text}\n`);
  }
  process.exit(2);
}

/**
 * `animate` through `reference_to_video` (a length `image_to_video` does not
 * take): that tool needs an aspect ratio, so take the one of its list closest
 * to the still's shape, and say so when the still has none of them.
 */
function stillAsFirstFrame(image, label) {
  const size = readImageSize(image);
  if (!size) {
    throw new Error(
      `Could not read the size of ${label}. A clip of this length is made with reference_to_video, which needs the still's ` +
        "shape to pick its aspect ratio; save the still as PNG, JPEG, WebP or GIF."
    );
  }
  const { aspect, exact } = nearestReferenceAspect(size.width, size.height);
  const notes = exact
    ? []
    : [
        `Note: reference_to_video, which makes clips of this length, offers no ${size.width}×${size.height} shape; ` +
          `the clip was asked for at ${aspect}, the closest it has, so the still is fitted to that.`
      ];
  return { aspect, notes };
}

/** The local tools (`LOCAL_TOOLS`): ffmpeg, Chrome or Python on local files, no Grok. */
async function commandLocalTool({ command, options, positionals, cwd }) {
  let result;
  try {
    result = await runLocalTool(command, { options, positionals, cwd });
  } catch (error) {
    if (!(error instanceof MediaToolError)) {
      throw error;
    }
    // The tool itself failed (exit 2): with --json, say so the way a failed generation does.
    if (options.json && error.exitCode === 2) {
      emit({ json: true, payload: { ok: false, command, reason: error.message }, text: error.message });
      process.exit(2);
    }
    fail(error.message, error.exitCode);
  }
  const { jobId, outDir, assets, elapsedMs } = result;
  const notes = [...result.notes, ...gitNotes(cwd, outDir, assets.map((asset) => asset.file))];
  if (notes.length > 0) {
    upsertJob(cwd, { id: jobId, notes });
  }
  emit({
    json: Boolean(options.json),
    payload: { ok: true, command, jobId, outDir, elapsedMs, assets, notes },
    text: renderMediaResult({ title: LOCAL_TOOLS[command].title, saved: assets, outDir, elapsedMs, jobId, notes })
  });
}

async function commandSetup({ options }) {
  const binary = findGrokBinary();
  const version = binary ? await getGrokVersion(binary) : null;
  const auth = binary ? readGrokAuth() : { authenticated: false, reason: "grok-not-installed" };
  const plan = binary ? readGrokPlan() : null;

  const models = await checkLatestModels();
  const { text, payload } = buildReadinessReport({ binary, version, auth, plan, compat: checkCompatibility(), models, zdrHint: ZDR_HINT });
  emit({ json: Boolean(options.json), payload, text });
}

async function commandAsk({ options, positionals, cwd }) {
  // An option added since the original plugin would do nothing here, even as `--flag=false`; say so rather than drop it.
  const added = Object.keys(options).find((option) => !ASK_OPTIONS.has(option));
  if (added) {
    fail(optionNotApplicable(added, "ask"));
  }
  const binary = requireGrok();
  const json = Boolean(options.json);

  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    fail("No prompt given. Usage: /grok:ask <prompt> [--write] [--model M]");
  }

  // Read-only unless the caller explicitly opts into writes.
  const readOnly = options.write !== true;
  // As in the original plugin: a value out of range is brought into it, and a malformed one means the default.
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
      emit({ json, payload: { ok: false, command: "ask", reason: message, sessionId: run.sessionId }, text: message });
    } else {
      process.stdout.write(`${message}\n`);
    }
    process.exit(2);
  }

  upsertJob(cwd, { id: jobId, status: "completed", sessionId: run.sessionId });

  emit({
    json,
    payload: { ok: true, command: "ask", text, sessionId: run.sessionId, elapsedMs, costUsd: Number.isFinite(costUsd) ? costUsd : null, readOnly },
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
  for (const note of job.notes ?? []) {
    lines.push("", note);
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
      "  setup                       Check the Grok CLI is installed, signed in, what it can generate, and xAI's current models",
      "  image   <prompt>            Generate image(s) with image_gen",
      `  edit    <prompt> --image P  Edit an image, or combine up to ${EDIT_IMAGE_LIMIT} (${OLDER_EDIT_IMAGE_LIMIT} on older models), with image_edit`,
      "  video   <prompt>            Generate a video (image_gen, then image_to_video)",
      "  animate <prompt> --image P  Animate a still with image_to_video (6 or 10 s), or reference_to_video (other lengths)",
      "  ref-video <prompt> inputs   Video from reference images, pinned frames and voices (reference_to_video)",
      "  ask     <prompt>            Delegate a general task to Grok",
      "  status                      List recent jobs of every kind in this workspace",
      "  result  [job-id]            Show a job's output files",
      "  cancel  [job-id]            Cancel a running job",
      "",
      "Local tools (ffmpeg, Chrome or Python on your files; no Grok, no quota):",
      "  last-frame <video>          Save the clip's last frame as a PNG",
      "  concat <video> <video>...   Join clips; --reencode when their size, fps or codecs differ",
      "  mute <video>                Drop the soundtrack, keeping the video as it is",
      "  reframe <image|video> --aspect W:H [--mode crop|pad] [--anchor center|top|bottom|left|right]",
      "                              Crop, or pad on a blurred copy, to another ratio",
      '  overlay --image I --text "T" [--sub "S"] [--brand brand.json] [--position top|center|bottom] [--style clean|bold|glass]',
      "          [--timeout SECS]    Exact text over an image, rendered by headless Chrome (timeout 1-600 s, default 60)",
      "  cutout <image> [--key #00FF00] [--tolerance N]",
      "                              Clear a flat background to transparency, without a green fringe",
      "  split <sheet> [--expect N] [--bg auto|#hex] [--tolerance N]",
      "                              One transparent PNG per item of a sheet, all on one canvas",
      "",
      "Common options:",
      "  --out DIR        Output directory (default: grok-media/)",
      `  --aspect RATIO   image, video, and edit with 2+ images: ${IMAGE_ASPECTS.join(", ")}`,
      "                   (21:9 and 5:2 on Image 2.0 only; animate keeps the source image's shape)",
      "  --count N        image, edit: number of results (1-8)",
      "  --name SLUG      Filename stem",
      "  --model M        Grok model id",
      "  --effort LEVEL   low | medium | high",
      "  --timeout SECS   Run timeout, 30-3600; ask brings a value outside that into range,",
      "                   the other Grok commands refuse it",
      "  --json           Machine-readable output",
      "  --verbatim=false Let Grok rewrite the prompt instead of passing it through",
      "",
      "Image model (image, edit, and video's opening frame):",
      `  --image-model M  ${IMAGE_MODEL_CHOICES.join(", ")}, or a Grok image model id (default ${DEFAULT_IMAGE_MODEL_CHOICE}, i.e.`,
      `                   ${DEFAULT_IMAGE_MODEL}; ${SERVER_IMAGE_MODEL} passes no override, so xAI's current default applies)`,
      "",
      "Video options (animate, video, ref-video):",
      `  --duration SECS  video: ${IMAGE_TO_VIDEO_DURATIONS.join(" or ")} (default ${DEFAULT_VIDEO_DURATION});`,
      `                   animate, ref-video: ${REFERENCE_VIDEO_DURATION.min}-${REFERENCE_VIDEO_DURATION.max} (default ${DEFAULT_VIDEO_DURATION})`,
      `  --resolution R   ${VIDEO_RESOLUTIONS.join(" or ")} (default ${DEFAULT_VIDEO_RESOLUTION}; the CLI offers nothing higher)`,
      `  --draft          A cheap ${DRAFT_VIDEO_RESOLUTION} try-out; ${DEFAULT_VIDEO_DURATION} s unless --duration is given,`,
      "                   and not combinable with --resolution",
      "",
      "ref-video inputs (give at least one; tag images <IMAGE_i> and voices <AUDIO_i> in the prompt):",
      `  --image P        Reference image, repeatable (up to ${REFERENCE_LIMITS.images}; ${OLDER_REFERENCE_IMAGES} on older Grok CLIs)`,
      "  --first-frame P  Exact opening frame        --last-frame P  Exact closing frame",
      `  --keyframe P@S   Image pinned at S seconds, strictly inside the clip, repeatable (up to ${REFERENCE_LIMITS.keyframes})`,
      `  --voice ID       Preset voice the subject speaks in, repeatable (up to ${REFERENCE_LIMITS.voices}), e.g. ara, eve, leo, rex`,
      "",
      "ref-video options:",
      "  --loop           Use the one --image as both first and last frame, for a seamless loop",
      `  --aspect RATIO   ${REFERENCE_VIDEO_ASPECTS.join(", ")} (default ${DEFAULT_REFERENCE_ASPECT})`,
      "",
      "Inputs (--image, --first-frame, --last-frame, --keyframe, and a local tool's files) take a path",
      "or an earlier result:",
      "  @last            The last file the plugin saved in this workspace, by a",
      "                   generation or a local tool",
      "  job:<id>         That job's first file (ids are in the output and in status)",
      "  job:<id>#N       That job's Nth file, counting from 1",
      "",
      "The image inputs of edit, animate and ref-video also take a data: URL; overlay's --image",
      "and the other local tools' files do not."
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
  // launched. Going on would start yet another Grok run and spend quota again;
  // through `ask`, Grok could even call itself in a loop.
  if (GROK_COMMANDS.has(command) && process.env[WORKER_ENV_VAR]) {
    fail(
      [
        `Refusing to run \`${command}\` inside a Grok run started by this plugin (${WORKER_ENV_VAR} is set).`,
        "Grok calling back into the plugin would start another Grok run and spend quota again.",
        "Run the command from Claude Code or a normal shell instead."
      ].join("\n")
    );
  }

  let parsed;
  try {
    parsed = parseArgs(argv.slice(1), {
      valueOptions: SHARED_VALUE_OPTIONS,
      booleanOptions: [...SHARED_BOOLEAN_OPTIONS, ...DEAD_OPTIONS],
      repeatOptions: ["image", "keyframe", "voice"],
      aliases: { o: "out", n: "count", m: "model" }
    });
  } catch (error) {
    fail(error.message);
  }
  const { options, positionals } = parsed;
  const dead = KEEP_DEAD_OPTIONS.has(command) ? undefined : DEAD_OPTIONS.find((option) => options[option] !== undefined);
  if (dead) {
    fail(`--${dead} is not an option of this plugin.`);
  }

  const cwd = process.env.CLAUDE_PROJECT_DIR ? path.resolve(process.env.CLAUDE_PROJECT_DIR) : process.cwd();

  if (Object.hasOwn(LOCAL_TOOLS, command)) {
    await commandLocalTool({ command, options, positionals, cwd });
    return;
  }

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
        images = rawImages.map((image) => resolveImageArg(image, cwd));
      } catch (error) {
        fail(String(error?.message ?? error));
      }
      // Large photos go to Grok as prepared copies, which live only for the run.
      const workDir = path.join(resolveStateDir(cwd), "refs", `${process.pid}-${Date.now()}`);
      const prepare = async () => {
        const { images: sent, prepared, notes } = await prepareEditReferences(images, { workDir });
        return {
          promptExtras: { images: sent },
          notes,
          meta: prepared.length > 0 ? { preparedReferences: prepared.map((each) => ({ ...each, source: path.basename(each.source) })) } : {},
          cleanup: () => fs.rmSync(workDir, { recursive: true, force: true })
        };
      };
      await runMediaCommand({
        command: "edit",
        options,
        positionals,
        cwd,
        promptBuilder: buildEditPrompt,
        title: "Edited",
        defaultOutDir: "grok-media",
        extra: { maxTurns: 6, defaultTimeoutSeconds: 600, promptExtras: { images }, prepare }
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
        image = resolveImageArg(rawImage, cwd);
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
          requiredOutputTypes: ["ImageToVideo", "ReferenceToVideo", "VideoGen"],
          resolveInputs: (spec) => (spec.videoTool === "reference_to_video" ? stillAsFirstFrame(image, rawImage) : {})
        }
      });
      return;
    }

    case "ref-video":
      await runMediaCommand({
        command: "ref-video",
        options,
        positionals,
        cwd,
        promptBuilder: buildReferenceVideoPrompt,
        title: "Generated video",
        defaultOutDir: "grok-media",
        extra: {
          maxTurns: 5,
          defaultTimeoutSeconds: 1200,
          requiredOutputTypes: ["ReferenceToVideo"],
          // Checked against the reference_to_video this Grok CLI offers (see /grok:setup).
          resolveInputs: (spec) =>
            resolveReferenceInputs(options, spec.duration, (value) => resolveImageArg(value, cwd), referenceInputLimits())
        }
      });
      return;

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
