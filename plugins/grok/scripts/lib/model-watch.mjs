/**
 * Whether the plugin still asks for xAI's newest Imagine models, read from
 * xAI's public documentation: the models page names the current image and
 * video models, and the release notes announce retirements. Two plain GETs to
 * docs.x.ai, without any credential; only `/grok:setup` runs them.
 *
 * `GROK_PLUGIN_DOCS_URL` points them elsewhere (a mirror, a test server), and
 * `off` skips the check.
 */

import { DEFAULT_IMAGE_MODEL } from "./media-spec.mjs";

export const DOCS_URL_ENV = "GROK_PLUGIN_DOCS_URL";
const DEFAULT_DOCS_URL = "https://docs.x.ai";
const TIMEOUT_MS = 5000;

/**
 * The model the Grok CLI's video tools call. It is fixed in the CLI's source
 * (`XAI_VIDEO_MODEL`, checked on 1.0.41), with no override, so the plugin can
 * only notice when xAI moves on and a CLI update is due.
 */
export const CLI_VIDEO_MODEL = "grok-imagine-video-1.5";

/**
 * Compare xAI's current models with the plugin's.
 *
 * Returns `{ status, image, video, warnings, reason }`: "ok" when xAI lists the
 * plugin's models and announces no retirement for them, "warn" otherwise, and
 * "not-verified" (with a `reason`) when the pages cannot be read or have
 * changed shape. A warning never blocks.
 */
export async function checkLatestModels({ baseUrl = process.env[DOCS_URL_ENV] ?? DEFAULT_DOCS_URL, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (baseUrl === "off") {
    return { status: "not-verified", reason: `skipped (${DOCS_URL_ENV}=off)` };
  }
  const base = baseUrl.replace(/\/+$/, "");

  let modelsPage;
  let releaseNotes;
  try {
    [modelsPage, releaseNotes] = await Promise.all(
      ["/developers/models.md", "/developers/release-notes.md"].map((page) => fetchText(fetchImpl, `${base}${page}`, timeoutMs))
    );
  } catch (error) {
    return { status: "not-verified", reason: `could not read ${base} (${error.message})` };
  }

  const image = currentModel(modelsPage, "Images");
  const video = currentModel(modelsPage, "Videos");
  if (!image || !video) {
    return { status: "not-verified", reason: `${base}/developers/models.md no longer names the image and video models where the plugin looks` };
  }

  const warnings = [];
  if (image !== DEFAULT_IMAGE_MODEL) {
    warnings.push(
      `xAI's current image model is ${image}, and the plugin defaults to ${DEFAULT_IMAGE_MODEL}: try it with --image-model ${image}, ` +
        "and change the default in lib/media-spec.mjs."
    );
  }
  if (video !== CLI_VIDEO_MODEL) {
    warnings.push(
      `xAI's current video model is ${video}, and the Grok CLI's video tools call ${CLI_VIDEO_MODEL}: ` +
        "update the Grok CLI, then check its tools with /grok:setup."
    );
  }
  for (const model of [DEFAULT_IMAGE_MODEL, CLI_VIDEO_MODEL]) {
    const notice = retirementNotice(releaseNotes, model);
    if (notice) {
      warnings.push(`xAI's release notes on ${model}: ${notice}`);
    }
  }
  return { status: warnings.length > 0 ? "warn" : "ok", image, video, warnings };
}

async function fetchText(fetchImpl, url, timeoutMs) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

/** The model id on the models page's `Images:` or `Videos:` line, e.g. `Images: [Grok Imagine Image 2.0](/developers/models/grok-imagine-image-2.0)`. */
function currentModel(page, label) {
  const match = new RegExp(`^\\s*[-*]?\\s*${label}:\\s*\\[[^\\]]*\\]\\(/developers/models/([a-z0-9.-]+)\\)`, "mi").exec(page);
  return match ? match[1] : null;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The first sentence of the release notes that retires or deprecates `model`
 * itself — within a few words of its id, not merely in the same paragraph
 * (a retirement notice names the model that replaces the retired one too).
 * Markdown links and backticks are dropped. Null when there is none.
 */
function retirementNotice(notes, model) {
  const id = `\`?(?<![\\w.-])${escapeRegExp(model)}(?![\\w.-])\`?`;
  const pattern = new RegExp(`${id}\\s+(?:\\S+\\s+){0,2}?(?:retire|deprecat)|(?:retir|deprecat)\\w*\\s+(?:\\S+\\s+){0,2}?${id}`, "i");
  for (const paragraph of notes.split(/\n\s*\n/)) {
    const text = paragraph.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replaceAll("`", "").replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim();
    if (!pattern.test(paragraph.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"))) {
      continue;
    }
    const sentence = text.split(/(?<=\.)\s+/).find((each) => each.includes(model)) ?? text;
    return sentence.length > 240 ? `${sentence.slice(0, 237)}…` : sentence;
  }
  return null;
}
