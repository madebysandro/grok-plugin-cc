/**
 * Local image and video work with ffmpeg / ffprobe — no Grok, no quota.
 *
 * Grok's clips carry a second video stream: an MJPEG cover picture flagged
 * `attached_pic`. Every operation here picks streams by the indices ffprobe
 * reports for the first real video stream and the first audio stream, so the
 * cover never becomes a frame, a segment, or an extra track.
 *
 * Checks that can refuse a request (`checkConcatCopy`, `planReframe`) are
 * separate from the work, so callers can run them before writing anything.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Checked after PATH, where Homebrew and most installers put the binaries. */
const FALLBACK_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

/** A local tool could not do its job; `exitCode` is 1 for bad input, 2 when the tool itself failed. */
export class MediaToolError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "MediaToolError";
    this.exitCode = exitCode;
  }
}

/** An executable called `name` on PATH or in the usual install dirs, or null. */
export function findBinary(name) {
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean), ...FALLBACK_DIRS];
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // keep looking
    }
  }
  return null;
}

function run(name, args) {
  const binary = findBinary(name);
  if (!binary) {
    throw new MediaToolError(`${name} not found. Install ffmpeg (for example \`brew install ffmpeg\`) and re-run.`);
  }
  return runProgram(binary, args, name);
}

/**
 * Run `binary` to completion, resolving with `{ code, stdout, stderr }`; one
 * that cannot start is a tool failure (exit code 2), named by `label`.
 */
export function runProgram(binary, args, label = binary) {
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
    child.on("error", (error) => reject(new MediaToolError(`${label} could not start: ${error.message}`, 2)));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function ffmpeg(args) {
  const { code, stderr } = await run("ffmpeg", ["-v", "error", "-y", ...args]);
  if (code !== 0) {
    throw new MediaToolError(`ffmpeg failed (exit ${code}):\n${stderr.trim().split("\n").slice(-12).join("\n")}`, 2);
  }
}

const evenDown = (value) => Math.floor(value / 2) * 2;
const evenUp = (value) => Math.ceil(value / 2) * 2;

/**
 * What a media file holds: `{ duration, video, audio }`, where `video` is the
 * first stream that is not a cover picture and `audio` the first audio stream;
 * either may be null. Each carries its stream `index`.
 */
export async function probeMedia(file) {
  const { code, stdout, stderr } = await run("ffprobe", [
    "-v", "error",
    "-show_entries",
    "stream=index,codec_type,codec_name,width,height,r_frame_rate,pix_fmt,sample_rate,channels,duration:stream_disposition=attached_pic:format=duration",
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
      ? {
          index: video.index,
          codec: video.codec_name,
          width: video.width,
          height: video.height,
          fps: video.r_frame_rate,
          pixFmt: video.pix_fmt,
          duration: Number(video.duration) || null
        }
      : null,
    audio: audio ? { index: audio.index, codec: audio.codec_name, sampleRate: audio.sample_rate, channels: audio.channels } : null
  };
}

/** `probeMedia`, refusing a file with no picture in it. */
export async function probePicture(file) {
  const media = await probeMedia(file);
  if (!media.video) {
    throw new MediaToolError(`${file} has no video stream.`);
  }
  return media;
}

/** How long the picture of a clip lasts: its own stream's duration, else the file's. */
function pictureSeconds(media) {
  return media.video.duration ?? media.duration;
}

/**
 * Save the last frame the clip really shows, as a PNG: decode from a second
 * before the picture ends and keep overwriting the output, so what remains is
 * the last decoded frame. Seeking by the picture's own length matters when the
 * sound runs on after it.
 */
export async function extractLastFrame(input, output, media) {
  const decodeFrom = async (seconds) =>
    ffmpeg(["-ss", String(seconds), "-i", input, "-map", `0:${media.video.index}`, "-c:v", "png", "-update", "1", output]);

  const start = Math.max(0, (pictureSeconds(media) ?? 0) - 1);
  await decodeFrom(start);
  if (!fs.existsSync(output) && start > 0) {
    // The reported length was off; decode the whole clip instead.
    await decodeFrom(0);
  }
  if (!fs.existsSync(output)) {
    throw new MediaToolError(`ffmpeg decoded no frame from ${input}.`, 2);
  }
}

/** Copy only the clip's video stream: no audio, no cover picture, nothing re-encoded. */
export async function stripAudio(input, output, media) {
  await ffmpeg(["-i", input, "-map", `0:${media.video.index}`, "-c", "copy", output]);
}

/** `24/1` → `24`, `30000/1001` → `29.97`. */
function framesPerSecond(rate) {
  const [numerator, denominator = 1] = String(rate).split("/").map(Number);
  return Math.round((numerator / denominator) * 100) / 100;
}

/**
 * What has to match for clips to be joined by copying: the shape of their
 * video and audio, and the order the streams are stored in, since the concat
 * demuxer lines streams up by position.
 */
function streamLayout({ video, audio }) {
  const picture = `${video.width}x${video.height}, ${framesPerSecond(video.fps)} fps, ${video.codec} ${video.pixFmt}`;
  const sound = audio ? `${audio.codec} ${audio.sampleRate} Hz ${audio.channels} ch` : "no audio";
  const order = [
    [video.index, `video #${video.index}`],
    ...(audio ? [[audio.index, `audio #${audio.index}`]] : [])
  ]
    .sort(([left], [right]) => left - right)
    .map(([, label]) => label)
    .join(", ");
  return `${picture}, ${sound}, ${order}`;
}

/** Refuse clips that cannot be joined by copying, saying how each differs. `clips` are `{ file, ...probeMedia }`. */
export function checkConcatCopy(clips) {
  const layout = streamLayout(clips[0]);
  if (clips.every((clip) => streamLayout(clip) === layout)) {
    return;
  }
  throw new MediaToolError(
    [
      "The clips differ, so they cannot be joined without re-encoding:",
      ...clips.map((clip) => `  ${path.basename(clip.file)}: ${streamLayout(clip)}`),
      "Re-run with --reencode to scale and re-encode them to match the first clip."
    ].join("\n")
  );
}

/**
 * Join clips end to end.
 *
 * By default the streams are copied (the concat demuxer); check the clips with
 * `checkConcatCopy` first. `reencode` scales and pads each clip to the first
 * one's size and frame rate, fills a missing soundtrack with silence, and
 * re-encodes to H.264 + AAC.
 */
export async function concatClips(clips, output, { reencode = false } = {}) {
  if (reencode) {
    await concatReencoding(clips, output);
    return;
  }

  const { video, audio } = clips[0];
  const listDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-concat-"));
  try {
    const list = path.join(listDir, "clips.txt");
    fs.writeFileSync(list, clips.map(({ file }) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"));
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
  const [evenWidth, evenHeight] = [evenDown(width), evenDown(height)];
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
      graph.push(`${soundOf(clip, index)}aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`);
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

/** The start of a clip's audio chain in the concat graph: its own sound, or silence as long as its picture. */
function soundOf(clip, index) {
  if (clip.audio) {
    return `[${index}:${clip.audio.index}]aresample=48000,`;
  }
  const seconds = pictureSeconds(clip);
  if (!seconds) {
    throw new MediaToolError(`Cannot tell how long ${clip.file} lasts, so it cannot be given a silent soundtrack.`, 2);
  }
  return `anullsrc=r=48000:cl=stereo,atrim=duration=${seconds},`;
}

/**
 * Where a reframe cuts or pads, and to what size.
 *
 * `crop` keeps the largest window of the new ratio; `pad` keeps the whole
 * picture on a canvas of the new ratio. Either changes one axis only, so the
 * anchor must name a side on that axis. `even` keeps both sides even, which
 * H.264 and 4:2:0 pictures need: the unchanged side is evened first (down for
 * a crop, up for a pad) and the changed side derived from it, so the ratio holds.
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

  const fit = (value) => (even ? (mode === "pad" ? evenUp(value) : evenDown(value)) : Math.round(value));
  const frame = changesWidth
    ? { height: even ? fit(height) : height, width: fit((even ? fit(height) : height) * target) }
    : { width: even ? fit(width) : width, height: fit((even ? fit(width) : width) / target) };

  // Where the kept window (crop) or the picture (pad) sits: by the anchor along
  // the changing axis, centred along the other (off by at most one pixel).
  const along = changesWidth ? Math.abs(width - frame.width) : Math.abs(height - frame.height);
  const across = changesWidth ? Math.abs(height - frame.height) : Math.abs(width - frame.width);
  const offset = { left: 0, top: 0, center: Math.floor(along / 2), right: along, bottom: along }[anchor];
  return {
    ...frame,
    x: changesWidth ? offset : Math.floor(across / 2),
    y: changesWidth ? Math.floor(across / 2) : offset
  };
}

/** Whether a picture of this pixel format needs even sides (chroma subsampled across both axes, or H.264 video). */
export function needsEvenSides(kind, pixFmt) {
  return kind === "video" || /4[12][02]/.test(String(pixFmt));
}

/**
 * Reframe an image or a video by `plan` (from `planReframe`): `crop`, or `pad`
 * on a blurred copy of itself. Videos are re-encoded to H.264 with their sound
 * copied; images keep their pixel format, and a padded picture is laid on its
 * background untouched.
 */
export async function reframeMedia(input, output, { media, plan, mode, kind }) {
  const { video, audio } = media;
  const keepFormat = kind === "image" ? `,format=${video.pixFmt}` : "";
  const filter =
    mode === "crop"
      ? `[0:${video.index}]crop=${plan.width}:${plan.height}:${plan.x}:${plan.y}[out]`
      : `[0:${video.index}]split=2[bg][fg];` +
        `[bg]scale=${plan.width}:${plan.height}:force_original_aspect_ratio=increase,crop=${plan.width}:${plan.height},` +
        `gblur=sigma=${Math.max(4, Math.round(Math.max(plan.width, plan.height) / 40))}[blur];` +
        `[blur][fg]overlay=${plan.x}:${plan.y}${kind === "image" ? ":format=auto" : ""}${keepFormat}[out]`;

  const encoding =
    kind === "video"
      ? [
          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
          // Grok's AAC is copied; other soundtracks (Opus, Vorbis) become AAC so they fit the MP4.
          ...(audio ? ["-map", `0:${audio.index}`, "-c:a", audio.codec === "aac" ? "copy" : "aac"] : [])
        ]
      : ["-frames:v", "1", ...(/\.jpe?g$/i.test(output) ? ["-q:v", "2"] : [])];

  await ffmpeg(["-i", input, "-filter_complex", filter, "-map", "[out]", ...encoding, output]);
}
