import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { LIB } from "./helpers.mjs";

const { parseArgs, parseCount, splitArgumentString } = await import(path.join(LIB, "args.mjs"));

const CONFIG = {
  valueOptions: ["out", "aspect", "count", "name"],
  booleanOptions: ["json", "verbatim"],
  repeatOptions: ["image"],
  aliases: { o: "out" }
};

test("separates the prompt from options", () => {
  const { options, positionals } = parseArgs(["a", "brass", "telescope", "--aspect", "16:9", "--json"], CONFIG);

  assert.equal(positionals.join(" "), "a brass telescope");
  assert.equal(options.aspect, "16:9");
  assert.equal(options.json, true);
});

test("accepts --key=value and short aliases", () => {
  const { options } = parseArgs(["--aspect=9:16", "-o", "shots"], CONFIG);

  assert.equal(options.aspect, "9:16");
  assert.equal(options.out, "shots");
});

test("collects repeatable options into an array", () => {
  const { options } = parseArgs(["--image", "a.png", "--image", "b.png"], CONFIG);
  assert.deepEqual(options.image, ["a.png", "b.png"]);
});

test("--flag=false negates a boolean", () => {
  assert.equal(parseArgs(["--verbatim=false"], CONFIG).options.verbatim, false);
  assert.equal(parseArgs(["--verbatim"], CONFIG).options.verbatim, true);
});

test("everything after -- is a positional", () => {
  const { positionals } = parseArgs(["prompt", "--", "--aspect", "16:9"], CONFIG);
  assert.deepEqual(positionals, ["prompt", "--aspect", "16:9"]);
});

test("an unknown flag is kept as a positional rather than dropped", () => {
  const { positionals } = parseArgs(["make", "--unknown", "art"], CONFIG);
  assert.deepEqual(positionals, ["make", "--unknown", "art"]);
});

test("a value option with no value is an error", () => {
  assert.throws(() => parseArgs(["--aspect"], CONFIG), /Missing value for --aspect/);
});

test("splitArgumentString keeps quoted prompts whole", () => {
  assert.deepEqual(splitArgumentString('"a brass telescope" --aspect 16:9'), ["a brass telescope", "--aspect", "16:9"]);
  assert.deepEqual(splitArgumentString("'single quoted'"), ["single quoted"]);
  assert.deepEqual(splitArgumentString("escaped\\ space"), ["escaped space"]);
  assert.deepEqual(splitArgumentString("   "), []);
});

test("splitArgumentString preserves an empty quoted token", () => {
  assert.deepEqual(splitArgumentString('a "" b'), ["a", "", "b"]);
});

test("parseCount clamps and falls back", () => {
  assert.equal(parseCount("3"), 3);
  assert.equal(parseCount(undefined, { fallback: 1 }), 1);
  assert.equal(parseCount("0", { fallback: 1, min: 1 }), 1);
  assert.equal(parseCount("99", { max: 8 }), 8);
  assert.equal(parseCount("nonsense", { fallback: 2 }), 2);
});
