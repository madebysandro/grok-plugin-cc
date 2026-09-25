/**
 * The pixel size of a still, read from its header: PNG, JPEG (as displayed,
 * after its EXIF orientation), GIF and WebP. No image library is needed —
 * only the shape is, for instance to pick a clip's aspect ratio.
 */

import fs from "node:fs";

/** JPEG start-of-frame markers, which carry the size (not DHT, JPG or DAC). */
const JPEG_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** JPEG markers that stand alone, with no length after them. */
function isStandaloneMarker(marker) {
  return marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7);
}

/** The EXIF orientation tag; 5 to 8 mean the picture is shown turned a quarter. */
const ORIENTATION_TAG = 0x0112;

/**
 * `{ width, height }` of an image file or `data:` URL, as it is displayed; null
 * when the format is not one of these or the header is cut short.
 */
export function readImageSize(source) {
  let bytes;
  try {
    bytes = source.startsWith("data:") ? dataUrlBytes(source) : fs.readFileSync(source);
  } catch {
    return null;
  }
  return bytes ? imageSize(bytes) : null;
}

function dataUrlBytes(url) {
  const comma = url.indexOf(",");
  if (comma === -1 || !url.slice(0, comma).includes(";base64")) {
    return null;
  }
  return Buffer.from(url.slice(comma + 1), "base64");
}

/** `{ width, height }` from an image's bytes, or null. */
export function imageSize(bytes) {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString("ascii", 12, 16) === "IHDR") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 10 && bytes.toString("ascii", 0, 4) === "GIF8") {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return webpSize(bytes);
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return jpegSize(bytes);
  }
  return null;
}

function webpSize(bytes) {
  switch (bytes.toString("ascii", 12, 16)) {
    case "VP8 ":
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    case "VP8L": {
      const [b0, b1, b2, b3] = bytes.subarray(21, 25);
      return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
    }
    case "VP8X":
      return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    default:
      return null;
  }
}

function jpegSize(bytes) {
  let orientation = 1;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      return null;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    if (isStandaloneMarker(marker)) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (marker === 0xe1) {
      orientation = exifOrientation(bytes.subarray(offset + 4, offset + 2 + length)) ?? orientation;
    }
    if (JPEG_FRAME_MARKERS.has(marker)) {
      if (offset + 9 > bytes.length) {
        return null;
      }
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
    }
    offset += 2 + length;
  }
  return null;
}

/** The orientation in an APP1 segment's EXIF block, or null when it has none. */
function exifOrientation(segment) {
  if (segment.length < 14 || segment.toString("ascii", 0, 6) !== "Exif\0\0") {
    return null;
  }
  const tiff = segment.subarray(6);
  const little = tiff.toString("ascii", 0, 2) === "II";
  const read16 = (at) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const read32 = (at) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  if (read16(2) !== 42) {
    return null;
  }
  const directory = read32(4);
  if (directory + 2 > tiff.length) {
    return null;
  }
  const entries = read16(directory);
  for (let index = 0; index < entries; index += 1) {
    const entry = directory + 2 + index * 12;
    if (entry + 12 > tiff.length) {
      return null;
    }
    if (read16(entry) === ORIENTATION_TAG) {
      return read16(entry + 8);
    }
  }
  return null;
}
