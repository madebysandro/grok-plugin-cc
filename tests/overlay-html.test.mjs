import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { LIB, cleanup, makeTempDir } from "./helpers.mjs";

const { buildOverlayHtml, loadBrand } = await import(path.join(LIB, "overlay.mjs"));

const BASE = { imageUrl: "file:///tmp/base.png", text: "Title", position: "bottom", style: "clean" };

/** A brand kit on disk: brand.json plus whatever files `files` lists, removed after the test. */
function brandKit(t, brand, files = {}) {
  const dir = makeTempDir("grok-brand-");
  t.after(() => cleanup(dir));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  const file = path.join(dir, "brand.json");
  fs.writeFileSync(file, typeof brand === "string" ? brand : JSON.stringify(brand));
  return file;
}

test("the page declares UTF-8 and carries the text exactly, escaped", () => {
  const text = `Pão de queijo – R$ 5,90 <b>&"'`;
  const html = buildOverlayHtml({ ...BASE, text, sub: "só hoje <i>" });

  assert.match(html, /<meta charset="utf-8">/);
  assert.ok(html.includes("Pão de queijo – R$ 5,90 &lt;b&gt;&amp;&quot;&#39;"), html);
  assert.ok(html.includes("só hoje &lt;i&gt;"));
  assert.ok(!html.includes("<b>&") && !html.includes("<i>"));
});

test("the base image fills a page as large as the image itself", () => {
  const html = buildOverlayHtml(BASE);

  assert.match(html, /<img class="base" src="file:\/\/\/tmp\/base\.png"/);
  assert.match(html, /html, body \{[^}]*width: 100vw; height: 100vh;/);
});

test("the subtitle is left out when there is none", () => {
  assert.ok(!buildOverlayHtml(BASE).includes('class="sub"'));
  assert.ok(buildOverlayHtml({ ...BASE, sub: "extra" }).includes('<p class="sub">extra</p>'));
});

test("--position places the text block at the top, centre or bottom", () => {
  assert.match(buildOverlayHtml({ ...BASE, position: "top" }), /\.block \{[^}]*top: 6vh;/);
  assert.match(buildOverlayHtml({ ...BASE, position: "bottom" }), /\.block \{[^}]*bottom: 6vh;/);
  assert.match(buildOverlayHtml({ ...BASE, position: "center" }), /\.block \{[^}]*top: 50%; transform: translateY\(-50%\);/);
});

test("--style changes the block: clean has no panel, bold a solid band, glass a blurred panel", () => {
  assert.doesNotMatch(buildOverlayHtml({ ...BASE, style: "clean" }), /\.block \{[^}]*background:/);
  assert.match(buildOverlayHtml({ ...BASE, style: "bold" }), /\.block \{[^}]*background: #111111;/);
  assert.match(buildOverlayHtml({ ...BASE, style: "glass" }), /\.block \{[^}]*backdrop-filter: blur\(/);
});

test("a brand's colours, Google fonts and logo are used", (t) => {
  const brand = loadBrand(
    brandKit(
      t,
      {
        name: "Café Aurora",
        colors: { primary: "#C0392B", secondary: "#F5E6CC", accent: "#F1C40F", text: "#FFFFFF", background: "rgba(20, 10, 5, 0.6)" },
        fonts: { heading: "Playfair Display", body: "Inter" },
        logo: "assets/logo.png"
      },
      { "assets/logo.png": Buffer.from("89504e470d0a1a0a", "hex") }
    )
  );

  const html = buildOverlayHtml({ ...BASE, style: "bold", sub: "sub", brand });

  assert.match(html, /\.block \{[^}]*background: #C0392B;/);
  assert.match(html, /\.title \{[^}]*color: #FFFFFF;/);
  assert.match(html, /\.sub \{[^}]*color: #F1C40F;/);
  assert.match(html, /\.title \{[^}]*font-family: "Playfair Display", /);
  assert.match(html, /\.sub \{[^}]*font-family: "Inter", /);
  assert.ok(html.includes('href="https://fonts.googleapis.com/css2?family=Playfair+Display&display=block"'), html);
  assert.ok(html.includes('href="https://fonts.googleapis.com/css2?family=Inter&display=block"'));
  assert.match(html, /<img class="logo" src="data:image\/png;base64,iVBORw0KGgo="/);
});

test("a brand font given as a file is embedded, so rendering needs no network", (t) => {
  const brand = loadBrand(brandKit(t, { fonts: { heading: "fonts/Brand-Bold.ttf" } }, { "fonts/Brand-Bold.ttf": "ttf-bytes" }));

  const html = buildOverlayHtml({ ...BASE, brand });

  assert.match(html, /@font-face \{ font-family: "brand-heading"; src: url\("data:font\/ttf;base64,dHRmLWJ5dGVz"\) format\("truetype"\); \}/);
  assert.match(html, /\.title \{[^}]*font-family: "brand-heading", /);
  assert.ok(!html.includes("fonts.googleapis.com"));
});

test("without a brand the text is white on a shadow, in the system's sans-serif", () => {
  const html = buildOverlayHtml(BASE);

  assert.match(html, /\.title \{[^}]*color: #FFFFFF;/);
  assert.match(html, /\.title \{[^}]*font-family: [^;]*sans-serif;/);
  assert.match(html, /\.title \{[^}]*text-shadow:/);
  assert.ok(!html.includes("fonts.googleapis.com"));
});

test("a brand that could inject CSS or points at missing files is refused", (t) => {
  const refusals = [
    [{ colors: { primary: "red; } body { display: none" } }, /colors\.primary "red; \} body \{ display: none" is not a colour/],
    [{ fonts: { heading: "Inter'); } *{x:y" } }, /fonts\.heading .* is neither a Google Fonts name nor a font file/],
    [{ fonts: { body: "fonts/missing.woff2" } }, /fonts\.body: .*missing\.woff2 not found/],
    [{ logo: "nope.png" }, /logo: .*nope\.png not found/],
    [{ logo: "notes.txt" }, /logo: .*notes\.txt is not an image/]
  ];
  for (const [brand, pattern] of refusals) {
    assert.throws(() => loadBrand(brandKit(t, brand, { "notes.txt": "x" })), pattern);
  }
  assert.throws(() => loadBrand(brandKit(t, "{ not json")), /brand\.json is not valid JSON/);
  assert.throws(() => loadBrand("/nowhere/brand.json"), /Brand file not found: \/nowhere\/brand\.json/);
});
