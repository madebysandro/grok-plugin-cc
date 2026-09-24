# Live test log

Every live Grok run made while building Round 1 of the fork. The spec allows at most 12 generations for the round (`docs/spec-paridade-higgsfield.md` §6), always in the smallest configuration. No credentials or account details are recorded here.

Grok CLI 1.0.41 (4220f3b224a6), macOS arm64. Generations used so far: **2 of 12**.

## Generations

| # | Date (UTC) | Issue | Command | Result | Output | Session |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2026-09-24 23:26 | #3, before isolation (companion at `7f7a202`) | `image "a red apple on a white table" --aspect 1:1` | ok · 23.8 s · 2 turns · input tokens 28,306 uncached + 29,952 cache read · 58,596 total · $0.0250 · 15 tools offered | 1024×1024 JPEG, 178,527 B | `01a0d5be-4ca6-7493-b9bf-3193dbb3a3b6` |
| 2 | 2026-09-24 23:29 | #3, after isolation | same | ok · 14.7 s · 2 turns · input tokens 21,826 uncached + 4,224 cache read · 26,141 total · $0.0157 · only `image_gen` offered | 1024×1024 JPEG, 186,408 B | `dc85367b-7d8f-4372-8f99-3bb95c91ec76` |

Session 2's id is the UUID the plugin generated, which confirms Grok accepted `--session-id`. The offered tools come from each session's `tool_definitions.json`.

## Checks that generate nothing

### `grok inspect --json` with and without isolation (2026-09-24, #3)

Run in an empty directory, once with the normal environment and once with the ten `GROK_{CLAUDE,CURSOR}_*_ENABLED=false` variables that media runs set.

| Source | Normal | Isolated |
| --- | --- | --- |
| Skills in `~/.claude/skills` (100) | enabled | disabled |
| Skills provided by Claude plugins (55, including this plugin's 3) | enabled | disabled |
| Claude hooks (9) | enabled | disabled |
| MCP servers from `~/.cursor/mcp.json` (7) and `~/.claude.json` (2) | enabled | disabled |
| Claude plugins (14, including this one) | listed, enabled | listed, enabled |
| Hooks provided by Claude plugins (5) | no status | no status |
| Agents provided by Claude plugins (2, including this plugin's `grok-media`) | no status | no status |
| Grok's built-in agents (3) | loaded | loaded |
| Grok's own skills (`~/.grok/skills`, `~/.agents/skills`, bundled: 61), hook in `~/.grok/hooks` (1) and `config.toml` MCP server (1) | loaded | loaded |

Result: Claude plugins still load under isolation. Their skills are switched off, but the plugins stay enabled, and the hooks and agents they provide report no compatibility status, so they appear to keep loading. No documented variable turns plugins off. Media runs also pass `--no-subagents`, so the agents cannot be spawned. The recursion guard (`GROK_PLUGIN_CC_WORKER`) covers the risk of Grok calling back into this plugin.
