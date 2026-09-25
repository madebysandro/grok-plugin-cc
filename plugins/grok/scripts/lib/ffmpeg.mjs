/**
 * Local image and video work with ffmpeg / ffprobe — no Grok, no quota.
 *
 * Grok's clips carry a second video stream: an MJPEG cover picture flagged
 * `attached_pic`. Every operation here picks streams by the indices ffprobe
 * reports for the first real video stream and the first audio stream, so the
 * cover never becomes a frame, a segment, or an extra track.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Checked after PATH, where Homebrew and most installers put the binaries. */
const FALLBACK_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

/** A local tool could not do its job; `exitCode` is 1 for bad input, 2 when ffmpeg itself failed. */
export class MediaToolError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "MediaToolError";
    this.exitCode = exitCode;
  }
}

function findBinary(name) {
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean), ...FALLBACK_DIRS];
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function requireBinary(name) {
  const binary = findBinary(name);
  if (!binary) {
    throw new MediaToolError(`${name} not found. Install ffmpeg (for example \`brew install ffmpeg\`) and re-run.`);
  }
  return binary;
}

function run(name, args) {
  const binary = requireBinary(name);
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => reject(new MediaToolError(`${name} could not start: ${error.message}`, 2)));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function ffmpeg(args) {
  const { code, stderr } = await run("ffmpeg", ["-v", "error", "-y", ...args]);
  if (code !== 0) {
    throw new MediaToolError(`ffmpeg failed (exit ${code}):\n${stderr.trim().split("\n").slice(-12).join("\n")}`, 2);
  }
}

/**
 * What a media file holds: `{ duration, video, audio }`, where `video` is the
 * first stream that is not a cover picture and `audio` the first audio stream
 * (or null). Each carries its stream `index`.
 */
export async function probeMedia(file) {
  const { code, stdout, stderr } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=index,codec_type,codec_name,width,height,r_frame_rate,pix_fmt,sample_rate,channels:stream_disposition=attached_pic:format=duration",
    "-of", "json",
    file
  ]);
  if (code !== 0) {
    throw new MediaToolError(`ffprobe could not read ${file}:\n${stderr.trim()}`, 2);
  }
  const { streams = [], format = {} } = JSON.parse(stdout);
  const video = streams.find((stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1);
  const audio = streams.find((stream) => stream.codec_type === "audio");
  return {
    duration: Number(format.duration) || null,
    video: video
      ? { index: video.index, codec: video.codec_name, width: video.width, height: video.height, fps: video.r_frame_rate, pixFmt: video.pix_fmt }
      : null,
    audio: audio ? { index: audio.index, codec: audio.codec_name, sampleRate: audio.sample_rate, channels: audio.channels } : null
  };
}

async function requireVideoStream(file) {
  const media = await probeMedia(file);
  if (!media.video) {
    throw new MediaToolError(`${file} has no video stream.`);
  }
  return media;
}

/**
 * Save the last frame the clip really shows, as a PNG: decode its final second
 * and keep overwriting the output, so what remains is the last decoded frame.
 */
export async function extractLastFrame(input, output) {
  const { video } = await requireVideoStream(input);
  await ffmpeg(["-sseof", "-1", "-i", input, "-map", `0:${video.index}`, "-c:v", "png", "-update", "1", output]);
  if (!fs.existsSync(output)) {
    throw new MediaToolError(`ffmpeg decoded no frame from the end of ${input}.`, 2);
  }
}

/** Copy only the clip's video stream: no audio, no cover picture, nothing re-encoded. */
export async function stripAudio(input, output) {
  const { video } = await requireVideoStream(input);
  await ffmpeg(["-i", input, "-map", `0:${video.index}`, "-c", "copy", output]);
}

/** `24/1` → `24`, `30000/1001` → `29.97`. */
function framesPerSecond(rate) {
  const [numerator, denominator = 1] = String(rate).split("/").map(Number);
  return Math.round((numerator / denominator) * 100) / 100;
}

/** What has to match for clips to be joined by copying: the shape of their video and audio. */
function streamLayout({ video, audio }) {
  const picture = `${video.width}x${video.height}, ${framesPerSecond(video.fps)} fps, ${video.codec} ${video.pixFmt}`;
  const sound = audio ? `${audio.codec} ${audio.sampleRate} Hz ${audio.channels} ch` : "no audio";
  return `${picture}, ${sound}`;
}

/**
 * Join clips end to end.
 *
 * By default the streams are copied (the concat demuxer), which only works when
 * every clip has the first one's layout; otherwise this refuses and suggests
 * `reencode`, which scales and pads each clip to the first one's size and frame
 * rate, fills a missing soundtrack with silence, and re-encodes.
 */
export async function concatClips(inputs, output, { reencode = false } = {}) {
  const clips = [];
  for (const file of inputs) {
    clips.push({ file, ...(await requireVideoStream(file)) });
  }
  if (reencode) {
    await concatReencoding(clips, output);
    return;
  }

  const layout = streamLayout(clips[0]);
  if (clips.some((clip) => streamLayout(clip) !== layout)) {
    throw new MediaToolError(
      [
        "The clips differ, so they cannot be joined without re-encoding:",
        ...clips.map((clip) => `  ${path.basename(clip.file)}: ${streamLayout(clip)}`),
        "Re-run with --reencode to scale and re-encode them to match the first clip."
      ].join("\n")
    );
  }

  const { video, audio } = clips[0];
  const listDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-concat-"));
  try {
    const list = path.join(listDir, "clips.txt");
    fs.writeFileSync(list, inputs.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"));
    await ffmpeg([
      "-f", "concat", "-safe", "0", "-i", list,
      "-map", `0:${video.index}`,
      ...(audio ? ["-map", `0:${audio.index}`] : []),
      "-c", "copy",
      output
    ]);
  } finally {
    fs.rmSync(listDir, { recursive: true, force: true });
  }
}

async function concatReencoding(clips, output) {
  const { width, height, fps } = clips[0].video;
  const [evenWidth, evenHeight] = [width - (width % 2), height - (height % 2)];
  const withAudio = clips.some((clip) => clip.audio);

  const graph = [];
  const segments = [];
  clips.forEach((clip, index) => {
    graph.push(
      `[${index}:${clip.video.index}]scale=${evenWidth}:${evenHeight}:force_original_aspect_ratio=decrease,` +
        `pad=${evenWidth}:${evenHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${index}]`
    );
    segments.push(`[v${index}]`);
    if (withAudio) {
      const source = clip.audio ? `[${index}:${clip.audio.index}]aresample=48000,` : `anullsrc=r=48000:cl=stereo,atrim=duration=${clip.duration},`;
      graph.push(`${source}aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`);
      segments.push(`[a${index}]`);
    }
  });
  graph.push(`${segments.join("")}concat=n=${clips.length}:v=1:a=${withAudio ? 1 : 0}[v]${withAudio ? "[a]" : ""}`);

  await ffmpeg([
    ...clips.flatMap((clip) => ["-i", clip.file]),
    "-filter_complex", graph.join(";"),
    "-map", "[v]",
    ...(withAudio ? ["-map", "[a]", "-c:a", "aac"] : []),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
    output
  ]);
}

/**
 * Where a reframe cuts or pads, and to what size.
 *
 * `crop` keeps the largest window of the new ratio; `pad` keeps the whole
 * picture on a canvas of the new ratio. Either changes one axis only, so the
 * anchor must name a side on that axis. `even` rounds sizes to even numbers,
 * which H.264 in yuv420p needs.
 */
export function planReframe({ width, height }, aspect, mode, anchor, { even = false } = {}) {
  const target = aspect.width / aspect.height;
  const source = width / height;
  if (Math.abs(source - target) / target < 0.005) {
    throw new MediaToolError(`The picture is ${width}x${height}, already ${aspect.label}; there is nothing to reframe.`);
  }

  // A picture wider than the target loses width when cropped, and gains height when padded.
  const changesWidth = (source > target) === (mode === "crop");
  const sides = changesWidth ? ["left", "center", "right"] : ["top", "center", "bottom"];
  if (!sides.includes(anchor)) {
    throw new MediaToolError(
      `${width}x${height} → ${aspect.label} ${mode === "crop" ? "crops" : "pads"} the ${changesWidth ? "width" : "height"}; ` +
        `use --anchor ${sides.slice(0, -1).join(", ")} or ${sides.at(-1)}.`
    );
  }

  const size = (value) => (even ? (mode === "crop" ? Math.floor(value / 2) * 2 : Math.ceil(value / 2) * 2) : Math.round(value));
  const frame = changesWidth
    ? { width: size(height * target), height: even ? height - (height % 2) : height }
    : { width: even ? width - (width % 2) : width, height: size(width / target) };

  // How far along the changing axis the kept window (crop) or the picture (pad) sits.
  const room = changesWidth ? Math.abs(width - frame.width) : Math.abs(height - frame.height);
  const offset = { left: 0, top: 0, center: Math.floor(room / 2), right: room, bottom: room }[anchor];
  return { ...frame, x: changesWidth ? offset : 0, y: changesWidth ? 0 : offset };
}

/** Reframe an image or a video to `aspect`, by `crop` or by `pad` on a blurred copy of itself. */
export async function reframeMedia(input, output, { aspect, mode, anchor, kind }) {
  const media = await requireVideoStream(input);
  const { video, audio } = media;
  const plan = planReframe(video, aspect, mode, anchor, { even: kind === "video" });

  const filter =
    mode === "crop"
      ? `[0:${video.index}]crop=${plan.width}:${plan.height}:${plan.x}:${plan.y}[out]`
      : `[0:${video.index}]split=2[bg][fg];` +
        `[bg]scale=${plan.width}:${plan.height}:force_original_aspect_ratio=increase,crop=${plan.width}:${plan.height},` +
        `gblur=sigma=${Math.max(4, Math.round(Math.max(plan.width, plan.height) / 40))}[blur];` +
        `[blur][fg]overlay=${plan.x}:${plan.y}[out]`;

  const encoding =
    kind === "video"
      ? ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", ...(audio ? ["-map", `0:${audio.index}`, "-c:a", "copy"] : [])]
      : ["-frames:v", "1", ...(/\.jpe?g$/i.test(output) ? ["-q:v", "2"] : [])];

  await ffmpeg(["-i", input, "-filter_complex", filter, "-map", "[out]", ...encoding, output]);
  return plan;
}
