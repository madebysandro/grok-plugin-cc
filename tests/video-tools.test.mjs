import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { assertRejectedBeforeGrok, generate, lastGeneration, lastPromptLines } from "./companion-assertions.mjs";
import { createSandbox } from "./companion-harness.mjs";

const HAS_FFMPEG = ["ffmpeg", "ffprobe"].every((tool) => spawnSync(tool, ["-version"]).status === 0);
const needsFfmpeg = { skip: HAS_FFMPEG ? false : "ffmpeg/ffprobe not found on PATH; local video tool tests skipped" };
const HAS_VP9 = HAS_FFMPEG && spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout.includes("libvpx-vp9");
const needsVp9 = { skip: HAS_VP9 ? false : "ffmpeg without libvpx-vp9; WebM input test skipped" };

function ffmpeg(args) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

/** `ffprobe` of a file: `{ streams, format }`. */
function probe(file) {
  const result = spawnSync(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "stream=index,codec_type,codec_name,width,height,pix_fmt,profile:stream_disposition=attached_pic:format=duration",
      "-of", "json",
      file
    ],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function dimensions(file) {
  const video = probe(file).streams.find((stream) => stream.codec_type === "video");
  return [video.width, video.height];
}

/** Raw RGB pixels of an image, or of one `{ x, y, width, height }` region of it. */
function rgbPixels(file, region) {
  const crop = region ? ["-vf", `crop=${region.width}:${region.height}:${region.x}:${region.y}`] : [];
  const result = spawnSync("ffmpeg", ["-v", "error", "-i", file, ...crop, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
}

/** The average colour of an image (or of a region of it), as `[r, g, b]`. */
function averageColour(file, region) {
  const pixels = rgbPixels(file, region);
  const sums = [0, 0, 0];
  for (let index = 0; index < pixels.length; index += 1) {
    sums[index % 3] += pixels[index];
  }
  return sums.map((sum) => Math.round(sum / (pixels.length / 3)));
}

/** MD5 of a file's main video bitstream, copied out untouched: equal only if nothing was re-encoded. */
function videoBitstreamMd5(file) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:V:0", "-c", "copy", "-f", "md5", "-"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/**
 * A short H.264 clip like Grok's: baseline profile, AAC audio, and optionally
 * the MJPEG cover picture Grok attaches as a second video stream.
 * `lastColour` makes the final frames a different colour from the rest;
 * `audioSeconds` lets the sound run past the picture; `audioFirst` stores the
 * audio stream before the video one.
 */
function makeClip(
  dir,
  name,
  { size = "320x240", rate = 24, seconds = 1, audio = true, audioSeconds = seconds, audioFirst = false, cover = false, lastColour = null } = {}
) {
  const file = path.join(dir, name);
  const args = [];
  const videoMaps = [];
  if (lastColour) {
    args.push("-f", "lavfi", "-i", `color=c=red:s=${size}:r=${rate}:d=${seconds - 2 / rate}`);
    args.push("-f", "lavfi", "-i", `color=c=${lastColour}:s=${size}:r=${rate}:d=${2 / rate}`);
    args.push("-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]");
    videoMaps.push("-map", "[v]");
  } else {
    args.push("-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${rate}:duration=${seconds}`);
    videoMaps.push("-map", "0:v");
  }
  let next = lastColour ? 2 : 1;
  const audioMaps = [];
  if (audio) {
    args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${audioSeconds}`);
    audioMaps.push("-map", `${next}:a`);
    next += 1;
  }
  const coverMaps = [];
  if (cover) {
    const coverFile = path.join(dir, `${name}.cover.png`);
    ffmpeg(["-f", "lavfi", "-i", "color=c=lime:s=64x64", "-frames:v", "1", coverFile]);
    args.push("-i", coverFile);
    coverMaps.push("-map", `${next}:v`);
  }
  const maps = audioFirst ? [...audioMaps, ...videoMaps, ...coverMaps] : [...videoMaps, ...audioMaps, ...coverMaps];
  ffmpeg([
    ...args,
    ...maps,
    "-c:v:0", "libx264", "-profile:v:0", "baseline", "-pix_fmt:v:0", "yuv420p",
    ...(cover ? ["-c:v:1", "mjpeg", "-disposition:v:1", "attached_pic"] : []),
    ...(audio ? ["-c:a", "aac"] : []),
    file
  ]);
  return file;
}

/** A PNG whose left half is red and right half blue (or top/bottom, when `split` is "vertical"). */
function makeTwoToneImage(dir, name, { size = "320x180", split = "horizontal" } = {}) {
  const file = path.join(dir, name);
  const [width, height] = size.split("x").map(Number);
  const half = split === "horizontal" ? `${width / 2}x${height}` : `${width}x${height / 2}`;
  const stack = split === "horizontal" ? "hstack" : "vstack";
  ffmpeg([
    "-f", "lavfi", "-i", `color=c=red:s=${half}`,
    "-f", "lavfi", "-i", `color=c=blue:s=${half}`,
    "-filter_complex", `[0:v][1:v]${stack}=inputs=2`,
    "-frames:v", "1", file
  ]);
  return file;
}

/** Run a local tool that should succeed, checking it never ran grok. */
async function runTool(sandbox, args) {
  const result = await sandbox.run(args);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.deepEqual(sandbox.grokCalls(), [], "local tools must never run grok");
  return result;
}

/** The job id a local tool reports with --json. */
async function runToolForJob(sandbox, args) {
  return JSON.parse((await runTool(sandbox, [...args, "--json"])).stdout).jobId;
}

function mediaPath(sandbox, name) {
  return path.join(sandbox.workspace, "grok-media", name);
}

function assertNoOutputDir(sandbox) {
  assert.ok(!fs.existsSync(path.join(sandbox.workspace, "grok-media")), "a refused run must not create grok-media/");
}

test("last-frame saves the clip's real last frame as a PNG, ignoring the cover picture", needsFfmpeg, async (t) => {
  const sandbox = createSandbox(t);
  makeClip(sandbox.workspace, "clip.mp4", { cover: true, lastColour: "blue" });

  await runTool(sandbox, ["last-frame", "clip.mp4"]);

  const frame = mediaPath(sandbox, "clip-last-frame.png");
  const [video] = probe(frame).streams;
  assert.deepEqual([video.codec_name, video.width, video.height], ["png", 320, 240]);
  const [red, green, blue] = averageColour(frame);
  assert.ok(blue > 200 && red < 60 && green < 60, `expected the blue last frame, got rgb(${red}, ${green}, ${blue})`);
});

test("last-frame finds the picture's end even when the sound runs longer", needsFfmpeg, async (t) => {
  const sandbox = createSandbox(t);
  makeClip(sandbox.workspace, "clip.mp4", { lastColour: "blue", audioSeconds: 3 });

  await runTool(sandbox, ["last-frame", "clip.mp4"]);

  const [red, , blue] = averageColour(mediaPath(sandbox, "clip-last-frame.png"));
  assert.ok(blue > 200 && red < 60, `expected the blue last frame, got ${red}/${blue}`);
});

test("mute drops the audio and the cover picture without re-encoding the video", needsFfmpeg, async (t) => {
  const sandbox = createSandbox(t);
  const clip = makeClip(sandbox.workspace, "clip.mp4", { cover: true });

  await runTool(sandbox, ["mute", "clip.mp4"]);

  const muted = mediaPath(sandbox, "clip-muted.mp4");
  const { streams, format } = probe(muted);
  assert.deepEqual(streams.map((stream) => [stream.codec_type, stream.codec_name]), [["video", "h264"]]);
  assert.equal(videoBitstreamMd5(muted), videoBitstreamMd5(clip));
  assert.ok(Math.abs(Number(format.duration) - 1) < 0.1, `duration ${format.duration}`);
});

test("concat joins compatible clips without re-encoding, leaving the covers out", needsFfmpeg, async (t) => {
  const sandbox = createSandbox(t);
  makeClip(sandbox.workspace, "a.mp4", { cover: true });
  makeClip(sandbox.workspace, "b.mp4", { cover: true });

  await runTool(sandbox, ["concat", "a.mp4", "b.mp4"]);

  const { streams, format } = probe(mediaPath(sandbox, "a-concat.mp4"));
  // Re-encoding with libx264's defaults would give the High profile; copying keeps the clips' baseline.
  assert.deepEqual(
    streams.map((stream) => [stream.codec_type, stream.codec_name, stream.profile]),
    [["video", "h264", "Constrained Baseline"], ["audio", "aac", "LC"]]
  );
  assert.ok(Math.abs(Number(format.duration) - 2) < 0.15, `duration ${format.duration}`);
});

test("concat refuses clips that differ, and --reencode matches them to the first", needsFfmpeg, async (t) => {
  const sandbox = createSandbox(t);
  makeClip(sandbox.workspace, "a.mp4");
  makeClip(sandbox.workspace, "b.mp4", { size: "160x120", audio: false, cover: true });

  await assertRejectedBeforeGrok(sandbox, ["concat", "a.mp4", "b.mp4"], /b\.mp4: 160x120.*no audio.*--reencode/s);
  assertNoOutputDir(sandbox);

  await runTool(sandbox, ["concat", "a.mp4", "b.mp4", "--reencode"]);

  const { streams, format } = probe(mediaPath(sandbox, "a-concat.mp4"));
  assert.deepEqual(
    streams.map((stream) => [stream.codec_type, stream.codec_name, stream.width, stream.height]),
    [["video", "h264", 320, 240], ["audio", "aac", undefined, undefined]]
  );
  assert.ok(Math.abs(Number(format.duration) - 2) < 0.15, `duration ${format.duration}`);
});

test("concat refuses clips whose streams come in another order, which copying would scramble", needsFfmpeg, async (t) => {
  const sandbox = createSandbox(t);
  makeClip(sandbox.workspace, "a.mp4");
  makeClip(sandbox.workspace, "b.mp4", { audioFirst: true });

  await assertRejectedBeforeGrok(sandbox, ["concat", "a.mp4", "b.mp4"], /b\.mp4: .*audio #0, video #1.*--reencode/s);

  await runTool(sandbox, ["concat", "a.mp4", "b.mp4", "--reencode"]);
  assert.ok(Math.abs(Number(probe(mediaPath(sandbox, "a-concat.mp4")).format.duration) - 2) < 0.15);
});

test("reframe --mode crop cuts an image to the new ratio, on the side --anchor names", needsFfmpeg, async (t) => {
  const sandbox = createSandbox(t);
  makeTwoToneImage(sandbox.workspace, "wide.png");

  await runTool(sandbox, ["reframe", "wide.png", "--aspect", "9:16"]);
  await runTool(sandbox, ["reframe", "wide.png", "--aspect", "1:1", "--anchor", "left"]);
  await runTool(sandbox, ["reframe", "wide.png", "--aspect", "1:1", "--anchor", "right"]);

  assert.deepEqual(dimensions(mediaPath(sandbox, "wide-9x16-crop.png")), [101, 180]);
  assert.deepEqual(dimensions(mediaPath(sandbox, "wide-1x1-crop.png")), [180, 180]);
  const [leftRed, , leftBlue] = averageColour(mediaPath(sandbox, "wide-1x1-crop.png"));
  const [rightRed, , rightBlue] = averageColour(mediaPath(sandbox, "wide-1x1-crop-2.png"));
  assert.ok(leftRed > 200 && leftBlue < 60, `--anchor left should keep the red side, got ${leftRed}/${leftBlue}`);
  assert.ok(rightBlue > 200 && rightRed < 60, `--anchor right should keep the blue side, got ${rightRed}/${rightBlue}`);
});

test("reframe --mode pad fills the new ratio with a blurred copy of the picture, not black bars", needsFfmpeg, async (t) => {
  const sandbox = createSandbox(t);
  makeTwoToneImage(sandbox.workspace, "wide.png");

  await runTool(sandbox, ["reframe", "wide.png", "--aspect", "1:1", "--mode", "pad", "--anchor", "top"]);

  const padded = mediaPath(sandbox, "wide-1x1-pad.png");
  assert.deepEqual(dimensions(padded), [320, 320]);
  // The picture sits at the top; the band below it is background, which must come from the picture.
  const [red, green, blue] = averageColour(padded, { x: 0, y: 200, width: 320, height: 100 });
  assert.ok(red + blue > 200, `the padding should be the blurred picture, got rgb(${red}, ${green}, ${blue})`);
});

test("reframe --mode pad leaves an RGB picture's own pixels exactly as they were", needsFfmpeg, async (t) => {
  const sandbox = createSandbox(t);
  const source = path.join(sandbox.workspace, "detail.png");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x180", "-frames:v", "1", source]);

  await runTool(sandbox, ["reframe", "detail.png", "--aspect", "1:1", "--mode", "pad", "--anchor", "top"]);

  const padded = mediaPath(sandbox, "detail-1x1-pad.png");
  const [video] = probe(padded).streams;
  assert.equal(video.pix_fmt, probe(source).streams[0].pix_fmt);
  assert.ok(rgbPixels(padded, { x: 0, y: 0, width: 320, height: 180 }).equals(rgbPixels(source)), "the picture itself must not be re-sampled");
});

test("reframe refuses an anchor on the axis that does not change, and a ratio it already has", needsFfmpeg, async (t) => {
  const sandbox = createSandbox(t);
  makeTwoToneImage(sandbox.workspace, "wide.png");

  await assertRejectedBeforeGrok(
    sandbox,
    ["reframe", "wide.png", "--aspect", "9:16", "--anchor", "top"],
    /320x180 → 9:16 crops the width; use --anchor left, center or right\./
  );
  await assertRejectedBeforeGrok(
    sandbox,
    ["reframe", "wide.png", "--aspect", "9:16", "--mode", "pad", "--anchor", "left"],
    /320x180 → 9:16 pads the height; use --anchor top, center or bottom\./
  );
  await assertRejectedBeforeGrok(sandbox, ["reframe", "wide.png", "--aspect", "16:9"], /already 16:9; there is nothing to reframe\./);
  assertNoOutputDir(sandbox);
});

test("reframe re-encodes a video to even dimensions, keeping its sound and leaving the cover out", needsFfmpeg, async (t) => {
  const sandbox = createSandbox(t);
  makeClip(sandbox.workspace, "clip.mp4", { cover: true });

  await runTool(sandbox, ["reframe", "clip.mp4", "--aspect", "9:16"]);
  await runTool(sandbox, ["reframe", "clip.mp4", "--aspect", "16:9", "--mode", "pad"]);

  for (const [name, size] of [["clip-9x16-crop.mp4", [134, 240]], ["clip-16x9-pad.mp4", [428, 240]]]) {
    const { streams, format } = probe(mediaPath(sandbox, name));
    assert.deepEqual(
      streams.map((stream) => [stream.codec_type, stream.codec_name, stream.width, stream.height]),
      [["video", "h264", ...size], ["audio", "aac", undefined, undefined]],
      name
    );
    assert.ok(Math.abs(Number(format.duration) - 1) < 0.1, `${name} duration ${format.duration}`);
  }
});

test("reframe keeps an odd-sized video's new ratio exact, and records the size it wrote", needsFfmpeg, async (t) => {
  const sandbox = createSandbox(t);
  // yuv444p allows the odd size libx264 refuses in yuv420p.
  ffmpeg([
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=1",
    "-vf", "scale=321:241", "-c:v", "libx264", "-pix_fmt", "yuv444p", path.join(sandbox.workspace, "odd.mp4")
  ]);

  await runTool(sandbox, ["reframe", "odd.mp4", "--aspect", "1:1", "--mode", "pad"]);

  const [width, height] = dimensions(mediaPath(sandbox, "odd-1x1-pad.mp4"));
  assert.equal(width, height, `1:1 must come out square, got ${width}x${height}`);
  assert.equal(width % 2, 0);
  assert.deepEqual([lastGeneration(sandbox).width, lastGeneration(sandbox).height], [width, height]);
});

test("a re-encoded result is an MP4 whatever the input container", needsVp9, async (t) => {
  const sandbox = createSandbox(t);
  ffmpeg([
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "libvpx-vp9", "-c:a", "libopus", path.join(sandbox.workspace, "clip.webm")
  ]);
  makeClip(sandbox.workspace, "b.mp4");

  await runTool(sandbox, ["reframe", "clip.webm", "--aspect", "9:16"]);
  await runTool(sandbox, ["concat", "clip.webm", "b.mp4", "--reencode"]);

  assert.deepEqual(dimensions(mediaPath(sandbox, "clip-9x16-crop.mp4")), [134, 240]);
  assert.ok(Math.abs(Number(probe(mediaPath(sandbox, "clip-concat.mp4")).format.duration) - 2) < 0.15);
});

test("local tools take @last and job:<id>, and their output becomes the next @last", needsFfmpeg, async (t) => {
  const sandbox = createSandbox(t);
  makeClip(sandbox.workspace, "a.mp4", { cover: true });
  makeClip(sandbox.workspace, "b.mp4", { cover: true });

  const quietA = await runToolForJob(sandbox, ["mute", "a.mp4"]);
  await runTool(sandbox, ["mute", "b.mp4"]);
  await runTool(sandbox, ["concat", `job:${quietA}`, "@last"]);
  assert.ok(Math.abs(Number(probe(mediaPath(sandbox, "a-muted-concat.mp4")).format.duration) - 2) < 0.15);

  await runTool(sandbox, ["last-frame", "@last"]);
  assert.ok(fs.existsSync(mediaPath(sandbox, "a-muted-concat-last-frame.png")));

  await generate(sandbox, ["animate", "drift", "--image", "@last"], [{ tool: "image_to_video" }]);
  assert.ok(lastPromptLines(sandbox).includes(mediaPath(sandbox, "a-muted-concat-last-frame.png")));
});

test("a local tool records a job and a manifest entry made by ffmpeg", needsFfmpeg, async (t) => {
  const sandbox = createSandbox(t);
  const clip = makeClip(sandbox.workspace, "clip.mp4");

  const { stdout } = await runTool(sandbox, ["mute", "clip.mp4", "--json"]);

  const { jobId, assets } = JSON.parse(stdout);
  const muted = mediaPath(sandbox, "clip-muted.mp4");
  assert.deepEqual(assets.map((asset) => [asset.file, asset.tool]), [[muted, "ffmpeg"]]);
  const status = JSON.parse((await sandbox.run(["status", "--json"])).stdout);
  assert.deepEqual(
    status.jobs.map((job) => [job.id, job.command, job.status, job.files]),
    [[jobId, "mute", "completed", [muted]]]
  );
  const generation = lastGeneration(sandbox);
  assert.deepEqual([generation.command, generation.inputs, generation.assets[0].tool], ["mute", [clip], "ffmpeg"]);
});

test("a local tool refuses inputs of the wrong kind, missing files, wrong counts and options it does not take", needsFfmpeg, async (t) => {
  const sandbox = createSandbox(t);
  makeClip(sandbox.workspace, "clip.mp4");
  makeTwoToneImage(sandbox.workspace, "still.png");
  fs.writeFileSync(path.join(sandbox.workspace, "notes.txt"), "not media");
  const frameJob = await runToolForJob(sandbox, ["last-frame", "clip.mp4"]);

  const refusals = [
    [["mute", "@last"], new RegExp(`@last: .*clip-last-frame\\.png \\(job "${frameJob}"\\) is an image; mute needs a video\\.`)],
    [["last-frame", "still.png"], /still\.png is an image; last-frame needs a video\./],
    [["reframe", "notes.txt", "--aspect", "1:1"], /notes\.txt is neither an image nor a video, going by its extension; reframe takes an image or a video\./],
    [["last-frame", "notes.txt"], /; last-frame takes a video\./],
    [["mute", "gone.mp4"], /File not found: .*gone\.mp4/],
    [["last-frame"], /Usage: \/grok:last-frame <video>/],
    [["mute", "clip.mp4", "clip.mp4"], /Usage: \/grok:mute <video>/],
    [["concat", "clip.mp4"], /Usage: \/grok:concat <video> <video>\.\.\./],
    [["reframe", "still.png"], /reframe needs --aspect W:H/],
    [["reframe", "still.png", "--aspect", "1:1", "--mode", "stretch"], /--mode stretch is not an option\. Use one of: crop, pad\./],
    [["mute", "clip.mp4", "--aspect", "9:16"], /--aspect does not apply to mute\./],
    [["last-frame", "clip.mp4", "--anchor", "top"], /--anchor does not apply to last-frame\./],
    [["concat", "clip.mp4", "clip.mp4", "--job", "mine"], /--job does not apply to concat\./]
  ];
  for (const [args, pattern] of refusals) {
    await assertRejectedBeforeGrok(sandbox, args, pattern);
  }
});

test("when ffmpeg itself fails, the tool exits 2 with its message and records no job", needsFfmpeg, async (t) => {
  const sandbox = createSandbox(t);
  fs.writeFileSync(path.join(sandbox.workspace, "broken.mp4"), "not really a video");

  const { code, stderr } = await sandbox.run(["mute", "broken.mp4"]);

  assert.equal(code, 2, stderr);
  assert.match(stderr, /ffprobe could not read .*broken\.mp4/);
  assert.deepEqual(JSON.parse((await sandbox.run(["status", "--json"])).stdout).jobs, []);
  assert.deepEqual(sandbox.grokCalls(), []);
});

test("with --json, a local tool that fails reports it on stdout the way a failed generation does", needsFfmpeg, async (t) => {
  const sandbox = createSandbox(t);
  fs.writeFileSync(path.join(sandbox.workspace, "broken.mp4"), "not really a video");

  const { code, stdout, stderr } = await sandbox.run(["mute", "broken.mp4", "--json"]);

  assert.equal(code, 2, stderr);
  const { reason, ...rest } = JSON.parse(stdout);
  assert.deepEqual(rest, { ok: false, command: "mute" });
  assert.match(reason, /ffprobe could not read .*broken\.mp4/);
  assert.deepEqual(JSON.parse((await sandbox.run(["status", "--json"])).stdout).jobs, []);
});
