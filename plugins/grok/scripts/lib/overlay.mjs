/**
 * Exact text over an image, as an HTML page the size of the image.
 *
 * Text that must not come out wrong — titles, prices, figures — is set in
 * HTML rather than asked of an image model, then rendered by `html-render.mjs`.
 * A project's `brand.json` supplies colours, fonts and a logo:
 *
 *   { "name", "colors": { "primary", "secondary", "accent", "text", "background" },
 *     "fonts": { "heading", "body" }, "logo": "<path relative to brand.json>" }
 *
 * A font is a Google Fonts family name, or a path to a font file (embedded, so
 * rendering needs no network — the file form goes beyond the original
 * convention, for brand fonts that are not on Google Fonts).
 */

import fs from "node:fs";
import path from "node:path";

export const OVERLAY_POSITIONS = Object.freeze(["top", "center", "bottom"]);
export const OVERLAY_STYLES = Object.freeze(["clean", "bold", "glass"]);

const DEFAULT_COLORS = Object.freeze({
  primary: "#111111",
  secondary: "rgba(255, 255, 255, 0.35)",
  accent: null, // the subtitle follows the text colour unless a brand sets an accent
  text: "#FFFFFF",
  background: "rgba(0, 0, 0, 0.35)"
});

const SYSTEM_SANS = '-apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif';

const COLOR = /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\)|[a-z]+)$/i;
const GOOGLE_FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9 -]*$/;
const FONT_FILES = { ".ttf": ["font/ttf", "truetype"], ".otf": ["font/otf", "opentype"], ".woff": ["font/woff", "woff"], ".woff2": ["font/woff2", "woff2"] };
const LOGO_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml" };

class BrandError extends Error {}

function dataUrl(file, mime) {
  return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
}

function brandFont(value, role, dir) {
  const name = String(value).trim();
  const extension = path.extname(name).toLowerCase();
  if (Object.hasOwn(FONT_FILES, extension)) {
    const file = path.resolve(dir, name);
    if (!fs.existsSync(file)) {
      throw new BrandError(`fonts.${role}: ${file} not found.`);
    }
    const [mime, format] = FONT_FILES[extension];
    return { family: `brand-${role}`, label: name, source: dataUrl(file, mime), format };
  }
  if (!GOOGLE_FONT_NAME.test(name)) {
    throw new BrandError(`fonts.${role} "${name}" is neither a Google Fonts name nor a font file (.ttf, .otf, .woff, .woff2).`);
  }
  return { family: name, label: name, google: true };
}

/**
 * Read and check a brand kit. Colours must be CSS colours and font names plain
 * names, so nothing in the file can inject CSS; the logo and font files are
 * resolved against the brand file's folder and embedded.
 */
export function loadBrand(file) {
  if (!fs.existsSync(file)) {
    throw new BrandError(`Brand file not found: ${file}`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new BrandError(`${path.basename(file)} is not valid JSON: ${file}`);
  }
  const dir = path.dirname(file);

  const colors = { ...DEFAULT_COLORS };
  for (const [role, value] of Object.entries(raw.colors ?? {})) {
    if (!Object.hasOwn(DEFAULT_COLORS, role)) {
      continue;
    }
    if (!COLOR.test(String(value).trim())) {
      throw new BrandError(`colors.${role} "${value}" is not a colour; use #hex, rgb(...)/rgba(...) or a colour name.`);
    }
    colors[role] = String(value).trim();
  }

  const fonts = {};
  for (const role of ["heading", "body"]) {
    if (raw.fonts?.[role]) {
      fonts[role] = brandFont(raw.fonts[role], role, dir);
    }
  }

  let logo = null;
  if (raw.logo) {
    const logoFile = path.resolve(dir, String(raw.logo));
    if (!fs.existsSync(logoFile)) {
      throw new BrandError(`logo: ${logoFile} not found.`);
    }
    const mime = LOGO_TYPES[path.extname(logoFile).toLowerCase()];
    if (!mime) {
      throw new BrandError(`logo: ${logoFile} is not an image (${Object.keys(LOGO_TYPES).join(", ")}).`);
    }
    logo = dataUrl(logoFile, mime);
  }

  return { name: raw.name ? String(raw.name) : null, colors, fonts, logo };
}

export { BrandError };

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function fontStack(font) {
  return font ? `"${font.family}", ${SYSTEM_SANS}` : SYSTEM_SANS;
}

/** The `<link>`s for Google fonts (regular, and the bold weights if the family has them) and `@font-face`s for embedded ones. */
function fontSources(fonts) {
  const links = [];
  const faces = [];
  const seen = new Set();
  for (const font of Object.values(fonts)) {
    if (seen.has(font.family)) {
      continue;
    }
    seen.add(font.family);
    if (font.google) {
      const family = encodeURIComponent(font.family).replace(/%20/g, "+");
      // A weight the family lacks makes that one request fail; the others still load.
      for (const weight of ["", ":wght@700", ":wght@800"]) {
        links.push(`<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${family}${weight}&display=block">`);
      }
    } else {
      faces.push(`@font-face { font-family: "${font.family}"; src: url("${font.source}") format("${font.format}"); }`);
    }
  }
  return { links, faces };
}

const PLACEMENT = {
  top: "top: 6vh;",
  bottom: "bottom: 6vh;",
  center: "top: 50%; transform: translateY(-50%);"
};

/**
 * The overlay page: the base image filling a viewport of its own size, with a
 * text block (logo, title, subtitle) placed and styled on top. Sizes are in
 * viewport units, so the renderer only has to set the viewport to the image.
 */
export function buildOverlayHtml({ imageUrl, text, sub = null, position, style, brand = null }) {
  const colors = brand?.colors ?? DEFAULT_COLORS;
  const fonts = brand?.fonts ?? {};
  const { links, faces } = fontSources(fonts);

  const panel = {
    clean: "",
    bold: ` background: ${colors.primary}; padding: 2.4vw 3.6vw;`,
    glass:
      ` background: ${colors.background}; backdrop-filter: blur(1.4vw); -webkit-backdrop-filter: blur(1.4vw);` +
      ` border: 0.15vw solid ${colors.secondary}; border-radius: 2vw; padding: 2.4vw 3.6vw;`
  }[style];
  const shadow = style === "bold" ? "" : " text-shadow: 0 0.25vw 1.2vw rgba(0, 0, 0, 0.55);";

  const css = [
    ...faces,
    "* { box-sizing: border-box; }",
    "html, body { margin: 0; padding: 0; width: 100vw; height: 100vh; overflow: hidden; background: #000; }",
    ".base { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }",
    `.block { position: absolute; left: 6vw; right: 6vw; ${PLACEMENT[position]} text-align: center;${panel} }`,
    ".logo { display: block; margin: 0 auto 1.6vw; height: min(9vw, 12vh); width: auto; }",
    `.title { margin: 0; font-family: ${fontStack(fonts.heading)}; font-weight: ${style === "bold" ? 800 : 700}; ` +
      `font-size: min(7vw, 11vh); line-height: 1.12; color: ${colors.text}; white-space: pre-line;${shadow} }`,
    `.sub { margin: 1.2vw 0 0; font-family: ${fontStack(fonts.body ?? fonts.heading)}; font-weight: 400; ` +
      `font-size: min(3.4vw, 5.5vh); line-height: 1.3; color: ${colors.accent ?? colors.text}; white-space: pre-line;${shadow} }`
  ];

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    ...links,
    `<style>\n${css.join("\n")}\n</style>`,
    "</head>",
    "<body>",
    `<img class="base" src="${escapeHtml(imageUrl)}">`,
    '<div class="block">',
    brand?.logo ? `<img class="logo" src="${brand.logo}">` : null,
    `<h1 class="title">${escapeHtml(text)}</h1>`,
    sub ? `<p class="sub">${escapeHtml(sub)}</p>` : null,
    "</div>",
    "</body>",
    "</html>"
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** The font families the page asks for, to check they loaded, each with the name the brand file gave it. */
export function requestedFonts(brand) {
  const byFamily = new Map(Object.values(brand?.fonts ?? {}).map((font) => [font.family, font.label]));
  return [...byFamily].map(([family, label]) => ({ family, label }));
}
