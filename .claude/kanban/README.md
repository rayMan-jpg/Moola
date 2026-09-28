# Kanban for Claude Code

A port of [Hermes Agent Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban)
to Claude Code: a durable SQLite task board that headless workers (Claude, DeepSeek, or any
MCP-capable harness) collaborate through. It is one standard-library Python file, with no
dependencies.

| Hermes | Here |
|---|---|
| `~/.hermes/kanban.db` | `<repo>/.kanban/kanban.db` (or `$KANBAN_DB`) |
| `kanban_*` model tools | MCP server `kanban` (`kanban.py mcp`, registered in `/.mcp.json`) |
| `hermes kanban <verb>` / `/kanban` | `python3 .claude/kanban/kanban.py <verb>` / the `/kanban` skill |
| Profiles (`hermes -p <name>`) | `profiles` in `.kanban/config.json` → `claude -p` or a custom command |
| Gateway dispatcher | `kanban.py dispatch --loop` |
| Workspaces `scratch` / `dir:` / `worktree` | same |

## Quick start

```bash
python3 .claude/kanban/kanban.py init
cp .claude/kanban/config.example.json .kanban/config.json   # optional: add DeepSeek etc.

K="python3 .claude/kanban/kanban.py"
A=$($K create "research option A" --assignee deepseek | awk '{print $2}')
B=$($K create "research option B" --assignee deepseek | awk '{print $2}')
$K create "compare A and B, write docs/decision.md" --assignee claude --parent $A --parent $B
$K dispatch --loop          # spawns workers; the synthesis card runs after both parents finish
$K board                    # or: watch, show <id>, stats, log <id>
```

Or ask Claude in chat, for example: "/kanban — plan the auth refactor as cards, run the tests
on DeepSeek, the design on Claude."

## DeepSeek workers

DeepSeek serves an Anthropic-compatible API, so a DeepSeek worker is Claude Code pointed at it.
Set `DEEPSEEK_API_KEY` and use the `deepseek` profile from `config.example.json`
(`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`). For a different harness entirely,
use `"harness": "custom"` with a `command` template (`{prompt}`, `{mcp_config}`, `{model}`,
`{task}` and `{workspace}` are substituted). The harness only has to load the MCP config and
follow the prompt.

## Not ported (yet)

Web dashboard, multiple boards, attachments, goal-mode judge loop, auto-decompose/specify,
PR completion contracts, chat notification subscriptions, plugin hooks.
