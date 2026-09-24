# Changelog

## Unreleased

### Isolated media runs

- Media commands give Grok only the tools they need (`--tools`: image → `image_gen`, edit → `image_edit`, animate → `image_to_video`, video → `image_gen,image_to_video`). They also turn off subagents, web search and auto-update, and run under a session id the plugin generates.
- Media runs switch off Grok's loading of the user's Claude and Cursor setup (`GROK_{CLAUDE,CURSOR}_*_ENABLED=false`): skills, hooks, MCP servers and rules from `~/.claude` and `~/.cursor`, and the skills Claude plugins provide. Claude plugins themselves still load, with their hooks and agents, because Grok has no switch for them; see the `grok-cli-runtime` skill.
- Recursion guard: every Grok process the plugin starts gets `GROK_PLUGIN_CC_WORKER=1`, and media commands refuse to run when it is set. `ask` behaves as before apart from carrying that marker.

Measured on Grok CLI 1.0.41 with one 1:1 image and the same prompt, one run before and one after (details in `docs/live-tests.md`):

| | Before | After | Change |
| --- | --- | --- | --- |
| Wall time | 23.8 s | 14.7 s | −38 % |
| Input tokens, uncached | 28,306 | 21,826 | −23 % |
| Input tokens, cache read | 29,952 | 4,224 | −86 % |
| Total tokens | 58,596 | 26,141 | −55 % |
| Cost reported by Grok | $0.0250 | $0.0157 | −37 % |
| Tools offered to the agent | 15 | 1 | |

One run on each side, so treat the times as indicative. The drop in offered tools comes from `--tools`; the token and time savings come from the whole lock-down and are not split between its parts.

## 1.0.0

Initial release.

- `/grok:image`, `/grok:edit`, `/grok:video`, `/grok:animate` for media generation
- `/grok:ask` for general delegation to Grok
- `/grok:setup`, `/grok:status`, `/grok:result`, `/grok:cancel`
- `grok-media` subagent for multi-asset work
- Skills: `grok-cli-runtime`, `grok-imagine-prompting`, `grok-media-results`
- Assets harvested from Grok's session log rather than copied by the agent
- Zero Data Retention video blocking detected and explained up front
