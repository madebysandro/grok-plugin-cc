import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createSandbox } from "./companion-harness.mjs";
import { FULL_TOOLSET, OLD_REFERENCE_TO_VIDEO, PARAMETERS, addSession } from "./grok-fixtures.mjs";

/**
 * A Grok login setup can read. The token is fake and must never be shown;
 * `zeroDataRetention` marks an account whose video generation xAI rejects.
 */
function signIn(sandbox, { zeroDataRetention = false } = {}) {
  fs.writeFileSync(
    path.join(sandbox.grokHome, "auth.json"),
    JSON.stringify({
      "https://auth.x.ai": {
        email: "tester@example.com",
        create_time: "2026-09-01T00:00:00Z",
        access_token: "FAKE-ACCESS-TOKEN",
        coding_data_retention_opt_out: zeroDataRetention
      }
    })
  );
}

/** Contents of every file under `dir`, joined. */
function contentsUnder(dir) {
  return fs
    .readdirSync(dir, { recursive: true })
    .map((relative) => path.join(dir, relative))
    .filter((file) => fs.statSync(file).isFile())
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
}

/** Run setup twice, as text and as --json; `stderr` joins both runs'. */
async function setup(sandbox) {
  const text = await sandbox.run(["setup"]);
  const json = await sandbox.run(["setup", "--json"]);
  return { text: text.stdout, report: JSON.parse(json.stdout), jsonText: json.stdout, stderr: text.stderr + json.stderr };
}

test("setup without any Grok session on disk reports the checks as not verified, without blocking", async (t) => {
  const sandbox = createSandbox(t);
  signIn(sandbox);

  const { text, report } = await setup(sandbox);

  assert.match(text, /Media tools: not verified/);
  assert.match(text, /Session log format: not verified/);
  assert.equal(report.ready, true);
});

test("setup confirms the media tools a full Grok session advertises", async (t) => {
  const sandbox = createSandbox(t);
  signIn(sandbox);
  addSession(sandbox, { tools: FULL_TOOLSET });

  const { text, report } = await setup(sandbox);

  assert.match(text, /ok {4}Media tools: all advertised/);
  assert.equal(report.compat.mediaTools.status, "ok");
});

test("setup fails naming a media tool the newest full Grok session no longer advertises", async (t) => {
  const sandbox = createSandbox(t);
  signIn(sandbox);
  addSession(sandbox, { tools: FULL_TOOLSET, minutesAgo: 60 });
  addSession(sandbox, { tools: FULL_TOOLSET.filter((name) => name !== "reference_to_video"), minutesAgo: 1 });

  const { text, report } = await setup(sandbox);

  assert.match(text, /FAIL {2}Media tools: missing reference_to_video/);
  assert.doesNotMatch(text, /Everything is ready/);
  assert.equal(report.ready, false);
});

test("a plugin-only history verifies the tools its runs were offered and fails none", async (t) => {
  const sandbox = createSandbox(t);
  signIn(sandbox);
  // Runs restricted with --tools advertise only what they asked for.
  addSession(sandbox, { tools: ["image_gen", "image_to_video"], minutesAgo: 30 });
  addSession(sandbox, { tools: ["image_gen"], minutesAgo: 1 });

  const { report } = await setup(sandbox);

  assert.deepEqual(report.compat.mediaTools, {
    status: "not-verified",
    advertised: ["image_gen", "image_to_video"],
    missing: [],
    unverified: ["image_edit", "reference_to_video"]
  });
  assert.equal(report.ready, true);
});

test("a restricted run that also shows a new always-on tool is not mistaken for a full session", async (t) => {
  const sandbox = createSandbox(t);
  signIn(sandbox);
  // A future CLI may keep one more tool in --tools runs; that alone must not
  // turn every plugin session into proof that the other media tools are gone.
  addSession(sandbox, { tools: ["search_tool", "use_tool", "todo_write", "image_gen"] });

  const { report } = await setup(sandbox);

  assert.equal(report.compat.mediaTools.status, "not-verified");
  assert.deepEqual(report.compat.mediaTools.missing, []);
});

test("setup confirms the session log still leads to the media on disk", async (t) => {
  const sandbox = createSandbox(t);
  signIn(sandbox);
  addSession(sandbox, { media: "grok-log" });

  const { text, report } = await setup(sandbox);

  assert.match(text, /ok {4}Session log format: .* leads to all of its 1 media file\(s\)/);
  assert.equal(report.ready, true);
});

test("setup warns, without blocking, when the session log leads to only some of the media on disk", async (t) => {
  const sandbox = createSandbox(t);
  signIn(sandbox);
  addSession(sandbox, { media: "grok-log-partial" });

  const { text, report } = await setup(sandbox);

  assert.match(text, /WARN {2}Session log format: .* leads to only 1 of its 2 media file\(s\)/);
  assert.equal(report.compat.harvest.status, "warn");
  assert.equal(report.ready, true);
});

test("setup matches the session log to the media on disk through symlinks", async (t) => {
  const sandbox = createSandbox(t);
  signIn(sandbox);
  addSession(sandbox, { media: "grok-log-via-symlink" });

  const { text } = await setup(sandbox);

  assert.match(text, /ok {4}Session log format: /);
});

test("setup fails when media on disk cannot be found through the session log", async (t) => {
  const sandbox = createSandbox(t);
  signIn(sandbox);
  addSession(sandbox, { media: "unknown-log" });

  const { text, report } = await setup(sandbox);

  assert.match(text, /FAIL {2}Session log format: session log format changed/);
  assert.equal(report.ready, false);
});

test("setup warns, without blocking, when a video tool advertises a resolution or duration the plugin does not allow", async (t) => {
  const sandbox = createSandbox(t);
  signIn(sandbox);
  addSession(sandbox, {
    tools: FULL_TOOLSET,
    parameters: {
      image_to_video: {
        ...PARAMETERS.image_to_video,
        duration: "Duration of the video generation, either 6, 10 or 15 seconds.",
        resolution_name: "Resolution name of the video generation, either 480p, 720p or 1080p."
      },
      reference_to_video: { ...PARAMETERS.reference_to_video, duration: "Duration of the video in seconds, between 1 and 20." }
    }
  });

  const { text, report } = await setup(sandbox);

  assert.match(text, /WARN {2}.*image_to_video now mentions resolution 1080p/);
  assert.match(text, /WARN {2}.*image_to_video now mentions 15 s/);
  assert.match(text, /WARN {2}.*reference_to_video now mentions 20 s/);
  assert.equal(report.ready, true);
});


test("setup --json exposes the new reference_to_video schema and its 14-image limit", async (t) => {
  const sandbox = createSandbox(t);
  signIn(sandbox);
  addSession(sandbox, { tools: FULL_TOOLSET });

  const { text, report } = await setup(sandbox);

  assert.deepEqual(report.compat.referenceToVideo, { status: "ok", schema: "new", maxImages: 14 });
  assert.match(text, /reference_to_video schema: new/);
});

test("setup --json exposes the old reference_to_video schema and its 7-image limit", async (t) => {
  const sandbox = createSandbox(t);
  signIn(sandbox);
  addSession(sandbox, { tools: FULL_TOOLSET, parameters: { reference_to_video: OLD_REFERENCE_TO_VIDEO } });

  const { text, report } = await setup(sandbox);

  assert.deepEqual(report.compat.referenceToVideo, { status: "ok", schema: "old", maxImages: 7 });
  assert.match(text, /reference_to_video schema: old/);
});

test("setup leaves the reference_to_video schema unknown when no session offered it", async (t) => {
  const sandbox = createSandbox(t);
  signIn(sandbox);
  addSession(sandbox, { tools: ["image_gen"] });

  const { report } = await setup(sandbox);

  assert.deepEqual(report.compat.referenceToVideo, { status: "not-verified", schema: null, maxImages: null });
  assert.equal(report.ready, true);
});

/**
 * Grok's signed settings cache. Where the plan fields sit inside the payload is
 * not pinned down, so they are nested next to a fake secret that must never
 * reach the output.
 */
function writeSettingsCache(sandbox, settings, { encoding = "json" } = {}) {
  const json = JSON.stringify({ account: { session_token: "FAKE-SETTINGS-SECRET" }, ...settings });
  const payload = encoding === "base64" ? Buffer.from(json).toString("base64") : json;
  fs.writeFileSync(path.join(sandbox.grokHome, "settings_cache.json"), JSON.stringify({ payload, signature: [1, 2, 3] }));
}

const PLAN_SETTINGS = {
  subscription: { subscription_tier_display: "SuperGrok Plus" },
  features: { image_gen_enabled: true, video_gen_enabled: true, imagine_tools_disabled: false }
};

for (const encoding of ["json", "base64"]) {
  test(`setup shows the plan and media flags from the settings cache (${encoding} payload) and nothing secret`, async (t) => {
    const sandbox = createSandbox(t);
    signIn(sandbox);
    writeSettingsCache(sandbox, PLAN_SETTINGS, { encoding });

    const { text, report, jsonText, stderr } = await setup(sandbox);

    assert.match(text, /Plan: SuperGrok Plus · image generation on · video generation on/);
    assert.deepEqual(report.plan, {
      tier: "SuperGrok Plus",
      imageGenEnabled: true,
      videoGenEnabled: true,
      imagineToolsDisabled: false
    });
    for (const output of [text, jsonText, stderr, contentsUnder(sandbox.pluginData)]) {
      assert.doesNotMatch(output, /FAKE-SETTINGS-SECRET|FAKE-ACCESS-TOKEN/);
    }
  });
}

// The cache's payload format is not pinned down, so a switch read from it only
// warns: a misread must never block the plugin.
test("setup warns, without blocking, when Grok's settings say video generation is off", async (t) => {
  const sandbox = createSandbox(t);
  signIn(sandbox);
  writeSettingsCache(sandbox, { ...PLAN_SETTINGS, features: { ...PLAN_SETTINGS.features, video_gen_enabled: false } });

  const { text, report } = await setup(sandbox);

  assert.match(text, /Plan: SuperGrok Plus · image generation on · video generation off/);
  assert.match(text, /WARN {2}Video generation: disabled for this account in Grok's settings/);
  assert.match(text, /ok {4}Image generation/);
  assert.equal(report.ready, true);
});

test("setup shows the plan as unknown, without blocking, when the settings cache cannot be read", async (t) => {
  const sandbox = createSandbox(t);
  signIn(sandbox);
  fs.writeFileSync(
    path.join(sandbox.grokHome, "settings_cache.json"),
    JSON.stringify({ payload: "%%not-json FAKE-SETTINGS-SECRET%%", signature: [] })
  );

  const { text, report, jsonText, stderr } = await setup(sandbox);

  assert.match(text, /Plan: unknown/);
  assert.equal(report.plan, null);
  assert.equal(report.ready, true);
  assert.equal(stderr, "");
  assert.doesNotMatch(text + jsonText, /FAKE-SETTINGS-SECRET/);
});

test("setup never starts a Grok run: it only asks the binary for its version, with updates off", async (t) => {
  const sandbox = createSandbox(t);
  signIn(sandbox);
  addSession(sandbox, { tools: FULL_TOOLSET, media: "grok-log" });

  await setup(sandbox);

  const calls = sandbox.grokCalls();
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.deepEqual(call.args, ["--version"]);
    assert.equal(call.env.GROK_DISABLE_AUTOUPDATER, "1");
  }
});

test("on a Zero Data Retention account, another FAIL still asks for a fix instead of calling images ready", async (t) => {
  const sandbox = createSandbox(t);
  signIn(sandbox, { zeroDataRetention: true });
  addSession(sandbox, { tools: FULL_TOOLSET.filter((name) => name !== "image_edit") });

  const { text } = await setup(sandbox);

  assert.match(text, /Fix the FAIL lines above/);
  assert.doesNotMatch(text, /Images and image editing are ready to use/);
  assert.match(text, /Video generation will fail on this account/);
});

test("setup reads limits written as 6s, 1080P or 4K", async (t) => {
  const sandbox = createSandbox(t);
  signIn(sandbox);
  addSession(sandbox, {
    tools: FULL_TOOLSET,
    parameters: {
      image_to_video: {
        ...PARAMETERS.image_to_video,
        duration: "Clip length: 6s, 10s or 15s.",
        resolution_name: "One of 480p, 720p, 1080P or 4K."
      }
    }
  });

  const { report } = await setup(sandbox);

  assert.deepEqual(report.compat.limits.warnings, [
    "image_to_video now mentions resolution 1080p, 4k; the plugin allows 480p/720p (lib/media-spec.mjs).",
    "image_to_video now mentions 15 s; the plugin allows 6 or 10 s (lib/media-spec.mjs)."
  ]);
});

test("setup warns when a video tool stops describing a limit it used to", async (t) => {
  const sandbox = createSandbox(t);
  signIn(sandbox);
  const { resolution_name, ...withoutResolution } = PARAMETERS.reference_to_video;
  addSession(sandbox, { tools: FULL_TOOLSET, parameters: { reference_to_video: withoutResolution } });

  const { text, report } = await setup(sandbox);

  assert.match(text, /WARN {2}Video limits: reference_to_video no longer describes resolution_name/);
  assert.equal(report.ready, true);
});
