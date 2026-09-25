/**
 * Human-readable output for the companion CLI.
 *
 * Every command also supports `--json`; these helpers only build the text form
 * that Claude relays to the user.
 */

import path from "node:path";

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "unknown size";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return "unknown";
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function formatCost(usd) {
  if (!Number.isFinite(usd)) {
    return null;
  }
  return `$${usd.toFixed(4)}`;
}

/** The success report for a media run. */
export function renderMediaResult({ title, saved, outDir, elapsedMs, costUsd, sessionId, jobId, notes = [] }) {
  const lines = [];

  lines.push(`${title}: ${saved.length} file${saved.length === 1 ? "" : "s"}`);
  lines.push("");

  for (const asset of saved) {
    lines.push(`  ${asset.file}`);
    lines.push(`    ${formatBytes(asset.bytes)}${asset.aspectRatio ? ` · ${asset.aspectRatio}` : ""}${asset.tool ? ` · ${asset.tool}` : ""}`);
    if (asset.prompt) {
      lines.push(`    prompt: ${truncate(asset.prompt, 240)}`);
    }
    lines.push("");
  }

  lines.push(`Output directory: ${outDir}`);

  const meta = [];
  if (Number.isFinite(elapsedMs)) {
    meta.push(formatDuration(elapsedMs));
  }
  const cost = formatCost(costUsd);
  if (cost) {
    meta.push(cost);
  }
  if (sessionId) {
    meta.push(`session ${sessionId}`);
  }
  if (jobId) {
    meta.push(`job ${jobId}`);
  }
  if (meta.length > 0) {
    lines.push(meta.join(" · "));
  }

  for (const note of notes) {
    lines.push("");
    lines.push(note);
  }

  return lines.join("\n");
}

/**
 * The failure report.
 *
 * `hint` carries the actionable part — most notably the Zero Data Retention
 * explanation, which is otherwise just an opaque HTTP 400.
 */
export function renderMediaFailure({
  title,
  reason,
  hint,
  agentMessage,
  sessionId,
  failedCalls = [],
  partialAssets = [],
  outDir = null,
  notes = []
}) {
  const headline =
    partialAssets.length > 0
      ? `${title} did not complete. ${partialAssets.length} intermediate file${partialAssets.length === 1 ? " was" : "s were"} kept.`
      : `${title} produced no files.`;

  const lines = [headline, ""];

  if (reason) {
    lines.push(reason, "");
  }

  if (partialAssets.length > 0) {
    lines.push("Kept:");
    for (const asset of partialAssets) {
      lines.push(`  ${asset.file}  (${formatBytes(asset.bytes)}${asset.tool ? ` · ${asset.tool}` : ""})`);
    }
    if (outDir) {
      lines.push(`  in ${outDir}`);
    }
    lines.push("");
  }

  for (const call of failedCalls) {
    if (!call.error) {
      continue;
    }
    lines.push(`${call.tool ?? "tool"} failed:`);
    lines.push(indent(truncate(call.error, 800)));
    lines.push("");
  }

  if (hint) {
    lines.push(hint, "");
  }

  if (agentMessage) {
    lines.push("Grok said:");
    lines.push(indent(truncate(agentMessage, 1200)));
    lines.push("");
  }

  if (sessionId) {
    lines.push(`Session: ${sessionId}`);
  }

  for (const note of notes) {
    lines.push("", note);
  }

  return lines.join("\n").trimEnd();
}

export function renderJobList(jobs) {
  if (jobs.length === 0) {
    return "No Grok jobs recorded for this workspace yet.";
  }

  const lines = ["Grok jobs (newest first):", ""];

  for (const job of jobs) {
    const bits = [job.status ?? "unknown"];
    if (Number.isFinite(job.assetCount)) {
      bits.push(`${job.assetCount} file${job.assetCount === 1 ? "" : "s"}`);
    }
    if (job.outDir) {
      bits.push(path.basename(job.outDir));
    }

    lines.push(`  ${job.id}  [${job.command}]  ${bits.join(" · ")}`);
    if (job.prompt) {
      lines.push(`    ${truncate(job.prompt, 100)}`);
    }
    lines.push(`    started ${job.createdAt}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function indent(text, prefix = "  ") {
  return String(text ?? "")
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

export function truncate(text, limit) {
  const value = String(text ?? "");
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit - 1)}…`;
}
