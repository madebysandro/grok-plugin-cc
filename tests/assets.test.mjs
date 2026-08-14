import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { LIB, cleanup, makeTempDir } from "./helpers.mjs";

const { collectAssets, resolveInputImage, resolveOutDir, slugify, uniquePath, writeManifest } = await import(
  path.join(LIB, "assets.mjs")
);

function makeSourceFile(dir, name, contents = "image-bytes") {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

test("slugify produces a safe, bounded filename stem", () => {
  assert.equal(slugify("A Brass Telescope!"), "a-brass-telescope");
  assert.equal(slugify("   "), "grok");
  assert.ok(slugify("x".repeat(200)).length <= 48);
  assert.doesNotMatch(slugify("trailing --- dashes ---"), /-$/);
});

test("uniquePath never overwrites an existing file", () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, "shot.jpg"), "a");
    assert.equal(uniquePath(dir, "shot", ".jpg"), path.join(dir, "shot-2.jpg"));

    fs.writeFileSync(path.join(dir, "shot-2.jpg"), "b");
    assert.equal(uniquePath(dir, "shot", ".jpg"), path.join(dir, "shot-3.jpg"));
  } finally {
    cleanup(dir);
  }
});

test("collects completed calls and skips failed ones", () => {
  const dir = makeTempDir();
  try {
    const source = makeSourceFile(dir, "session/images/1.jpg");
    const outDir = path.join(dir, "out");

    const { saved, missing } = collectAssets({
      calls: [
        { status: "completed", path: source, tool: "image_gen", outputType: "ImageGen", prompt: "a telescope", aspectRatio: "16:9" },
        { status: "failed", path: null, tool: "image_to_video", outputType: "ImageToVideo", error: "boom" }
      ],
      outDir,
      baseName: "telescope"
    });

    assert.equal(saved.length, 1);
    assert.equal(missing.length, 0);
    assert.equal(path.basename(saved[0].file), "telescope-1.jpg");
    assert.equal(saved[0].outputType, "ImageGen");
    assert.ok(fs.existsSync(saved[0].file));
    // The original stays put; Grok's session folder is never mutated.
    assert.ok(fs.existsSync(source));
  } finally {
    cleanup(dir);
  }
});

test("reports completed calls whose file has vanished", () => {
  const dir = makeTempDir();
  try {
    const { saved, missing } = collectAssets({
      calls: [{ status: "completed", path: path.join(dir, "gone.jpg"), tool: "image_gen", outputType: "ImageGen" }],
      outDir: path.join(dir, "out"),
      baseName: "x"
    });

    assert.equal(saved.length, 0);
    assert.equal(missing.length, 1);
  } finally {
    cleanup(dir);
  }
});

test("numbers multiple assets from one run", () => {
  const dir = makeTempDir();
  try {
    const calls = ["1.jpg", "2.jpg", "3.jpg"].map((name) => ({
      status: "completed",
      path: makeSourceFile(dir, `session/images/${name}`),
      tool: "image_gen",
      outputType: "ImageGen"
    }));

    const { saved } = collectAssets({ calls, outDir: path.join(dir, "out"), baseName: "shot" });

    assert.deepEqual(
      saved.map((asset) => path.basename(asset.file)),
      ["shot-1.jpg", "shot-2.jpg", "shot-3.jpg"]
    );
  } finally {
    cleanup(dir);
  }
});

test("manifest accumulates across runs into the same directory", () => {
  const dir = makeTempDir();
  try {
    const entries = [{ file: path.join(dir, "a.jpg"), bytes: 10, tool: "image_gen", prompt: "one", aspectRatio: "1:1" }];

    writeManifest({ outDir: dir, entries, meta: { command: "image" } });
    const manifestFile = writeManifest({ outDir: dir, entries, meta: { command: "image" } });

    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    assert.equal(manifest.generations.length, 2);
    assert.equal(manifest.generations[0].assets[0].file, "a.jpg");
  } finally {
    cleanup(dir);
  }
});

test("a corrupt manifest is replaced rather than failing the run", () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, "grok-manifest.json"), "{ not json");

    const manifestFile = writeManifest({ outDir: dir, entries: [], meta: { command: "image" } });
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));

    assert.equal(manifest.generations.length, 1);
  } finally {
    cleanup(dir);
  }
});

test("resolveOutDir creates the directory relative to the workspace", () => {
  const dir = makeTempDir();
  try {
    const resolved = resolveOutDir("nested/shots", dir);
    assert.equal(resolved, path.join(dir, "nested", "shots"));
    assert.ok(fs.statSync(resolved).isDirectory());

    assert.equal(resolveOutDir(undefined, dir, "grok-media"), path.join(dir, "grok-media"));
  } finally {
    cleanup(dir);
  }
});

test("resolveInputImage validates real files and passes data URLs through", () => {
  const dir = makeTempDir();
  try {
    const source = makeSourceFile(dir, "in.png");

    assert.equal(resolveInputImage("in.png", dir), source);
    assert.equal(resolveInputImage("data:image/png;base64,AAAA", dir), "data:image/png;base64,AAAA");
    assert.throws(() => resolveInputImage("missing.png", dir), /Image not found/);
    assert.throws(() => resolveInputImage(dir, dir), /Not a file/);
    assert.throws(() => resolveInputImage("  ", dir), /empty/);
  } finally {
    cleanup(dir);
  }
});
