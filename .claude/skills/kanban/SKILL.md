---
name: kanban
description: Durable multi-agent Kanban board (port of Hermes Agent Kanban). Use when the user runs /kanban, wants to plan work as cards, fan work out to parallel workers (Claude or DeepSeek), chain tasks with dependencies, check board status, or unblock/review agent work.
---

# Kanban

A SQLite task board in `.kanban/` that named workers collaborate through. Work
survives restarts, humans can comment and unblock, and every transition is logged.

- **Tools (you):** the `kanban` MCP server from `.mcp.json` gives you `kanban_board`,
  `kanban_list`, `kanban_show`, `kanban_create`, `kanban_link`, `kanban_comment`,
  `kanban_unblock`, and the rest.
- **CLI (fallback / humans):** `python3 .claude/kanban/kanban.py <verb>`. Run it with
  no args or `--help` for the verbs.
- **Dispatcher:** `python3 .claude/kanban/kanban.py dispatch --loop` spawns a headless
  worker (`claude -p`, or any harness set up in `.kanban/config.json`) for each `ready`
  card whose assignee is a configured profile. Assignees that aren't profiles (for example
  a person's name) are never spawned.

## `/kanban <args>`

If the user passes arguments, run the CLI with them verbatim and show the output:
`python3 .claude/kanban/kanban.py $ARGUMENTS`. With no arguments, show `kanban_board`.

## Acting as orchestrator

1. Split the goal into cards that each fit one worker session. Write the body as a
   full brief: goal, constraints, acceptance criteria, and where to look.
2. Pick the shape:
   - **Fan-out:** several parallel siblings, then one synthesis card with
     `parents=[...]`. It stays in `todo` until every parent is `done`, and then
     `kanban_show` gives it every parent's summary and metadata.
   - **Pipeline:** a chain of cards, each the parent of the next.
   - **Quorum:** N siblings working the same question plus one aggregator.
   - **Human in the loop:** assign to a person, or the worker blocks with `needs_input`.
3. Choose the workspace: `dir:.` (default, the repo), `scratch` (a throwaway dir),
   `worktree` (a git worktree on branch `kanban/<id>`; use it for parallel code changes
   so workers don't collide).
4. Route cost: hard or ambiguous cards go to `claude`/`reviewer`. Mechanical cards go
   to a cheap profile such as `deepseek`.
5. Use `idempotency_key` for recurring cards so re-running doesn't create duplicates.
6. Tell the user to start (or run once) the dispatcher. Don't do the cards' work
   yourself unless asked.

## Card lifecycle

`triage → todo → ready → running → (review | blocked) → done → archived`

- Promotion: `todo` → `ready` when all parents are done. A card blocked with
  `dependency` resumes on its own.
- A worker that exits without a terminal call (`complete` / `request_review` /
  `block`) counts as a failure and the card is retried. After `failure_limit`
  failures it is auto-blocked. Exit code 75 (rate limit) requeues without counting.
- Blocking three times in a row for the same reason sends the card back to `triage`
  for re-planning.
- A worker with no heartbeat for `stale_timeout_seconds` is killed and reclaimed.
- Review: `approve <id>` → done, `request-changes <id> "..."` → back to ready,
  with a comment.

## Good handoff metadata

`kanban_complete(summary, metadata)` should answer four questions:
`{"changed_files": [...], "verification": ["cmd run"], "residual_risk": [...], "retry_notes": "..."}`
