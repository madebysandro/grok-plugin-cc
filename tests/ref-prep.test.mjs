/**
 * An edit's large source photos go to Grok as prepared copies — up to 1536 px
 * in under 400 KB — instead of being shrunk to 768 px by the Grok CLI.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { generate, lastGeneration, lastPromptLines } from "./companion-assertions.mjs";
import { createSandbox } from "./companion-harness.mjs";
import { PLUGIN_ROOT, cleanup, makeTempDir } from "./helpers.mjs";

const HAS_PILLOW = spawnSync("python3", ["-c", "import PIL"]).status === 0;
const needsPillow = { skip: HAS_PILLOW ? false : "python3 with Pillow not found; reference preparation tests skipped" };
// The sandbox's HOME is a fresh folder: point Python at the real user site, where Pillow may live.
const PYTHON_ENV = HAS_PILLOW
  ? { PYTHONUSERBASE: spawnSync("python3", ["-c", "import site; print(site.getuserbase())"], { encoding: "utf8" }).stdout.trim() }
  : {};
const REFPREP = path.join(PLUGIN_ROOT, "scripts", "refprep.py");

/**
 * Write a smooth picture with Pillow — a gradient, which JPEG shrinks well:
 * `{ size, mode, format, orientation, uncompressed }`. `uncompressed` saves a
 * PNG without compression, a large file with little detail in it.
 */
function picture(file, { size, mode = "RGB", format = "PNG", orientation = null, uncompressed = false }) {
  const script = [
    "import sys",
    "from PIL import Image",
    "file, width, height, mode, fmt, orientation, raw = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4], sys.argv[5], sys.argv[6], sys.argv[7] == '1'",
    "image = Image.new(mode, (width, height))",
    "image.putdata([tuple([x * 255 // width, y * 255 // height, 128, 200][:len(mode)]) for y in range(height) for x in range(width)])",
    "kwargs = {'compress_level': 0} if raw else {}",
    "if orientation != 'none':",
    "    exif = Image.Exif(); exif[0x0112] = int(orientation); kwargs['exif'] = exif.tobytes()",
    "image.save(file, fmt, **kwargs)"
  ].join("\n");
  const [width, height] = size;
  const args = [file, String(width), String(height), mode, format, String(orientation ?? "none"), uncompressed ? "1" : "0"];
  const result = spawnSync("python3", ["-c", script, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return file;
}

/** The source images the newest edit prompt told Grok to use. */
function sentImages(sandbox) {
  const lines = lastPromptLines(sandbox);
  const start = lines.findIndex((line) => line.startsWith("Source image(s)"));
  const images = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("- ")) {
      break;
    }
    images.push(line.slice(2));
  }
  return images;
}

function imageInfo(file) {
  const result = spawnSync("python3", ["-c", "import sys, json; from PIL import Image; i = Image.open(sys.argv[1]); print(json.dumps([i.format, i.size[0], i.size[1]]))", file], {
    encoding: "utf8",
    env: { ...process.env, ...PYTHON_ENV }
  });
  return JSON.parse(result.stdout);
}

test("an edit sends a large photo as a prepared copy of up to 1536 px under 400 KB, removed after the run", needsPillow, async (t) => {
  const sandbox = createSandbox(t);
  const photo = picture(path.join(sandbox.workspace, "photo.png"), { size: [2400, 1600], uncompressed: true });
  assert.ok(fs.statSync(photo).size > 400 * 1024);

  const { stdout } = await generate(sandbox, ["edit", "make it night", "--image", photo], [{ tool: "image_edit" }], { env: PYTHON_ENV });

  const [sent] = sentImages(sandbox);
  assert.notEqual(sent, photo);
  assert.match(sent, /ref-1-photo\.prepared\.jpg$/);
  assert.ok(!fs.existsSync(sent), "the prepared copy only lives for the run");
  assert.match(stdout, /Note: photo\.png went to Grok as a 1536×1024 JPEG of \d+ KB, prepared by the plugin; as it was, the Grok CLI shrinks it to 768 px\./);
  const [prepared] = lastGeneration(sandbox).preparedReferences;
  assert.deepEqual({ ...prepared, bytes: undefined }, { source: "photo.png", width: 1536, height: 1024, bytes: undefined, format: "jpeg" });
  assert.ok(prepared.bytes <= 400 * 1024);
});

test("an edit sends a JPEG or PNG of up to 400 KB as it is, and data: URLs too", needsPillow, async (t) => {
  const sandbox = createSandbox(t);
  const small = picture(path.join(sandbox.workspace, "small.png"), { size: [200, 150] });
  const dataUrl = `data:image/png;base64,${fs.readFileSync(small).toString("base64")}`;

  const { stdout } = await generate(sandbox, ["edit", "merge them", "--image", small, "--image", dataUrl], [{ tool: "image_edit" }], { env: PYTHON_ENV });

  assert.deepEqual(sentImages(sandbox), [small, dataUrl]);
  assert.doesNotMatch(stdout, /prepared by the plugin/);
  assert.ok(!("preparedReferences" in lastGeneration(sandbox)));
});

test("without Python an edit sends the large photo as it is, and says the Grok CLI shrinks it", needsPillow, async (t) => {
  const sandbox = createSandbox(t);
  const photo = picture(path.join(sandbox.workspace, "photo.png"), { size: [1600, 1200], uncompressed: true });

  const { stdout } = await generate(sandbox, ["edit", "make it night", "--image", photo], [{ tool: "image_edit" }], {
    env: { GROK_PLUGIN_PYTHON: path.join(sandbox.workspace, "no-python") }
  });

  assert.deepEqual(sentImages(sandbox), [photo]);
  assert.match(stdout, /Note: photo\.png is over 400 KB or not a JPEG\/PNG, and without Python the plugin cannot prepare it, so the Grok CLI shrinks it to 768 px\./);
});

test("refprep.py turns the photo upright, keeps transparency as PNG, never enlarges, and refuses what cannot fit", needsPillow, (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const run = (input, ...args) => spawnSync("python3", [REFPREP, input, "--output", path.join(dir, "out"), ...args], { encoding: "utf8" });

  // Stored landscape, shown portrait (EXIF orientation 6): the copy is upright.
  const turned = picture(path.join(dir, "turned.jpg"), { size: [2000, 1500], format: "JPEG", orientation: 6 });
  const upright = run(turned);
  assert.equal(upright.status, 0, upright.stderr);
  assert.deepEqual(JSON.parse(upright.stdout), { ...JSON.parse(upright.stdout), width: 1152, height: 1536, format: "jpeg", sourceWidth: 1500, sourceHeight: 2000 });
  assert.deepEqual(imageInfo(path.join(dir, "out")), ["JPEG", 1152, 1536]);

  const clear = picture(path.join(dir, "clear.png"), { size: [400, 300], mode: "RGBA" });
  const png = run(clear);
  assert.equal(png.status, 0, png.stderr);
  assert.equal(JSON.parse(png.stdout).format, "png");
  assert.deepEqual(imageInfo(path.join(dir, "out")).slice(1), [400, 300], "never enlarged");

  const refused = run(turned, "--max-bytes", "1000");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /does not fit in 1000 bytes even at 768 px/);
});
