/**
 * The `/grok:setup` report: one line per check, a verdict, and the JSON form.
 *
 * Each check has a status — "ok", "fail", "warn", or "not-verified" when
 * nothing on disk could tell yet. Only "fail" makes the plugin not ready.
 */

import { indent } from "./render.mjs";

const LABELS = { ok: "ok  ", fail: "FAIL", warn: "WARN", "not-verified": "--  " };

const DISABLED_IN_SETTINGS = "disabled for this account in Grok's settings";

/** A check that either passes or fails. */
function passFail(name, passed, detail) {
  return { name, status: passed ? "ok" : "fail", detail };
}

/**
 * What Grok's settings say about one kind of media: true (on), false (off) or
 * null when they do not say.
 */
function switchedOn(plan, flag) {
  if (plan?.imagineToolsDisabled === true || plan?.[flag] === false) {
    return false;
  }
  return plan?.[flag] === true ? true : null;
}

function planCheck(plan) {
  if (!plan) {
    return { name: "Plan", status: "not-verified", detail: "unknown (Grok's settings cache holds no plan this plugin can read)" };
  }
  const parts = [plan.tier ?? "unknown tier"];
  for (const [label, flag] of [["image generation", "imageGenEnabled"], ["video generation", "videoGenEnabled"]]) {
    const on = switchedOn(plan, flag);
    if (on !== null) {
      parts.push(`${label} ${on ? "on" : "off"}`);
    }
  }
  return { name: "Plan", status: "ok", detail: parts.join(" · ") };
}

/**
 * Image or video generation. Only the account state can fail it; a switch read
 * from Grok's settings cache just warns, since that cache's format is not
 * pinned down and a misread must not block the plugin.
 */
function generationCheck(name, { failure, switched }) {
  if (failure) {
    return { name, status: "fail", detail: failure };
  }
  if (switched === false) {
    return { name, status: "warn", detail: DISABLED_IN_SETTINGS };
  }
  return { name, status: "ok", detail: "available" };
}

function mediaToolsCheck({ status, advertised, missing, unverified }) {
  const name = "Media tools";
  if (status === "fail") {
    return { name, status, detail: `missing ${missing.join(", ")}: this Grok CLI no longer offers it, so the plugin needs an update` };
  }
  if (status === "ok") {
    return { name, status, detail: `all advertised (${advertised.join(", ")})` };
  }
  const seen = advertised.length > 0 ? `; advertised: ${advertised.join(", ")}` : "";
  return { name, status, detail: `not verified for ${unverified.join(", ")} (no session on disk offered them yet)${seen}` };
}

function harvestCheck({ status, dir, mediaFiles, recovered, when }) {
  const name = "Session log format";
  if (status === "not-verified") {
    return { name, status, detail: "not verified (no session with generated media on disk yet)" };
  }
  if (status === "ok") {
    return { name, status, detail: `the log of the newest session with media (${when}) leads to ${recovered} of its ${mediaFiles} file(s)` };
  }
  return {
    name,
    status,
    detail:
      `session log format changed: ${mediaFiles} media file(s) sit in ${dir}, but its updates.jsonl leads to none of them. ` +
      "Generated files would not be collected; the plugin needs an update for this Grok CLI version."
  };
}

/** One line per warning; a warning never blocks. */
function limitsChecks({ status, checked, warnings }) {
  const name = "Video limits";
  if (status === "warn") {
    return warnings.map((detail) => ({ name, status, detail }));
  }
  if (status === "ok") {
    return [{ name, status, detail: `${checked.join(" and ")}: only the resolutions and durations the plugin allows` }];
  }
  return [{ name, status, detail: "not verified (no session on disk offered a video tool yet)" }];
}

function referenceSchemaCheck({ status, schema, maxImages }) {
  const name = "reference_to_video schema";
  if (status !== "ok") {
    return { name, status, detail: "not verified (no session on disk offered reference_to_video yet)" };
  }
  const pins = schema === "new" ? "first/last frame and keyframes" : "no first/last frame or keyframes";
  return { name, status, detail: `${schema} (up to ${maxImages} reference images, ${pins})` };
}

/**
 * Build the report from what setup gathered: the binary and its version, the
 * signed-in account (`readGrokAuth`), the plan (`readGrokPlan`), and the
 * compatibility checks (`checkCompatibility`). `zdrHint` explains the Zero
 * Data Retention video block.
 *
 * Returns `{ text, payload }`.
 */
export function buildReadinessReport({ binary, version, auth, plan, compat, zdrHint }) {
  const signedIn = Boolean(binary && auth.authenticated);
  const videoBlocked = Boolean(auth.authenticated && auth.dataRetentionOptOut);
  const imageOn = switchedOn(plan, "imageGenEnabled");
  const videoOn = switchedOn(plan, "videoGenEnabled");
  const notSignedIn = signedIn ? null : "needs an installed, signed-in CLI";

  const checks = [
    passFail("Grok CLI installed", Boolean(binary), binary ?? "not found on PATH, ~/.grok/bin, or $GROK_BIN"),
    passFail("Grok CLI runs", Boolean(version), version ?? "could not execute `grok --version`"),
    passFail("Signed in", Boolean(auth.authenticated), auth.authenticated ? (auth.email ?? "authenticated") : "run `grok login`"),
    planCheck(plan),
    generationCheck("Image generation", { failure: notSignedIn, switched: imageOn }),
    generationCheck("Video generation", {
      failure: videoBlocked ? "blocked by Zero Data Retention on this account" : notSignedIn,
      switched: videoOn
    }),
    mediaToolsCheck(compat.mediaTools),
    harvestCheck(compat.harvest),
    ...limitsChecks(compat.limits),
    referenceSchemaCheck(compat.referenceToVideo)
  ];

  const ready = checks.every((check) => check.status !== "fail");

  const lines = ["Grok plugin readiness", ""];
  for (const check of checks) {
    lines.push(`  ${LABELS[check.status]}  ${check.name}: ${check.detail}`);
  }
  lines.push("");
  if (checks.some((check) => check.status === "not-verified")) {
    lines.push(
      "-- = not verified: setup only reads what Grok left on disk (sessions, settings cache) instead of generating anything, and nothing there could tell yet. It does not block."
    );
    lines.push("");
  }

  // The Zero Data Retention block has its own explanation; any other FAIL wins
  // over calling images ready.
  const otherFailures = checks.some((check) => check.status === "fail" && !(videoBlocked && check.name === "Video generation"));
  if (!binary) {
    lines.push("Install the Grok CLI from https://x.ai/build, then run `grok login`.");
  } else if (!auth.authenticated) {
    lines.push("Run `!grok login` to sign in.");
  } else if (otherFailures) {
    lines.push("Fix the FAIL lines above before relying on the plugin.");
  } else if (videoBlocked) {
    lines.push("Images and image editing are ready to use.");
  } else {
    lines.push("Everything is ready. Try `/grok:image a neon-lit rooftop at dusk`.");
  }
  if (signedIn && videoBlocked) {
    lines.push("");
    lines.push("Video generation will fail on this account:");
    lines.push(indent(zdrHint));
  }

  return {
    text: lines.join("\n"),
    payload: {
      ready,
      binary,
      version,
      authenticated: Boolean(auth.authenticated),
      email: auth.email ?? null,
      teamId: auth.teamId ?? null,
      zeroDataRetention: Boolean(auth.dataRetentionOptOut),
      videoAvailable: signedIn && !videoBlocked && videoOn !== false,
      plan,
      compat,
      checks
    }
  };
}
