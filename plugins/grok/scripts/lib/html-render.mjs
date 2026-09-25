/**
 * Render an HTML page to a PNG with headless Chrome, at an exact pixel size,
 * once its fonts and images have loaded.
 *
 * Chrome is driven over the DevTools protocol on `--remote-debugging-pipe`
 * (file descriptors 3 and 4: no port, no dependency), with a throwaway profile
 * — never the user's. Whatever happens, Chrome and its helper processes are
 * killed and the profile removed before this returns, and also if the
 * companion itself is interrupted mid-render.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { MediaToolError } from "./ffmpeg.mjs";

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PATH_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

/** How long a closing Chrome gets before it is killed. */
const CLOSE_GRACE_MS = 2000;

/**
 * How Chrome is started: headless, driven over the pipe, and cut off from the
 * user's machine. `--use-mock-keychain` matters most on macOS: without it
 * Chrome reaches for the login keychain ("Chrome Safe Storage"), and when it
 * cannot find one — a throwaway profile, a different HOME — macOS puts a
 * "Keychain Not Found" dialog in front of the user whose "Reset To Defaults"
 * button would recreate their login keychain.
 */
export const CHROME_FLAGS = Object.freeze([
  "--headless=new",
  "--remote-debugging-pipe",
  "--use-mock-keychain",
  "--password-store=basic",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-sync",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-gpu",
  "--hide-scrollbars",
  "--mute-audio"
]);

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Chrome's binary: `CHROME_PATH` when set (and nothing else then), else the macOS app, else PATH. */
export function findChrome() {
  if (process.env.CHROME_PATH) {
    return isExecutable(process.env.CHROME_PATH) ? process.env.CHROME_PATH : null;
  }
  if (isExecutable(MAC_CHROME)) {
    return MAC_CHROME;
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of PATH_NAMES) {
      if (isExecutable(path.join(dir, name))) {
        return path.join(dir, name);
      }
    }
  }
  return null;
}

/** Chrome's binary, or a `MediaToolError` saying how to point at one. */
export function requireChrome() {
  const chrome = findChrome();
  if (!chrome) {
    throw new MediaToolError(
      process.env.CHROME_PATH
        ? `CHROME_PATH is set to ${process.env.CHROME_PATH}, which is not an executable file.`
        : "Chrome not found. Install Google Chrome, or set CHROME_PATH to a Chrome or Chromium binary."
    );
  }
  return chrome;
}

/** One DevTools connection over Chrome's pipe: NUL-terminated JSON messages each way. */
class DevToolsPipe {
  constructor(input, output) {
    this.input = input;
    this.nextId = 1;
    this.pending = new Map();
    this.waits = new Set();
    this.closedWith = null;
    this.chunks = [];

    // A write after Chrome died raises EPIPE on the stream; the exit handler reports it.
    input.on("error", () => {});
    output.on("error", () => {});
    output.on("data", (chunk) => this.receive(chunk));
  }

  /** Split the byte stream on NUL; decode whole messages only, so a character never straddles two chunks. */
  receive(chunk) {
    let start = 0;
    for (let end = chunk.indexOf(0); end !== -1; end = chunk.indexOf(0, start)) {
      this.chunks.push(chunk.subarray(start, end));
      const text = Buffer.concat(this.chunks).toString("utf8");
      this.chunks = [];
      start = end + 1;
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        this.close(new MediaToolError("Chrome sent a DevTools message that is not JSON.", 2));
        return;
      }
      this.dispatch(message);
    }
    if (start < chunk.length) {
      this.chunks.push(chunk.subarray(start));
    }
  }

  dispatch(message) {
    const waiting = message.id !== undefined ? this.pending.get(message.id) : null;
    if (waiting) {
      this.pending.delete(message.id);
      if (message.error) {
        waiting.reject(new MediaToolError(`Chrome refused ${waiting.method}: ${message.error.message}`, 2));
      } else {
        waiting.resolve(message.result);
      }
      return;
    }
    for (const wait of this.waits) {
      if (message.method === wait.method && message.sessionId === wait.sessionId) {
        this.waits.delete(wait);
        wait.resolve(message.params);
      }
    }
  }

  send(method, params = {}, sessionId) {
    if (this.closedWith) {
      return Promise.reject(this.closedWith);
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.input.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  /** The next `method` event for `sessionId`. Rejected, never left hanging, if Chrome goes away first. */
  waitFor(method, sessionId) {
    if (this.closedWith) {
      return Promise.reject(this.closedWith);
    }
    return new Promise((resolve, reject) => {
      this.waits.add({ method, sessionId, resolve, reject });
    });
  }

  /** Fail everything still waiting: Chrome is gone. */
  close(error) {
    if (this.closedWith) {
      return;
    }
    this.closedWith = error;
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
    for (const { reject } of this.waits) {
      reject(error);
    }
    this.waits.clear();
  }
}

function killGroup(child) {
  try {
    // Chrome runs as a process group leader, so this takes its helpers with it.
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // already gone
  }
}

function removeProfile(profile) {
  try {
    // Helpers may still be letting go of files just after the kill.
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // A leftover folder in the temp directory must not hide the render's real outcome.
  }
}

/** Waits for the page's fonts and images, then reports its size and the fonts that loaded. */
function readinessScript(sizeFrom) {
  return `(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((image) => image.decode()));
    const sized = document.querySelector(${JSON.stringify(sizeFrom)});
    if (!sized) {
      throw new Error(${JSON.stringify(`the page has no ${sizeFrom}`)});
    }
    const loaded = [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family.replace(/^["']|["']$/g, ""));
    return { width: sized.naturalWidth, height: sized.naturalHeight, loaded: [...new Set(loaded)] };
  })()`;
}

/** Whether the element matched by `selector` reaches past the viewport's edges. */
function overflowScript(selector) {
  return `(() => {
    const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return box.top < -0.5 || box.left < -0.5 || box.bottom > innerHeight + 0.5 || box.right > innerWidth + 0.5;
  })()`;
}

async function evaluate(devtools, sessionId, expression) {
  const { result, exceptionDetails } = await devtools.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId
  );
  if (exceptionDetails) {
    const reason = exceptionDetails.exception?.description ?? exceptionDetails.text;
    throw new MediaToolError(`The page did not load in Chrome: ${reason}`, 2);
  }
  return result.value;
}

/**
 * Render `html` to `output` (PNG) at the natural size of the element matched
 * by `sizeFrom` (an image), after fonts and images load. The page background
 * is transparent, so a picture with an alpha channel keeps it.
 *
 * Returns `{ width, height, missingFonts, overflowing }`: the `fontFamilies`
 * that did not load (so a fallback was drawn), and whether the element
 * matched by `fitSelector` ran past the picture's edges — in which case
 * nothing is written.
 */
export async function renderPage({ html, sizeFrom, output, fontFamilies = [], fitSelector = null, timeoutMs = 60_000 }) {
  const chrome = requireChrome();

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "grok-render-"));
  const page = path.join(profile, "page.html");
  fs.writeFileSync(page, html, "utf8");

  let child = null;
  let timer = null;
  const onSignal = (signal) => {
    if (child) {
      killGroup(child);
    }
    removeProfile(profile);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    child = spawn(chrome, [...CHROME_FLAGS, `--user-data-dir=${profile}`, "about:blank"], {
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      detached: true
    });
    const devtools = new DevToolsPipe(child.stdio[3], child.stdio[4]);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });

    const failed = new Promise((_, reject) => {
      const stop = (error) => {
        devtools.close(error);
        reject(error);
      };
      timer = setTimeout(() => {
        killGroup(child);
        stop(new MediaToolError(`Chrome did not finish rendering within ${Math.round(timeoutMs / 1000)}s.`, 2));
      }, timeoutMs);
      child.on("error", (error) => stop(new MediaToolError(`Chrome could not start: ${error.message}`, 2)));
      child.on("exit", (code, signal) =>
        stop(new MediaToolError(`Chrome exited early (${signal ?? `code ${code}`}).${stderr ? `\n${stderr.trim().split("\n").slice(-5).join("\n")}` : ""}`, 2))
      );
    });
    failed.catch(() => {});

    const render = async () => {
      const { targetId } = await devtools.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await devtools.send("Target.attachToTarget", { targetId, flatten: true });
      await devtools.send("Page.enable", {}, sessionId);
      await devtools.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }, sessionId);
      const loaded = devtools.waitFor("Page.loadEventFired", sessionId);
      loaded.catch(() => {}); // awaited below, unless the failure that rejected it wins the race first
      await devtools.send("Page.navigate", { url: pathToFileURL(page).href }, sessionId);
      await loaded;

      const { width, height } = await evaluate(devtools, sessionId, readinessScript(sizeFrom));
      if (!width || !height) {
        throw new MediaToolError("Chrome could not read the base image's size.", 2);
      }
      await devtools.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
      // Lay out again at the new size, and let any font the new layout needs finish loading.
      const { loaded: loadedFonts } = await evaluate(
        devtools,
        sessionId,
        `new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))).then(() => ${readinessScript(sizeFrom)})`
      );
      const missingFonts = fontFamilies.filter((family) => !loadedFonts.includes(family));
      if (fitSelector && (await evaluate(devtools, sessionId, overflowScript(fitSelector)))) {
        return { width, height, missingFonts, overflowing: true };
      }
      const shot = await devtools.send(
        "Page.captureScreenshot",
        { format: "png", clip: { x: 0, y: 0, width, height, scale: 1 }, captureBeyondViewport: false },
        sessionId
      );
      fs.writeFileSync(output, Buffer.from(shot.data, "base64"));
      return { width, height, missingFonts, overflowing: false };
    };

    const result = await Promise.race([render(), failed]);
    devtools.send("Browser.close").catch(() => {});
    return result;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (child) {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve) => {
          const grace = setTimeout(resolve, CLOSE_GRACE_MS);
          child.once("exit", () => {
            clearTimeout(grace);
            resolve();
          });
        });
      }
      killGroup(child);
    }
    removeProfile(profile);
  }
}
