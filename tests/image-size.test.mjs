import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { LIB, cleanup, makeTempDir } from "./helpers.mjs";

const { imageSize, readImageSize } = await import(path.join(LIB, "image-size.mjs"));

function png(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function gif(width, height) {
  const bytes = Buffer.alloc(13);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

/** A WebP header of the given kind: "VP8 " (lossy), "VP8L" (lossless) or "VP8X" (extended). */
function webp(kind, width, height) {
  const bytes = Buffer.alloc(40);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(32, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write(kind, 12, "ascii");
  bytes.writeUInt32LE(20, 16);
  if (kind === "VP8 ") {
    bytes.set([0x9d, 0x01, 0x2a], 23);
    bytes.writeUInt16LE(width, 26);
    bytes.writeUInt16LE(height, 28);
  } else if (kind === "VP8L") {
    bytes[20] = 0x2f;
    bytes.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
  } else {
    bytes.writeUIntLE(width - 1, 24, 3);
    bytes.writeUIntLE(height - 1, 27, 3);
  }
  return bytes;
}

/** A JPEG of `width`×`height` stored pixels, with an EXIF orientation when given. */
function jpeg(width, height, { orientation, littleEndian = false } = {}) {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (orientation) {
    const tiff = Buffer.alloc(26);
    const write16 = (value, at) => (littleEndian ? tiff.writeUInt16LE(value, at) : tiff.writeUInt16BE(value, at));
    const write32 = (value, at) => (littleEndian ? tiff.writeUInt32LE(value, at) : tiff.writeUInt32BE(value, at));
    tiff.write(littleEndian ? "II" : "MM", 0, "ascii");
    write16(42, 2);
    write32(8, 4);
    write16(1, 8); // one directory entry
    write16(0x0112, 10); // orientation
    write16(3, 12); // SHORT
    write32(1, 14);
    write16(orientation, 18);
    const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
    const marker = Buffer.from([0xff, 0xe1, 0, 0]);
    marker.writeUInt16BE(payload.length + 2, 2);
    parts.push(marker, payload);
  }
  const frame = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  parts.push(frame, Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

test("reads the size of PNG, GIF and the three kinds of WebP", () => {
  assert.deepEqual(imageSize(png(1280, 720)), { width: 1280, height: 720 });
  assert.deepEqual(imageSize(gif(424, 240)), { width: 424, height: 240 });
  for (const kind of ["VP8 ", "VP8L", "VP8X"]) {
    assert.deepEqual(imageSize(webp(kind, 1170, 2532)), { width: 1170, height: 2532 }, kind);
  }
});

test("reads a JPEG's size as it is displayed, turned by its EXIF orientation", () => {
  assert.deepEqual(imageSize(jpeg(1200, 800)), { width: 1200, height: 800 });
  for (const littleEndian of [false, true]) {
    // 6: the phone was held upright, so the picture shows turned a quarter.
    assert.deepEqual(imageSize(jpeg(1200, 800, { orientation: 6, littleEndian })), { width: 800, height: 1200 });
    // 3: upside down, same shape.
    assert.deepEqual(imageSize(jpeg(1200, 800, { orientation: 3, littleEndian })), { width: 1200, height: 800 });
  }
});

test("returns null for what it cannot read", () => {
  assert.equal(imageSize(Buffer.from("png-bytes")), null);
  assert.equal(imageSize(png(1, 1).subarray(0, 20)), null);
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);
});

test("reads files and base64 data: URLs, and gives null for a missing file", (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const file = path.join(dir, "still.jpg");
  fs.writeFileSync(file, jpeg(640, 480));

  assert.deepEqual(readImageSize(file), { width: 640, height: 480 });
  assert.deepEqual(readImageSize(`data:image/png;base64,${png(300, 200).toString("base64")}`), { width: 300, height: 200 });
  assert.equal(readImageSize("data:image/png,not-base64"), null);
  assert.equal(readImageSize(path.join(dir, "missing.png")), null);
});
