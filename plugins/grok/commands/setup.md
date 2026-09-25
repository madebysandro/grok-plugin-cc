---
description: Check whether the local Grok CLI is installed, signed in, and able to generate images and video
allowed-tools: Bash(node:*), Bash(grok:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" setup
```

Present the output to the user as-is.

Follow-up rules:

- If the Grok CLI is missing, point the user at https://x.ai/build. Do not try to install it yourself — Grok ships its own installer, and the right command depends on the platform.
- If the CLI is installed but not signed in, tell the user to run `!grok login`. Do not run it for them; it is interactive.
- If the check reports that video is blocked by Zero Data Retention, relay that section verbatim. It is an account setting on the xAI side, not something this plugin or Claude can change. Image generation and editing still work, so say so rather than implying the plugin is unusable.
- The compatibility lines cost nothing: setup reads the session folders and settings cache Grok already left on disk, and never generates.
  - `FAIL` on "Media tools" or "Session log format" means a Grok CLI update changed something the plugin relies on. Say so, and advise against media commands until the plugin is updated: generated files may not be collected.
  - `WARN` on "Video limits" means Grok now advertises a resolution or duration the plugin does not allow yet. It is informational.
  - "Plan" shows the subscription and whether image/video generation are on, from Grok's settings cache. `WARN` on "Image generation" or "Video generation" with "disabled for this account in Grok's settings" means that cache says the feature is off: relay it, but it does not block, and a generation will confirm either way.
  - `--` (not verified) means nothing on disk could tell yet, for example before the first generation. It does not block; do not present it as an error.
- Do not re-run the check more than once in a turn.
