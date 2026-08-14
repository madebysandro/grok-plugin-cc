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

- If the Grok CLI is missing, point the user at https://github.com/xai-org/grok-cli. Do not try to install it yourself — Grok ships its own installer, and the right command depends on the platform.
- If the CLI is installed but not signed in, tell the user to run `!grok login`. Do not run it for them; it is interactive.
- If the check reports that video is blocked by Zero Data Retention, relay that section verbatim. It is an account setting on the xAI side, not something this plugin or Claude can change. Image generation and editing still work, so say so rather than implying the plugin is unusable.
- Do not re-run the check more than once in a turn.
