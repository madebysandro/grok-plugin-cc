/**
 * Black-box harness for the companion.
 *
 * `createSandbox(t)` lays out a temp directory with a workspace, a Grok home,
 * a plugin data dir and a fake `grok` (see `fake-grok.mjs`), removed when the
 * test ends. `run()` executes the companion as a process against it, so a test
 * observes only what a user would — output, exit code, files, manifest — plus
 * what reached Grok.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { PLUGIN_ROOT, cleanup, makeTempDir } from "./helpers.mjs";

const COMPANION = path.join(PLUGIN_ROOT, "scripts", "grok-companion.mjs");
const FAKE_GROK = path.join(import.meta.dirname, "fake-grok.mjs");

/** Far above a normal run; only there so a hung companion cannot stall CI. */
const RUN_TIMEOUT_MS = 30_000;

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function createSandbox(t) {
  // Resolved up front so paths printed by the companion (which sees the
  // physical cwd) compare equal to ours — `/var` is a symlink on macOS.
  const root = fs.realpathSync(makeTempDir("grok-plugin-e2e-"));
  t.after(() => cleanup(root));
  const dirs = {
    workspace: path.join(root, "workspace"),
    grokHome: path.join(root, "grok-home"),
    pluginData: path.join(root, "plugin-data"),
    home: path.join(root, "home"),
    control: path.join(root, "fake-grok")
  };
  for (const dir of Object.values(dirs)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const grokBin = path.join(root, "bin", "grok");
  fs.mkdirSync(path.dirname(grokBin));
  fs.writeFileSync(
    grokBin,
    `#!/bin/sh\nexec ${[process.execPath, FAKE_GROK, dirs.control].map(shellQuote).join(" ")} "$@"\n`,
    { mode: 0o755 }
  );

  // A minimal env, built from scratch: nothing from the real Grok setup, the
  // real plugin state or the host session (CLAUDE_PROJECT_DIR) leaks in.
  const env = {
    PATH: process.env.PATH,
    HOME: dirs.home,
    GROK_BIN: grokBin,
    GROK_HOME: dirs.grokHome,
    CLAUDE_PLUGIN_DATA: dirs.pluginData
  };

  return {
    workspace: dirs.workspace,
    grokHome: dirs.grokHome,
    pluginData: dirs.pluginData,
    grokBin,

    /** Script what the fake grok does on its next runs. */
    scenario(value) {
      fs.writeFileSync(path.join(dirs.control, "scenario.json"), JSON.stringify(value));
    },

    /** Every run of the fake grok so far, as `{ args, env, cwd }`. */
    grokCalls() {
      const file = path.join(dirs.control, "calls.jsonl");
      if (!fs.existsSync(file)) {
        return [];
      }
      return fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },

    /** Run the companion; resolves with `{ code, stdout, stderr }`. */
    run(args) {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [COMPANION, ...args], {
          cwd: dirs.workspace,
          env,
          timeout: RUN_TIMEOUT_MS
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code, signal) => {
          if (signal) {
            reject(new Error(`companion was killed by ${signal} (timeout ${RUN_TIMEOUT_MS} ms)\n${stderr}`));
            return;
          }
          resolve({ code, stdout, stderr });
        });
      });
    }
  };
}
