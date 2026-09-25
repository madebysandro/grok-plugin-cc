import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertRejectedBeforeGrok, lastGeneration } from "./companion-assertions.mjs";
import { createSandbox } from "./companion-harness.mjs";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HAS_CHROME = fs.existsSync(CHROME);
const HAS_FFMPEG = ["ffmpeg", "ffprobe"].every((tool) => spawnSync(tool, ["-version"]).status === 0);
const SYSTEM_FONT = "/System/Library/Fonts/Supplemental/Courier New.ttf";
const needsFfmpeg = { skip: HAS_FFMPEG ? false : "ffmpeg/ffprobe not found; overlay tests that make pictures skipped" };
const needsChrome = {
  skip: !HAS_CHROME ? `Chrome not found at ${CHROME}; overlay render tests skipped` : !HAS_FFMPEG ? "ffmpeg/ffprobe not found; overlay render tests skipped" : false
};

function ffmpeg(args) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function dimensions(file) {
  const result = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split(",").map(Number);
}

/** A plain base picture of an odd size, so a render at a default viewport would show. */
function makeBase(dir, name = "base.png", size = "333x201") {
  const file = path.join(dir, name);
  ffmpeg(["-f", "lavfi", "-i", `color=c=0x336699:s=${size}`, "-frames:v", "1", file]);
  return file;
}

/** The average colour of a region of an image, as `[r, g, b]`. */
function regionColour(file, { x, y, width, height }) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `crop=${width}:${height}:${x}:${y},scale=1:1`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  assert.equal(result.status, 0, String(result.stderr));
  return [...result.stdout.subarray(0, 3)];
}

/** Write a brand kit into the workspace; `files` are copied or written next to it. */
function writeBrand(sandbox, brand, files = {}) {
  const dir = path.join(sandbox.workspace, "brand");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    const target = path.join(dir, name);
    if (Buffer.isBuffer(source) || !fs.existsSync(source)) {
      fs.writeFileSync(target, source);
    } else {
      fs.copyFileSync(source, target);
    }
  }
  fs.writeFileSync(path.join(dir, "brand.json"), JSON.stringify(brand));
  return "brand/brand.json";
}

async function runOverlay(sandbox, args, { env } = {}) {
  const result = await sandbox.run(["overlay", ...args], { env });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.deepEqual(sandbox.grokCalls(), [], "overlay must never run grok");
  return result;
}

test("overlay renders a PNG at the base image's exact size, whatever its shape", needsChrome, async (t) => {
  const sandbox = createSandbox(t);

  for (const [name, size] of [["odd.png", "333x201"], ["square.png", "1024x1024"]]) {
    makeBase(sandbox.workspace, name, size);
    await runOverlay(sandbox, ["--image", name, "--text", "Pão de queijo – R$ 5,90", "--sub", "só hoje"]);
    const output = path.join(sandbox.workspace, "grok-media", name.replace(".png", "-overlay.png"));
    assert.deepEqual(dimensions(output), size.split("x").map(Number));
  }
});

test("a brand's colours and embedded font are what gets drawn", { skip: needsChrome.skip || (!fs.existsSync(SYSTEM_FONT) && `${SYSTEM_FONT} missing; brand font test skipped`) }, async (t) => {
  const sandbox = createSandbox(t);
  makeBase(sandbox.workspace, "base.png", "600x400");
  const logo = path.join(sandbox.workspace, "logo.png");
  ffmpeg(["-f", "lavfi", "-i", "color=c=yellow:s=40x40", "-frames:v", "1", logo]);
  const brand = writeBrand(
    sandbox,
    { name: "Test", colors: { primary: "#FF0000", text: "#00FF00" }, fonts: { heading: "Brand.ttf" }, logo: "logo.png" },
    { "Brand.ttf": SYSTEM_FONT, "logo.png": logo }
  );

  const { stdout } = await runOverlay(sandbox, ["--image", "base.png", "--text", "SALE", "--style", "bold", "--brand", brand, "--json"]);

  assert.deepEqual(JSON.parse(stdout).notes, [], "the embedded font should load");
  const output = path.join(sandbox.workspace, "grok-media", "base-overlay.png");
  // The bold band sits at the bottom, in the brand's primary colour, left of the centred text.
  const [red, green, blue] = regionColour(output, { x: 40, y: 330, width: 20, height: 10 });
  assert.ok(red > 200 && green < 60 && blue < 60, `expected the red band, got rgb(${red}, ${green}, ${blue})`);
  const generation = lastGeneration(sandbox);
  assert.deepEqual([generation.command, generation.brand, generation.style, generation.assets[0].tool], ["overlay", "Test", "bold", "chrome"]);
});

test("a brand font that does not load is reported, not silently swapped", needsChrome, async (t) => {
  const sandbox = createSandbox(t);
  makeBase(sandbox.workspace);
  const brand = writeBrand(sandbox, { fonts: { heading: "Broken.ttf" } }, { "Broken.ttf": Buffer.from("not a font") });

  const { stdout } = await runOverlay(sandbox, ["--image", "base.png", "--text", "Hello", "--brand", brand]);

  assert.match(stdout, /Note: the font "Broken\.ttf" did not load .*fallback font was used\./);
});

test("overlay takes @last and job:<id>, and its PNG becomes the next @last", needsChrome, async (t) => {
  const sandbox = createSandbox(t);
  makeBase(sandbox.workspace, "wide.png", "320x180");
  const reframe = await sandbox.run(["reframe", "wide.png", "--aspect", "1:1", "--json"]);
  assert.equal(reframe.code, 0, reframe.stderr);
  const { jobId } = JSON.parse(reframe.stdout);

  await runOverlay(sandbox, ["--image", "@last", "--text", "One"]);
  await runOverlay(sandbox, ["--image", `job:${jobId}`, "--text", "Two", "--name", "two"]);

  const media = (name) => path.join(sandbox.workspace, "grok-media", name);
  assert.deepEqual(dimensions(media("wide-1x1-crop-overlay.png")), [180, 180]);
  assert.deepEqual(dimensions(media("two.png")), [180, 180]);
  const status = JSON.parse((await sandbox.run(["status", "--json"])).stdout);
  assert.deepEqual(status.jobs[0].files, [media("two.png")]);
});

// Every refusal happens before Chrome is looked for or started, so this needs no Chrome.
test("overlay refuses bad input before Chrome starts", needsFfmpeg, async (t) => {
  const sandbox = createSandbox(t);
  makeBase(sandbox.workspace);
  fs.writeFileSync(path.join(sandbox.workspace, "clip.mp4"), "video");
  const badBrand = writeBrand(sandbox, { colors: { primary: "red; } body { display: none" } });

  const refusals = [
    [["--image", "base.png"], /overlay needs --text\./],
    [["--text", "Hi"], /Usage: \/grok:overlay --image <image>/],
    [["--image", "base.png", "--image", "base.png", "--text", "Hi"], /Usage: \/grok:overlay/],
    [["base.png", "--image", "base.png", "--text", "Hi"], /Usage: \/grok:overlay/],
    [["--image", "clip.mp4", "--text", "Hi"], /clip\.mp4 is a video; overlay needs an image\./],
    [["--image", "base.png", "--text", "Hi", "--position", "left"], /--position left is not an option\. Use one of: top, center, bottom\./],
    [["--image", "base.png", "--text", "Hi", "--style", "neon"], /--style neon is not an option\. Use one of: clean, bold, glass\./],
    [["--image", "base.png", "--text", "Hi", "--brand", "nope.json"], /Brand file not found: .*nope\.json/],
    [["--image", "base.png", "--text", "Hi", "--brand", badBrand], /colors\.primary .* is not a colour/],
    [["--image", "base.png", "--text", "Hi", "--aspect", "1:1"], /--aspect does not apply to overlay\./]
  ];
  for (const [args, pattern] of refusals) {
    await assertRejectedBeforeGrok(sandbox, ["overlay", ...args], pattern);
  }
  assert.ok(!fs.existsSync(path.join(sandbox.workspace, "grok-media")));
});

test("without a usable Chrome, overlay says how to point at one", async (t) => {
  const sandbox = createSandbox(t);
  fs.writeFileSync(path.join(sandbox.workspace, "base.png"), "png");

  const { code, stderr } = await sandbox.run(["overlay", "--image", "base.png", "--text", "Hi"], {
    env: { CHROME_PATH: path.join(sandbox.workspace, "no-chrome") }
  });

  assert.equal(code, 1, stderr);
  assert.match(stderr, /CHROME_PATH is set to .*no-chrome, which is not an executable file\./);
  assert.ok(!fs.existsSync(path.join(sandbox.workspace, "grok-media")), "a missing Chrome is found before anything is written");
  assert.deepEqual(JSON.parse((await sandbox.run(["status", "--json"])).stdout).jobs, []);
});

test("Chrome starts with a mock keychain and a throwaway profile, never touching the user's", async (t) => {
  const sandbox = createSandbox(t);
  fs.writeFileSync(path.join(sandbox.workspace, "base.png"), "png");
  const argsFile = path.join(sandbox.workspace, "chrome.args");
  const fakeChrome = path.join(sandbox.workspace, "fake-chrome");
  fs.writeFileSync(fakeChrome, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nexit 1\n`, { mode: 0o755 });

  const { code, stderr } = await sandbox.run(["overlay", "--image", "base.png", "--text", "Hi"], { env: { CHROME_PATH: fakeChrome } });

  assert.equal(code, 2, stderr);
  const args = fs.readFileSync(argsFile, "utf8").trim().split("\n");
  // Without the mock keychain, macOS shows a "Keychain Not Found" dialog whose default button resets the login keychain.
  for (const flag of ["--headless=new", "--use-mock-keychain", "--no-first-run", "--disable-sync", "--disable-extensions", "--disable-background-networking"]) {
    assert.ok(args.includes(flag), `Chrome must be started with ${flag}; got ${args.join(" ")}`);
  }
  const profile = args.find((arg) => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
  assert.ok(profile && !profile.startsWith(os.homedir()), `the profile must be a throwaway one, got ${profile}`);
  assert.ok(!fs.existsSync(profile), "the throwaway profile is removed afterwards");
});

test("a Chrome that hangs is killed at --timeout, and nothing is kept", async (t) => {
  const sandbox = createSandbox(t);
  fs.writeFileSync(path.join(sandbox.workspace, "base.png"), "png");
  const pidFile = path.join(sandbox.workspace, "chrome.pid");
  const hanging = path.join(sandbox.workspace, "hanging-chrome");
  fs.writeFileSync(hanging, `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`, { mode: 0o755 });

  // Two seconds leaves the fake time to start and record its pid even on a loaded machine.
  const { code, stderr } = await sandbox.run(["overlay", "--image", "base.png", "--text", "Hi", "--timeout", "2"], {
    env: { CHROME_PATH: hanging }
  });

  assert.equal(code, 2, stderr);
  assert.match(stderr, /Chrome did not finish rendering within 2s\./);
  // On a loaded machine the fake may be killed before it records its pid; either way it must not be running.
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the hung Chrome must be killed");
  }
  assert.deepEqual(fs.readdirSync(path.join(sandbox.workspace, "grok-media")), []);
  assert.deepEqual(JSON.parse((await sandbox.run(["status", "--json"])).stdout).jobs, []);
});
