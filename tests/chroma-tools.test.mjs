import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { lastGeneration } from "./companion-assertions.mjs";
import { createSandbox } from "./companion-harness.mjs";

const HAS_IMAGING = spawnSync("python3", ["-c", "import PIL, numpy, scipy"]).status === 0;
const needsImaging = { skip: HAS_IMAGING ? false : "python3 with Pillow, numpy and scipy not found; cutout/split tests skipped" };

// The sandbox gives the companion a temporary HOME, which would hide libraries
// installed with `pip install --user`; point Python back at the real ones.
const PYTHON_ENV = HAS_IMAGING
  ? { PYTHONUSERBASE: spawnSync("python3", ["-c", "import site; print(site.getuserbase())"], { encoding: "utf8" }).stdout.trim() }
  : {};

/** Run the companion with the user's Python libraries visible, plus any `env`. */
function runTool(sandbox, args, env = {}) {
  return sandbox.run(args, { env: { ...PYTHON_ENV, ...env } });
}

const GREEN = [0, 255, 0];

/** Draw a synthetic image with Pillow: `{ size, background, shapes: [{ box, fill, kind? }] }`. */
function drawImage(file, spec) {
  const script = [
    "import json, sys",
    "from PIL import Image, ImageDraw",
    "spec = json.loads(sys.argv[2])",
    "img = Image.new('RGB', tuple(spec['size']), tuple(spec['background']))",
    "draw = ImageDraw.Draw(img)",
    "for shape in spec.get('shapes', []):",
    "    (draw.ellipse if shape.get('kind') == 'ellipse' else draw.rectangle)(shape['box'], fill=tuple(shape['fill']))",
    "img.save(sys.argv[1])"
  ].join("\n");
  const result = spawnSync("python3", ["-c", script, file, JSON.stringify(spec)], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return file;
}

/** `{ size, mode, pixels }` of an image, with the RGBA value at each `[x, y]` point. */
function readPixels(file, points = []) {
  const script = [
    "import json, sys",
    "from PIL import Image",
    "img = Image.open(sys.argv[1])",
    "rgba = img.convert('RGBA')",
    "points = json.loads(sys.argv[2])",
    "print(json.dumps({'size': list(img.size), 'mode': img.mode, 'pixels': [list(rgba.getpixel(tuple(p))) for p in points]}))"
  ].join("\n");
  const result = spawnSync("python3", ["-c", script, file, JSON.stringify(points)], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

/** A refused run: exit 1 with `pattern` on stderr, and no job or grok-media/ left behind. */
async function assertRefused(sandbox, args, pattern, env = {}) {
  const { code, stdout, stderr } = await runTool(sandbox, args, env);
  assert.equal(code, 1, stderr || stdout);
  assert.match(stderr, pattern);
  assert.equal(fs.existsSync(path.join(sandbox.workspace, "grok-media")), false, "a refused run must not create grok-media/");
  const status = await sandbox.run(["status", "--json"]);
  assert.deepEqual(JSON.parse(status.stdout).jobs, [], "a refused run must not create a job");
}

function mediaFile(sandbox, name) {
  return path.join(sandbox.workspace, "grok-media", name);
}

test("cutout turns a green background transparent and keeps the subject", needsImaging, async (t) => {
  const sandbox = createSandbox(t);
  drawImage(path.join(sandbox.workspace, "apple.png"), {
    size: [120, 90],
    background: GREEN,
    shapes: [{ box: [40, 25, 80, 65], fill: [200, 30, 30] }]
  });

  const { code, stdout, stderr } = await runTool(sandbox, ["cutout", "apple.png"]);

  assert.equal(code, 0, stderr || stdout);
  const { mode, size, pixels } = readPixels(mediaFile(sandbox, "apple-cutout.png"), [[0, 0], [119, 89], [60, 45]]);
  assert.equal(mode, "RGBA");
  assert.deepEqual(size, [120, 90]);
  assert.equal(pixels[0][3], 0);
  assert.equal(pixels[1][3], 0);
  assert.deepEqual(pixels[2], [200, 30, 30, 255]);
  const generation = lastGeneration(sandbox);
  assert.deepEqual([generation.command, generation.key, generation.tolerance, generation.assets[0].tool], ["cutout", "#00FF00", 80, "python"]);
});

test("cutout removes the green spill along the cut edge but not a green subject's own colour", needsImaging, async (t) => {
  const sandbox = createSandbox(t);
  drawImage(path.join(sandbox.workspace, "props.png"), {
    size: [140, 90],
    background: GREEN,
    shapes: [
      // A red box with a 2 px greenish rim, as green light spills onto an edge.
      { box: [38, 23, 82, 67], fill: [150, 200, 40] },
      { box: [40, 25, 80, 65], fill: [200, 30, 30] },
      // A leaf-green block: green on its own, well inside its edges.
      { box: [95, 10, 135, 50], fill: [60, 160, 60] }
    ]
  });

  const { code, stdout, stderr } = await runTool(sandbox, ["cutout", "props.png"]);

  assert.equal(code, 0, stderr || stdout);
  const [rim, leafMiddle] = readPixels(mediaFile(sandbox, "props-cutout.png"), [[38, 45], [115, 30]]).pixels;
  assert.equal(rim[3], 255);
  assert.ok(rim[1] <= Math.max(rim[0], rim[2]), `the rim keeps a green cast: ${rim}`);
  assert.deepEqual(leafMiddle, [60, 160, 60, 255]);
});

test("cutout takes another key colour and a tolerance", needsImaging, async (t) => {
  const sandbox = createSandbox(t);
  drawImage(path.join(sandbox.workspace, "blue.png"), { size: [60, 40], background: [20, 40, 230], shapes: [{ box: [20, 10, 40, 30], fill: [240, 200, 20] }] });
  // Pure green on the right; a darker green, 55 away from it, on the left.
  drawImage(path.join(sandbox.workspace, "dim.png"), {
    size: [60, 40],
    background: GREEN,
    shapes: [{ box: [0, 0, 29, 39], fill: [0, 200, 0] }, { box: [25, 10, 35, 30], fill: [240, 30, 30] }]
  });

  assert.equal((await runTool(sandbox, ["cutout", "blue.png", "--key", "#0000FF"])).code, 0);
  assert.equal(readPixels(mediaFile(sandbox, "blue-cutout.png"), [[0, 0]]).pixels[0][3], 0);

  assert.equal((await runTool(sandbox, ["cutout", "dim.png"])).code, 0);
  assert.deepEqual(readPixels(mediaFile(sandbox, "dim-cutout.png"), [[2, 2], [57, 2]]).pixels.map((pixel) => pixel[3]), [0, 0]);
  assert.equal((await runTool(sandbox, ["cutout", "dim.png", "--tolerance", "30", "--name", "dim-tight"])).code, 0);
  const [darker, pure] = readPixels(mediaFile(sandbox, "dim-tight.png"), [[2, 2], [57, 2]]).pixels;
  assert.ok(darker[3] > 0, "a tighter tolerance keeps the darker green");
  assert.equal(pure[3], 0);
});

test("cutout refuses a bad key or tolerance, and an image with no background of that colour", needsImaging, async (t) => {
  const sandbox = createSandbox(t);
  drawImage(path.join(sandbox.workspace, "red.png"), { size: [40, 30], background: [220, 20, 20] });
  drawImage(path.join(sandbox.workspace, "green.png"), { size: [40, 30], background: GREEN });

  await assertRefused(sandbox, ["cutout", "red.png", "--key", "green"], /--key must be a hex colour such as #00FF00/);
  await assertRefused(sandbox, ["cutout", "red.png", "--key", "#12345"], /--key must be a hex colour such as #00FF00/);
  await assertRefused(sandbox, ["cutout", "red.png", "--tolerance", "abc"], /--tolerance must be a number from 0 to 400/);
  await assertRefused(sandbox, ["cutout", "red.png", "--tolerance", "-5"], /--tolerance must be a number from 0 to 400/);
  await assertRefused(sandbox, ["cutout", "red.png"], /no pixel is within 80 of #00FF00/);
  await assertRefused(sandbox, ["cutout", "green.png"], /the whole image is within 80 of #00FF00/);
});

const RED = [210, 30, 30];
const BLUE = [30, 60, 210];
const YELLOW = [230, 200, 20];

/** A green sheet with a red box, a blue disc and a small yellow box, left to right. */
function drawThreeItemSheet(sandbox, name = "sheet.png") {
  return drawImage(path.join(sandbox.workspace, name), {
    size: [300, 100],
    background: GREEN,
    shapes: [
      { box: [20, 30, 70, 70], fill: RED },
      { box: [120, 20, 180, 80], fill: BLUE, kind: "ellipse" },
      { box: [230, 40, 260, 60], fill: YELLOW }
    ]
  });
}

/**
 * What a cut-out item looks like: `{ size, mode, corners, colours, bottom,
 * opaqueWidth }` — its corner pixels, the distinct colours of its opaque
 * pixels, the lowest row holding one, and how wide the opaque part is.
 */
function itemSummary(file) {
  const script = [
    "import json, sys",
    "import numpy as np",
    "from PIL import Image",
    "img = Image.open(sys.argv[1])",
    "rgba = np.asarray(img.convert('RGBA'))",
    "h, w = rgba.shape[:2]",
    "opaque = rgba[..., 3] == 255",
    "rows = np.nonzero(opaque.any(axis=1))[0]",
    "cols = np.nonzero(opaque.any(axis=0))[0]",
    "print(json.dumps({",
    "  'size': [w, h], 'mode': img.mode,",
    "  'corners': [rgba[y, x].tolist() for y, x in ((0, 0), (0, w - 1), (h - 1, 0), (h - 1, w - 1))],",
    "  'colours': sorted({tuple(p) for p in rgba[opaque][:, :3].tolist()}),",
    "  'bottom': int(rows[-1]) if len(rows) else None,",
    "  'opaqueWidth': int(cols[-1] - cols[0] + 1) if len(cols) else 0}))"
  ].join("\n");
  const result = spawnSync("python3", ["-c", script, file], { encoding: "utf8", env: { ...process.env, ...PYTHON_ENV } });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("split turns three items into three transparent PNGs on one canvas, left to right", needsImaging, async (t) => {
  const sandbox = createSandbox(t);
  drawThreeItemSheet(sandbox);

  const { code, stdout, stderr } = await runTool(sandbox, ["split", "sheet.png"]);

  assert.equal(code, 0, stderr || stdout);
  const items = [1, 2, 3].map((n) => itemSummary(mediaFile(sandbox, `sheet-item-${n}.png`)));
  assert.deepEqual(items.map((item) => item.colours), [[RED], [BLUE], [YELLOW]]);
  assert.ok(items.every((item) => item.mode === "RGBA" && item.corners.every((corner) => corner[3] === 0)));
  assert.equal(new Set(items.map((item) => item.size.join("x"))).size, 1, "every item must share one canvas size");
  assert.equal(new Set(items.map((item) => item.bottom)).size, 1, "items stand on one baseline");
  assert.equal(fs.existsSync(mediaFile(sandbox, "sheet-item-4.png")), false);
});

test("split --expect refuses a different count, and split refuses an item cut off by the sheet's edge", needsImaging, async (t) => {
  const sandbox = createSandbox(t);
  drawThreeItemSheet(sandbox);
  drawImage(path.join(sandbox.workspace, "edge.png"), {
    size: [200, 100],
    background: GREEN,
    shapes: [{ box: [0, 30, 40, 70], fill: RED }, { box: [120, 30, 160, 70], fill: BLUE }]
  });

  await assertRefused(sandbox, ["split", "sheet.png", "--expect", "2"], /found 3 items, expected 2/);
  await assertRefused(sandbox, ["split", "sheet.png", "--expect", "zero"], /--expect must be a whole number of items/);
  await assertRefused(sandbox, ["split", "edge.png"], /item 1 touches the edge of the sheet/);

  assert.equal((await runTool(sandbox, ["split", "sheet.png", "--expect", "3"])).code, 0);
});

test("split keeps a detached piece with its item and drops specks", needsImaging, async (t) => {
  const sandbox = createSandbox(t);
  drawImage(path.join(sandbox.workspace, "props.png"), {
    size: [400, 120],
    background: GREEN,
    shapes: [
      { box: [40, 40, 100, 90], fill: RED },
      // A plume 4 px off the red box: well under 3% of the sheet's width.
      { box: [104, 45, 108, 50], fill: RED },
      { box: [200, 40, 260, 90], fill: BLUE },
      // A one-pixel speck of noise.
      { box: [330, 60, 330, 60], fill: YELLOW }
    ]
  });

  const { code, stdout, stderr } = await runTool(sandbox, ["split", "props.png", "--expect", "2"]);

  assert.equal(code, 0, stderr || stdout);
  const [first, second] = [1, 2].map((n) => itemSummary(mediaFile(sandbox, `props-item-${n}.png`)));
  assert.deepEqual([first.colours, second.colours], [[RED], [BLUE]]);
  assert.equal(first.opaqueWidth, 69, "the plume belongs to the red box");
});

test("split numbers a grid row by row, left to right", needsImaging, async (t) => {
  const sandbox = createSandbox(t);
  const WHITE = [240, 240, 240];
  drawImage(path.join(sandbox.workspace, "grid.png"), {
    size: [240, 200],
    background: GREEN,
    shapes: [
      { box: [30, 30, 80, 80], fill: RED },
      { box: [150, 40, 200, 90], fill: BLUE },
      { box: [40, 120, 90, 170], fill: YELLOW },
      { box: [160, 125, 210, 175], fill: WHITE }
    ]
  });

  const { code, stdout, stderr } = await runTool(sandbox, ["split", "grid.png", "--expect", "4"]);

  assert.equal(code, 0, stderr || stdout);
  const colours = [1, 2, 3, 4].map((n) => itemSummary(mediaFile(sandbox, `grid-item-${n}.png`)).colours);
  assert.deepEqual(colours, [[RED], [BLUE], [YELLOW], [WHITE]]);
});

test("split finds a flat background of any colour from the corners, or takes --bg", needsImaging, async (t) => {
  const sandbox = createSandbox(t);
  const WHITE = [250, 250, 250];
  drawImage(path.join(sandbox.workspace, "white.png"), {
    size: [200, 100],
    background: WHITE,
    shapes: [{ box: [30, 30, 70, 70], fill: RED }, { box: [120, 30, 160, 70], fill: BLUE }]
  });
  // Green on the left, blue on the right: no one background colour.
  drawImage(path.join(sandbox.workspace, "two-tone.png"), {
    size: [200, 100],
    background: GREEN,
    shapes: [{ box: [100, 0, 199, 99], fill: [0, 0, 255] }, { box: [30, 30, 70, 70], fill: RED }]
  });

  assert.equal((await runTool(sandbox, ["split", "white.png", "--expect", "2"])).code, 0);
  assert.equal((await runTool(sandbox, ["split", "white.png", "--bg", "#FAFAFA", "--expect", "2", "--name", "explicit"])).code, 0);
  assert.deepEqual(itemSummary(mediaFile(sandbox, "explicit-1.png")).colours, [RED]);

  const fresh = createSandbox(t);
  fs.copyFileSync(path.join(sandbox.workspace, "two-tone.png"), path.join(fresh.workspace, "two-tone.png"));
  await assertRefused(fresh, ["split", "two-tone.png"], /the sheet's corners are not one colour/);
  await assertRefused(fresh, ["split", "two-tone.png", "--bg", "greenish"], /--bg must be auto or a hex colour such as #00FF00/);
});

test("cutout and split take @last and job:<id>[#N], and every split item stays reachable", needsImaging, async (t) => {
  const sandbox = createSandbox(t);
  drawThreeItemSheet(sandbox);
  const jobOf = (result) => {
    assert.equal(result.code, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout).jobId;
  };

  const cutoutJob = jobOf(await runTool(sandbox, ["cutout", "sheet.png", "--json"]));
  // @last is the cut-out sheet; its cleared background reads as black.
  const splitJob = jobOf(await runTool(sandbox, ["split", "@last", "--expect", "3", "--json"]));

  const { jobs } = JSON.parse((await sandbox.run(["status", "--json"])).stdout);
  assert.deepEqual(
    jobs.find((job) => job.id === splitJob).files,
    [1, 2, 3].map((n) => mediaFile(sandbox, `sheet-cutout-item-${n}.png`))
  );

  jobOf(await runTool(sandbox, ["split", `job:${splitJob}#3`, "--expect", "1", "--name", "third", "--json"]));
  assert.deepEqual(itemSummary(mediaFile(sandbox, "third-1.png")).colours, [YELLOW]);

  jobOf(await runTool(sandbox, ["cutout", `job:${cutoutJob}`, "--key", "#000000", "--name", "again", "--json"]));
  assert.equal(readPixels(mediaFile(sandbox, "again.png"), [[0, 0]]).pixels[0][3], 0);
});

test("cutout and split say what is missing when Python or a library is, and install nothing", async (t) => {
  const sandbox = createSandbox(t);
  fs.writeFileSync(path.join(sandbox.workspace, "sheet.png"), "not really a png");
  const fakePython = path.join(sandbox.workspace, "..", "fake-python");
  // Answers like chroma.py does when scipy is not importable.
  fs.writeFileSync(fakePython, `#!/bin/sh\nprintf '{"missing": ["scipy"]}' >&2\nexit 3\n`, { mode: 0o755 });

  await assertRefused(sandbox, ["split", "sheet.png"], /lacks scipy\. Install with `.+ -m pip install scipy`/, { GROK_PLUGIN_PYTHON: fakePython });
  await assertRefused(sandbox, ["cutout", "sheet.png"], /GROK_PLUGIN_PYTHON is set to .+no-such-python, which is not an executable/, {
    GROK_PLUGIN_PYTHON: path.join(sandbox.workspace, "no-such-python")
  });
  await assertRefused(sandbox, ["cutout", "sheet.png", "--expect", "2"], /--expect does not apply to cutout/);
});

test("a crash inside chroma.py is a failure (exit 2), not a refusal", async (t) => {
  const sandbox = createSandbox(t);
  fs.writeFileSync(path.join(sandbox.workspace, "sheet.png"), "not really a png");
  const crashing = path.join(sandbox.workspace, "..", "crashing-python");
  fs.writeFileSync(crashing, `#!/bin/sh\necho 'Traceback: something broke' >&2\nexit 5\n`, { mode: 0o755 });

  const { code, stderr } = await runTool(sandbox, ["cutout", "sheet.png"], { GROK_PLUGIN_PYTHON: crashing });

  assert.equal(code, 2);
  assert.match(stderr, /chroma\.py failed \(exit 5\):\nTraceback: something broke/);
});

test("cutout refuses a file Pillow cannot read with a plain message", needsImaging, async (t) => {
  const sandbox = createSandbox(t);
  fs.writeFileSync(path.join(sandbox.workspace, "broken.png"), "not really a png");

  await assertRefused(sandbox, ["cutout", "broken.png"], /broken\.png is not an image Pillow can read/);
});

test("the options of cutout and split are refused by the generation commands", async (t) => {
  const sandbox = createSandbox(t);

  for (const option of [["--key", "#00FF00"], ["--tolerance", "40"], ["--expect", "3"], ["--bg", "auto"]]) {
    await assertRefused(sandbox, ["image", "a red kite", ...option], new RegExp(`${option[0]} does not apply to image; it is for (cutout|split)`));
  }
});

test("cutout removes spill deeper into a soft edge on a large image", needsImaging, async (t) => {
  const sandbox = createSandbox(t);
  // On a 1000 px image, an 8 px greenish rim: a blurred edge or glow, not a 1-2 px fringe.
  drawImage(path.join(sandbox.workspace, "soft.png"), {
    size: [1000, 1000],
    background: GREEN,
    shapes: [
      { box: [300, 300, 700, 700], fill: [150, 200, 40] },
      { box: [308, 308, 692, 692], fill: [200, 30, 30] }
    ]
  });

  assert.equal((await runTool(sandbox, ["cutout", "soft.png"])).code, 0);
  const [deepRim] = readPixels(mediaFile(sandbox, "soft-cutout.png"), [[306, 500]]).pixels;
  assert.ok(deepRim[1] <= Math.max(deepRim[0], deepRim[2]), `spill left 7 px into the edge: ${deepRim}`);
});

test("split uses the transparency of a sheet that is already cut out, dark items included", needsImaging, async (t) => {
  const sandbox = createSandbox(t);
  const NAVY = [20, 20, 70];
  drawImage(path.join(sandbox.workspace, "dark.png"), {
    size: [300, 100],
    background: GREEN,
    shapes: [{ box: [30, 30, 80, 70], fill: NAVY }, { box: [180, 25, 240, 75], fill: [5, 5, 5] }]
  });

  assert.equal((await runTool(sandbox, ["cutout", "dark.png"])).code, 0);
  const { code, stdout, stderr } = await runTool(sandbox, ["split", "@last", "--expect", "2"]);

  assert.equal(code, 0, stderr || stdout);
  assert.deepEqual(itemSummary(mediaFile(sandbox, "dark-cutout-item-1.png")).colours, [NAVY]);
});

test("split keeps same-sized items apart even when the gaps between them are narrow", needsImaging, async (t) => {
  const sandbox = createSandbox(t);
  // A four-view turnaround: 26 px gaps on a 1000 px sheet, under 3% of its width.
  drawImage(path.join(sandbox.workspace, "turnaround.png"), {
    size: [1000, 400],
    background: GREEN,
    shapes: [0, 1, 2, 3].map((n) => ({ box: [60 + n * 230, 60, 264 + n * 230, 340], fill: [RED, BLUE, YELLOW, [240, 240, 240]][n] }))
  });

  const { code, stdout, stderr } = await runTool(sandbox, ["split", "turnaround.png", "--expect", "4"]);

  assert.equal(code, 0, stderr || stdout);
});
