/**
 * `/grok:setup`'s two watches for a Grok that moved on: the media tools'
 * parameters (from the sessions on disk) and xAI's current Imagine models
 * (from its public docs, served here by a local server — no test reaches the
 * network).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { createSandbox } from "./companion-harness.mjs";
import { FULL_TOOLSET, PARAMETERS, addSession } from "./grok-fixtures.mjs";

function signIn(sandbox) {
  fs.writeFileSync(
    path.join(sandbox.grokHome, "auth.json"),
    JSON.stringify({ "https://auth.x.ai": { email: "tester@example.com", create_time: "2026-09-01T00:00:00Z", access_token: "FAKE-ACCESS-TOKEN" } })
  );
}

async function setup(sandbox, env) {
  const text = await sandbox.run(["setup"], { env });
  const json = await sandbox.run(["setup", "--json"], { env });
  return { text: text.stdout, report: JSON.parse(json.stdout) };
}

const MODELS_PAGE = [
  "# Models",
  "",
  "Images: [Grok Imagine Image 2.0](/developers/models/grok-imagine-image-2.0)",
  "",
  "Videos: [Grok Imagine Video 1.5](/developers/models/grok-imagine-video-1.5)"
].join("\n");

const RELEASE_NOTES = [
  "### grok-imagine-image-quality retirement on November 2",
  "",
  "On November 2, 2026, `grok-imagine-image-quality` is retired. Requests to the slug will be served by `grok-imagine-image-2.0` with `quality` set to `low`."
].join("\n");

/** Serve docs pages from `pages` (path → text, or a status code) on a local port; `t` closes it. */
async function docsServer(t, pages) {
  const server = http.createServer((request, response) => {
    const page = pages[request.url];
    if (typeof page === "string") {
      response.writeHead(200, { "content-type": "text/markdown" });
      response.end(page);
    } else {
      response.writeHead(page ?? 404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function setupAgainst(t, pages) {
  const sandbox = createSandbox(t);
  signIn(sandbox);
  const url = await docsServer(t, pages);
  return setup(sandbox, { GROK_PLUGIN_DOCS_URL: url });
}

test("setup confirms the media tools take the parameters the plugin was built for", async (t) => {
  const sandbox = createSandbox(t);
  signIn(sandbox);
  addSession(sandbox, { tools: FULL_TOOLSET });

  const { text, report } = await setup(sandbox);

  assert.match(text, /ok {4}Tool options: image_gen, image_edit, image_to_video, reference_to_video: the same parameters the plugin was built for/);
  assert.equal(report.compat.toolOptions.status, "ok");
});

test("setup warns, without blocking, when a media tool starts or stops taking a parameter", async (t) => {
  const sandbox = createSandbox(t);
  signIn(sandbox);
  addSession(sandbox, {
    tools: FULL_TOOLSET,
    parameters: {
      image_gen: { ...PARAMETERS.image_gen, resolution: "1k or 2k.", quality: "low or medium." },
      image_edit: { prompt: PARAMETERS.image_edit.prompt, image: PARAMETERS.image_edit.image },
      image_to_video: { ...PARAMETERS.image_to_video, aspect_ratio: "Aspect ratio of the video." }
    }
  });

  const { text, report } = await setup(sandbox);

  assert.match(text, /WARN {2}Tool options: image_gen now takes `resolution`, `quality`, which the plugin does not offer yet/);
  assert.match(text, /WARN {2}Tool options: image_edit no longer takes `aspect_ratio`; the plugin may be passing an option it ignores\./);
  assert.match(text, /WARN {2}Tool options: image_to_video now takes `aspect_ratio`/);
  assert.equal(report.ready, true);
});

test("setup leaves the tool options unverified when no session offered the media tools", async (t) => {
  const sandbox = createSandbox(t);
  signIn(sandbox);

  const { text } = await setup(sandbox);

  assert.match(text, /-- {4}Tool options: not verified/);
});

test("setup skips xAI's model list when told to, and says so", async (t) => {
  const sandbox = createSandbox(t);
  signIn(sandbox);

  const { text, report } = await setup(sandbox);

  assert.match(text, /-- {4}Latest models: not verified: skipped \(GROK_PLUGIN_DOCS_URL=off\)/);
  assert.equal(report.models.status, "not-verified");
});

test("setup confirms the plugin asks for xAI's current models, not mistaking a replacement for a retirement", async (t) => {
  const { text, report } = await setupAgainst(t, { "/developers/models.md": MODELS_PAGE, "/developers/release-notes.md": RELEASE_NOTES });

  assert.match(
    text,
    /ok {4}Latest models: xAI lists grok-imagine-image-2\.0 for images \(the plugin's default\) and grok-imagine-video-1\.5 for video \(the one the Grok CLI calls\), with no retirement notice for either/
  );
  assert.deepEqual(report.models, { status: "ok", image: "grok-imagine-image-2.0", video: "grok-imagine-video-1.5", warnings: [] });
});

test("setup warns, without blocking, when xAI lists newer models than the plugin's", async (t) => {
  const pages = {
    "/developers/models.md": MODELS_PAGE.replace(/grok-imagine-image-2\.0/g, "grok-imagine-image-3.0").replace(/grok-imagine-video-1\.5/g, "grok-imagine-video-2.0"),
    "/developers/release-notes.md": RELEASE_NOTES
  };

  const { text, report } = await setupAgainst(t, pages);

  assert.match(text, /WARN {2}Latest models: xAI's current image model is grok-imagine-image-3\.0, and the plugin defaults to grok-imagine-image-2\.0: try it with --image-model grok-imagine-image-3\.0/);
  assert.match(text, /WARN {2}Latest models: xAI's current video model is grok-imagine-video-2\.0, and the Grok CLI's video tools call grok-imagine-video-1\.5: update the Grok CLI/);
  assert.equal(report.ready, true);
});

test("setup warns when xAI's release notes retire a model the plugin uses", async (t) => {
  const notes = `${RELEASE_NOTES}\n\n### Imagine video\n\nOn March 1, 2027, \`grok-imagine-video-1.5\` is retired in favour of a newer model.`;

  const { text } = await setupAgainst(t, { "/developers/models.md": MODELS_PAGE, "/developers/release-notes.md": notes });

  assert.match(text, /WARN {2}Latest models: xAI's release notes on grok-imagine-video-1\.5: On March 1, 2027, grok-imagine-video-1\.5 is retired in favour of a newer model\./);
  assert.doesNotMatch(text, /release notes on grok-imagine-image-2\.0/);
});

test("setup leaves the models unverified, without blocking, when the docs cannot be read or changed shape", async (t) => {
  const down = await setupAgainst(t, { "/developers/models.md": 500, "/developers/release-notes.md": RELEASE_NOTES });
  assert.match(down.text, /-- {4}Latest models: not verified: could not read http:\/\/127\.0\.0\.1:\d+ \(HTTP 500/);
  assert.equal(down.report.ready, true);

  const reshaped = await setupAgainst(t, { "/developers/models.md": "# Models\n\nSee the table below.", "/developers/release-notes.md": RELEASE_NOTES });
  assert.match(reshaped.text, /-- {4}Latest models: not verified: .*models\.md no longer names the image and video models where the plugin looks/);
});
