#!/usr/bin/env python3
"""Durable Kanban board for Claude Code (and any MCP-capable agent harness).

A port of the Hermes Agent Kanban idea: a SQLite-backed task board that named
workers collaborate through, instead of in-process subagent swarms.

  * Humans drive it with the CLI:      python3 .claude/kanban/kanban.py <verb>
  * Agents drive it with MCP tools:    python3 .claude/kanban/kanban.py mcp
  * The dispatcher spawns workers:     python3 .claude/kanban/kanban.py dispatch --loop

Standard library only. State lives in <project>/.kanban/ unless KANBAN_DB is set.
"""
import argparse
import json
import os
import secrets
import signal
import sqlite3
import subprocess
import sys
import time

SCRIPT = os.path.abspath(__file__)
STATUSES = ["triage", "todo", "ready", "running", "blocked", "review", "done", "archived"]
BLOCK_KINDS = ["dependency", "needs_input", "capability", "transient"]
EX_TEMPFAIL = 75  # worker hit a rate limit / quota: requeue without counting a failure

DEFAULT_CONFIG = {
    "default_assignee": "claude",
    "failure_limit": 2,
    "stale_timeout_seconds": 14400,
    "dispatch_interval_seconds": 60,
    "max_in_progress": None,
    "max_in_progress_per_profile": None,
    "profiles": {"claude": {"harness": "claude"}},
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT DEFAULT '', assignee TEXT,
  status TEXT NOT NULL, priority INTEGER DEFAULT 0, workspace TEXT, model TEXT,
  result TEXT, metadata TEXT, idempotency_key TEXT UNIQUE,
  block_kind TEXT, block_reason TEXT, block_count INTEGER DEFAULT 0,
  failures INTEGER DEFAULT 0, pid INTEGER, created_by TEXT,
  created_at REAL, updated_at REAL, claimed_at REAL, heartbeat_at REAL, completed_at REAL);
CREATE TABLE IF NOT EXISTS links(parent TEXT NOT NULL, child TEXT NOT NULL, PRIMARY KEY(parent, child));
CREATE TABLE IF NOT EXISTS comments(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, author TEXT, body TEXT, ts REAL);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, kind TEXT, payload TEXT, ts REAL);
"""

WORKER_PROMPT = """You are a Kanban worker assigned card {id}: "{title}".

Protocol:
1. Call kanban_show first. Read the body, the parent task results (handoffs) and all comments.
2. Do the work. Your working directory is {workspace}.
3. On long work, call kanban_heartbeat(note=...) now and then so the dispatcher knows you are alive.
4. Finish with exactly ONE terminal call:
   - kanban_complete(summary, metadata) when the work is done. metadata should say what changed
     (changed_files), how you verified it (verification) and what risk remains (residual_risk).
   - kanban_request_review(summary) when a human or reviewer must approve before it counts as done.
   - kanban_block(reason, kind) when you cannot proceed. kind is one of: needs_input, capability,
     dependency, transient.
Exiting without a terminal call counts as a failure and the card will be retried.
You may split off follow-up work with kanban_create (use parents=[...] to chain it after other cards).
"""


class KanbanError(Exception):
    pass


# ---------------------------------------------------------------- storage

def project_root():
    if os.environ.get("KANBAN_ROOT"):
        return os.path.abspath(os.environ["KANBAN_ROOT"])
    try:
        out = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True)
        return out.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return os.getcwd()


def state_dir():
    if os.environ.get("KANBAN_DB"):
        return os.path.dirname(os.path.abspath(os.environ["KANBAN_DB"]))
    return os.path.join(project_root(), ".kanban")


def db_path():
    return os.path.abspath(os.environ.get("KANBAN_DB") or os.path.join(state_dir(), "kanban.db"))


def connect():
    os.makedirs(os.path.dirname(db_path()), exist_ok=True)
    c = sqlite3.connect(db_path(), timeout=30, isolation_level=None)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.executescript(SCHEMA)
    return c


def load_config():
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    path = os.path.join(state_dir(), "config.json")
    if os.path.exists(path):
        with open(path) as f:
            user = json.load(f)
        cfg.update({k: v for k, v in user.items() if k != "profiles"})
        if "profiles" in user:
            cfg["profiles"] = user["profiles"]
    return cfg


def now():
    return time.time()


def fmt_ts(ts):
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(ts)) if ts else "-"


def event(c, tid, kind, **payload):
    c.execute("INSERT INTO events(task_id, kind, payload, ts) VALUES(?,?,?,?)",
              (tid, kind, json.dumps(payload), now()))


def get(c, tid):
    row = c.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
    if not row:
        raise KanbanError(f"no such task: {tid}")
    return dict(row)


def update(c, tid, **fields):
    fields["updated_at"] = now()
    cols = ", ".join(f"{k}=?" for k in fields)
    c.execute(f"UPDATE tasks SET {cols} WHERE id=?", (*fields.values(), tid))


def parents(c, tid):
    return [r[0] for r in c.execute("SELECT parent FROM links WHERE child=?", (tid,))]


def children(c, tid):
    return [r[0] for r in c.execute("SELECT child FROM links WHERE parent=?", (tid,))]


def parents_done(c, tid):
    return all(get(c, p)["status"] in ("done", "archived") for p in parents(c, tid))


def ancestors(c, tid, seen=None):
    seen = set() if seen is None else seen
    for p in parents(c, tid):
        if p not in seen:
            seen.add(p)
            ancestors(c, p, seen)
    return seen


# ---------------------------------------------------------------- operations

def create(c, title, body="", assignee=None, parent_ids=(), priority=0, workspace=None,
           triage=False, idempotency_key=None, model=None, author="human"):
    if idempotency_key:
        row = c.execute("SELECT id FROM tasks WHERE idempotency_key=?", (idempotency_key,)).fetchone()
        if row:
            return row[0]
    for p in parent_ids:
        get(c, p)
    tid = "t_" + secrets.token_hex(3)
    ts = now()
    c.execute("BEGIN IMMEDIATE")
    c.execute("""INSERT INTO tasks(id, title, body, assignee, status, priority, workspace, model,
                 idempotency_key, created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
              (tid, title, body or "", assignee, "todo", priority, workspace, model, idempotency_key, author, ts, ts))
    for p in parent_ids:
        c.execute("INSERT OR IGNORE INTO links(parent, child) VALUES(?,?)", (p, tid))
    status = "triage" if triage else ("ready" if parents_done(c, tid) else "todo")
    update(c, tid, status=status)
    event(c, tid, "created", status=status, assignee=assignee, parents=list(parent_ids), by=author)
    c.execute("COMMIT")
    return tid


def promote(c):
    """todo -> ready, and dependency-blocked -> ready, once every parent is done."""
    promoted = []
    for row in c.execute("SELECT id, status, block_kind FROM tasks WHERE status IN ('todo','blocked')").fetchall():
        if row["status"] == "blocked" and row["block_kind"] != "dependency":
            continue
        if parents_done(c, row["id"]):
            update(c, row["id"], status="ready", block_kind=None, block_reason=None)
            event(c, row["id"], "promoted", from_status=row["status"])
            promoted.append(row["id"])
    return promoted


def complete(c, tid, summary, metadata=None, author="human"):
    get(c, tid)
    update(c, tid, status="done", result=summary, metadata=json.dumps(metadata) if metadata else None,
           completed_at=now(), pid=None, block_kind=None, block_reason=None, block_count=0, failures=0)
    event(c, tid, "completed", summary=summary, by=author)
    promote(c)


def request_review(c, tid, summary, author="human"):
    get(c, tid)
    update(c, tid, status="review", result=summary, pid=None)
    event(c, tid, "review_requested", summary=summary, by=author)


def request_changes(c, tid, changes, author="human"):
    add_comment(c, tid, f"Changes requested: {changes}", author)
    update(c, tid, status="ready" if parents_done(c, tid) else "todo")
    event(c, tid, "changes_requested", by=author)


def block(c, tid, reason, kind="needs_input", author="human"):
    if kind not in BLOCK_KINDS:
        raise KanbanError(f"kind must be one of {BLOCK_KINDS}")
    t = get(c, tid)
    count = t["block_count"] + 1 if t["block_kind"] == kind else 1
    # Re-blocking for the same reason more than twice escalates back to triage for re-planning.
    status = "triage" if count > 2 else "blocked"
    update(c, tid, status=status, block_kind=kind, block_reason=reason, block_count=count, pid=None)
    event(c, tid, "blocked" if status == "blocked" else "escalated", reason=reason, kind=kind, by=author)
    if status == "blocked" and kind == "dependency":
        promote(c)


def unblock(c, tid, author="human"):
    get(c, tid)
    status = "ready" if parents_done(c, tid) else "todo"
    update(c, tid, status=status, block_kind=None, block_reason=None)
    event(c, tid, "unblocked", status=status, by=author)


def add_comment(c, tid, body, author="human"):
    get(c, tid)
    c.execute("INSERT INTO comments(task_id, author, body, ts) VALUES(?,?,?,?)", (tid, author, body, now()))
    event(c, tid, "comment", by=author)


def heartbeat(c, tid, note=None, author="worker"):
    get(c, tid)
    update(c, tid, heartbeat_at=now())
    event(c, tid, "heartbeat", note=note, by=author)


def link(c, parent, child):
    get(c, parent)
    get(c, child)
    if parent == child or child in ancestors(c, parent):
        raise KanbanError("link would create a cycle")
    c.execute("INSERT OR IGNORE INTO links(parent, child) VALUES(?,?)", (parent, child))
    t = get(c, child)
    if t["status"] == "ready" and not parents_done(c, child):
        update(c, child, status="todo")
    event(c, child, "linked", parent=parent)


def unlink(c, parent, child):
    c.execute("DELETE FROM links WHERE parent=? AND child=?", (parent, child))
    event(c, child, "unlinked", parent=parent)
    promote(c)


def move(c, tid, status, author="human"):
    if status not in STATUSES:
        raise KanbanError(f"status must be one of {STATUSES}")
    get(c, tid)
    update(c, tid, status=status)
    event(c, tid, "moved", status=status, by=author)
    if status == "done":
        promote(c)


# ---------------------------------------------------------------- rendering

def render_show(c, tid):
    t = get(c, tid)
    out = [f"# {t['id']}: {t['title']}",
           f"status: {t['status']}   assignee: {t['assignee'] or '-'}   priority: {t['priority']}"
           f"   workspace: {t['workspace'] or 'dir:.'}   failures: {t['failures']}"]
    if t["block_reason"]:
        out.append(f"blocked ({t['block_kind']}): {t['block_reason']}")
    if t["body"]:
        out += ["", "## Body", t["body"]]
    ps = parents(c, tid)
    if ps:
        out += ["", "## Parent task results"]
        for p in ps:
            pt = get(c, p)
            out.append(f"### {p} {pt['title']} ({pt['status']})")
            out.append(pt["result"] or "(no result yet)")
            if pt["metadata"]:
                out.append(f"_metadata_: {pt['metadata']}")
    ch = children(c, tid)
    if ch:
        out += ["", "## Children: " + ", ".join(f"{x} ({get(c, x)['status']})" for x in ch)]
    if t["result"]:
        out += ["", "## Result", t["result"]]
        if t["metadata"]:
            out.append(f"_metadata_: {t['metadata']}")
    comments = c.execute("SELECT * FROM comments WHERE task_id=? ORDER BY id", (tid,)).fetchall()
    if comments:
        out += ["", "## Comments"]
        out += [f"- [{fmt_ts(r['ts'])}] {r['author']}: {r['body']}" for r in comments]
    return "\n".join(out)


def list_tasks(c, status=None, assignee=None, include_archived=False):
    q, args = "SELECT * FROM tasks WHERE 1=1", []
    if status:
        q += " AND status=?"
        args.append(status)
    elif not include_archived:
        q += " AND status!='archived'"
    if assignee:
        q += " AND assignee=?"
        args.append(assignee)
    q += " ORDER BY priority DESC, created_at"
    return [dict(r) for r in c.execute(q, args)]


def render_list(rows):
    if not rows:
        return "(no tasks)"
    return "\n".join(f"{t['id']}  {t['status']:<8} p{t['priority']:<2} {(t['assignee'] or '-'):<12} {t['title']}"
                     for t in rows)


def render_board(c):
    out = []
    for s in STATUSES[:-1]:
        rows = list_tasks(c, status=s)
        out.append(f"== {s.upper()} ({len(rows)})")
        out += [f"   {t['id']}  {(t['assignee'] or '-'):<12} {t['title']}" for t in rows]
    return "\n".join(out)


def render_stats(c):
    by_status = dict(c.execute("SELECT status, COUNT(*) FROM tasks GROUP BY status").fetchall())
    by_assignee = c.execute("SELECT COALESCE(assignee,'-'), status, COUNT(*) FROM tasks "
                            "WHERE status!='archived' GROUP BY 1, 2").fetchall()
    out = ["status:   " + "  ".join(f"{s}={by_status.get(s, 0)}" for s in STATUSES)]
    per = {}
    for a, s, n in by_assignee:
        per.setdefault(a, []).append(f"{s}={n}")
    out += [f"{a:<12} " + " ".join(v) for a, v in sorted(per.items())]
    return "\n".join(out)


# ---------------------------------------------------------------- dispatcher

def pid_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().split(")")[-1].split()[0] != "Z"
    except OSError:
        return True


def fail(c, cfg, t, reason, count=True):
    failures = t["failures"] + (1 if count else 0)
    if failures >= cfg["failure_limit"]:
        update(c, t["id"], status="blocked", block_kind="capability", pid=None, failures=failures,
               block_reason=f"auto-blocked after {failures} failures; last: {reason}")
    else:
        update(c, t["id"], status="ready", pid=None, failures=failures)
    event(c, t["id"], "failed", reason=reason, failures=failures)


def prepare_workspace(t, root):
    ws = t["workspace"] or "dir:."
    if ws == "scratch":
        path = os.path.join(state_dir(), "workspaces", t["id"])
        os.makedirs(path, exist_ok=True)
        return path
    if ws.startswith("worktree"):
        path = ws.split(":", 1)[1] if ":" in ws else os.path.join(".worktrees", t["id"])
        path = os.path.join(root, path)
        if not os.path.exists(path):
            branch = f"kanban/{t['id']}"
            has_branch = subprocess.run(["git", "-C", root, "rev-parse", "--verify", "--quiet", branch],
                                        capture_output=True).returncode == 0
            cmd = ["git", "-C", root, "worktree", "add", path] + ([branch] if has_branch else ["-b", branch])
            subprocess.run(cmd, check=True, capture_output=True)
        return path
    if ws.startswith("dir:"):
        path = os.path.join(root, ws[4:])
        os.makedirs(path, exist_ok=True)
        return os.path.abspath(path)
    raise KanbanError(f"unknown workspace kind: {ws}")


def worker_command(prof, t, prompt, mcp_config, workspace):
    model = t["model"] or prof.get("model")
    if prof.get("harness", "claude") == "claude":
        cmd = [prof.get("bin", "claude"), "-p", prompt, "--mcp-config", mcp_config, "--strict-mcp-config",
               "--permission-mode", prof.get("permission_mode", "acceptEdits"),
               "--allowedTools", "mcp__kanban"]
        if model:
            cmd += ["--model", model]
        return cmd + prof.get("args", [])
    # Any other harness: a command template with placeholders.
    subs = {"prompt": prompt, "mcp_config": mcp_config, "task": t["id"], "workspace": workspace, "model": model or ""}
    return [a.format(**subs) for a in prof["command"]]


def spawn(c, cfg, t, procs):
    root = project_root()
    prof = cfg["profiles"][t["assignee"]]
    workspace = prepare_workspace(t, root)
    logs = os.path.join(state_dir(), "logs")
    os.makedirs(logs, exist_ok=True)
    kanban_env = {"KANBAN_DB": db_path(), "KANBAN_ROOT": root, "KANBAN_TASK": t["id"],
                  "KANBAN_AUTHOR": t["assignee"], "KANBAN_WORKSPACE": workspace}
    mcp_config = os.path.join(logs, f"{t['id']}.mcp.json")
    with open(mcp_config, "w") as f:
        json.dump({"mcpServers": {"kanban": {"command": sys.executable, "args": [SCRIPT, "mcp"],
                                             "env": kanban_env}}}, f, indent=2)
    prompt = WORKER_PROMPT.format(id=t["id"], title=t["title"], workspace=workspace)
    env = dict(os.environ)
    env.update({k: os.path.expandvars(str(v)) for k, v in prof.get("env", {}).items()})
    env.update(kanban_env)
    cmd = worker_command(prof, t, prompt, mcp_config, workspace)
    log = open(os.path.join(logs, f"{t['id']}.log"), "a")
    log.write(f"\n=== {fmt_ts(now())} spawn {t['assignee']}: {cmd[0]} ===\n")
    log.flush()
    p = subprocess.Popen(cmd, cwd=workspace, env=env, stdin=subprocess.DEVNULL, stdout=log,
                         stderr=subprocess.STDOUT, start_new_session=True)
    log.close()
    procs[p.pid] = p
    ts = now()
    update(c, t["id"], status="running", pid=p.pid, claimed_at=ts, heartbeat_at=ts)
    event(c, t["id"], "claimed", assignee=t["assignee"], pid=p.pid)


def dispatch(c, cfg, dry_run=False, max_spawn=None, procs=None):
    procs = {} if procs is None else procs
    lines = []
    for t in ([] if dry_run else list_tasks(c, status="running")):
        pid, rc = t["pid"], None
        if pid in procs:
            rc = procs[pid].poll()
            finished = rc is not None
        else:
            finished = not pid or not pid_alive(pid)
        stale = (t["heartbeat_at"] or t["claimed_at"] or 0) < now() - cfg["stale_timeout_seconds"]
        if finished:
            procs.pop(pid, None)
            if get(c, t["id"])["status"] == "running":
                # The worker's own MCP call normally moves the card; still "running" means it never did.
                fail(c, cfg, t, f"worker exited (rc={rc}) without a terminal kanban call", count=rc != EX_TEMPFAIL)
                lines.append(f"reclaimed {t['id']}: worker exited without finishing")
        elif stale:
            try:
                os.killpg(pid, signal.SIGTERM)
            except OSError:
                pass
            fail(c, cfg, t, "stale: no heartbeat")
            lines.append(f"reclaimed {t['id']}: stale heartbeat")
    if not dry_run:
        lines += [f"promoted {tid}" for tid in promote(c)]

    running = list_tasks(c, status="running")
    spawned = 0
    for t in list_tasks(c, status="ready"):
        if max_spawn is not None and spawned >= max_spawn:
            break
        if cfg["max_in_progress"] and len(running) >= cfg["max_in_progress"]:
            break
        assignee = t["assignee"] or cfg["default_assignee"]
        if assignee not in cfg["profiles"]:
            continue  # a human (or unknown) assignee: never auto-spawned
        cap = cfg["max_in_progress_per_profile"]
        if cap and sum(r["assignee"] == assignee for r in running) >= cap:
            continue
        t["assignee"] = assignee
        if dry_run:
            lines.append(f"would spawn {t['id']} -> {assignee}")
        else:
            if not get(c, t["id"])["assignee"]:
                update(c, t["id"], assignee=assignee)
            spawn(c, cfg, t, procs)
            lines.append(f"spawned {t['id']} -> {assignee}")
        running.append(t)
        spawned += 1
    return lines


# ---------------------------------------------------------------- MCP server (stdio, JSON-RPC)

def _schema(props, required=()):
    return {"type": "object", "properties": props, "required": list(required)}


_TID = {"task_id": {"type": "string", "description": "Task id; defaults to your own card ($KANBAN_TASK)."}}
MCP_TOOLS = [
    ("kanban_show", "Show a task: body, parent handoffs, comments. Call this first as a worker.", _schema(_TID)),
    ("kanban_list", "List tasks, optionally filtered by status or assignee.",
     _schema({"status": {"type": "string", "enum": STATUSES}, "assignee": {"type": "string"}})),
    ("kanban_board", "Show the whole board grouped by column.", _schema({})),
    ("kanban_create", "Create a task. Tasks with parents stay in todo until every parent is done.",
     _schema({"title": {"type": "string"}, "body": {"type": "string"}, "assignee": {"type": "string"},
              "parents": {"type": "array", "items": {"type": "string"}}, "priority": {"type": "integer"},
              "workspace": {"type": "string", "description": "dir:<path> | scratch | worktree | worktree:<path>"},
              "model": {"type": "string"}, "triage": {"type": "boolean"},
              "idempotency_key": {"type": "string"}}, ["title"])),
    ("kanban_complete", "Terminal: mark the task done with a handoff summary and metadata.",
     _schema({**_TID, "summary": {"type": "string"}, "metadata": {"type": "object"}}, ["summary"])),
    ("kanban_request_review", "Terminal: hand the task to review instead of done.",
     _schema({**_TID, "summary": {"type": "string"}}, ["summary"])),
    ("kanban_block", "Terminal: block the task and say why.",
     _schema({**_TID, "reason": {"type": "string"}, "kind": {"type": "string", "enum": BLOCK_KINDS}}, ["reason"])),
    ("kanban_unblock", "Unblock a task.", _schema(_TID)),
    ("kanban_heartbeat", "Tell the dispatcher you are still working.", _schema({**_TID, "note": {"type": "string"}})),
    ("kanban_comment", "Add a comment to a task's thread.", _schema({**_TID, "body": {"type": "string"}}, ["body"])),
    ("kanban_link", "Make child depend on parent.",
     _schema({"parent": {"type": "string"}, "child": {"type": "string"}}, ["parent", "child"])),
]


def call_tool(c, name, a):
    author = os.environ.get("KANBAN_AUTHOR", "orchestrator")
    tid = a.get("task_id") or os.environ.get("KANBAN_TASK")
    needs_tid = name not in ("kanban_list", "kanban_board", "kanban_create", "kanban_link")
    if needs_tid and not tid:
        raise KanbanError("task_id is required (no $KANBAN_TASK set)")
    if name == "kanban_show":
        return render_show(c, tid)
    if name == "kanban_list":
        return render_list(list_tasks(c, a.get("status"), a.get("assignee")))
    if name == "kanban_board":
        return render_board(c)
    if name == "kanban_create":
        new = create(c, a["title"], a.get("body", ""), a.get("assignee"), a.get("parents", []),
                     a.get("priority", 0), a.get("workspace"), a.get("triage", False),
                     a.get("idempotency_key"), a.get("model"), author)
        return f"created {new} ({get(c, new)['status']})"
    if name == "kanban_complete":
        complete(c, tid, a["summary"], a.get("metadata"), author)
        return f"{tid} done"
    if name == "kanban_request_review":
        request_review(c, tid, a["summary"], author)
        return f"{tid} in review"
    if name == "kanban_block":
        block(c, tid, a["reason"], a.get("kind", "needs_input"), author)
        return f"{tid} {get(c, tid)['status']}"
    if name == "kanban_unblock":
        unblock(c, tid, author)
        return f"{tid} {get(c, tid)['status']}"
    if name == "kanban_heartbeat":
        heartbeat(c, tid, a.get("note"), author)
        return "ok"
    if name == "kanban_comment":
        add_comment(c, tid, a["body"], author)
        return "ok"
    if name == "kanban_link":
        link(c, a["parent"], a["child"])
        return "ok"
    raise KanbanError(f"unknown tool {name}")


def mcp_serve():
    c = connect()
    tools = [{"name": n, "description": d, "inputSchema": s} for n, d, s in MCP_TOOLS]
    for line in sys.stdin:
        if not line.strip():
            continue
        msg = json.loads(line)
        mid, method = msg.get("id"), msg.get("method")
        if mid is None:
            continue  # notification
        resp = {"jsonrpc": "2.0", "id": mid}
        if method == "initialize":
            resp["result"] = {"protocolVersion": msg.get("params", {}).get("protocolVersion", "2024-11-05"),
                              "capabilities": {"tools": {}},
                              "serverInfo": {"name": "kanban", "version": "0.1.0"}}
        elif method == "tools/list":
            resp["result"] = {"tools": tools}
        elif method == "tools/call":
            p = msg.get("params", {})
            try:
                text, err = call_tool(c, p.get("name"), p.get("arguments") or {}), False
            except (KanbanError, KeyError, sqlite3.Error) as e:
                text, err = f"error: {e}", True
            resp["result"] = {"content": [{"type": "text", "text": text}], "isError": err}
        elif method == "ping":
            resp["result"] = {}
        else:
            resp["error"] = {"code": -32601, "message": f"method not found: {method}"}
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()


# ---------------------------------------------------------------- CLI

def main(argv=None):
    ap = argparse.ArgumentParser(prog="kanban", description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init", help="create the board and a starter config")
    p = sub.add_parser("create")
    p.add_argument("title")
    p.add_argument("--body", default="")
    p.add_argument("--assignee")
    p.add_argument("--parent", action="append", default=[])
    p.add_argument("--priority", type=int, default=0)
    p.add_argument("--workspace", help="dir:<path> | scratch | worktree | worktree:<path>")
    p.add_argument("--model")
    p.add_argument("--triage", action="store_true")
    p.add_argument("--idempotency-key")
    p.add_argument("--json", action="store_true")
    p = sub.add_parser("list")
    p.add_argument("--status", choices=STATUSES)
    p.add_argument("--assignee")
    p.add_argument("--archived", action="store_true")
    p.add_argument("--json", action="store_true")
    sub.add_parser("board")
    p = sub.add_parser("show")
    p.add_argument("id")
    p.add_argument("--json", action="store_true")
    p = sub.add_parser("assign")
    p.add_argument("id")
    p.add_argument("assignee")
    p = sub.add_parser("move")
    p.add_argument("id")
    p.add_argument("status", choices=STATUSES)
    p = sub.add_parser("complete")
    p.add_argument("id")
    p.add_argument("--result", required=True)
    p = sub.add_parser("request-review")
    p.add_argument("id")
    p.add_argument("--summary", required=True)
    p = sub.add_parser("approve")
    p.add_argument("id")
    p = sub.add_parser("request-changes")
    p.add_argument("id")
    p.add_argument("changes")
    p = sub.add_parser("block")
    p.add_argument("id")
    p.add_argument("reason")
    p.add_argument("--kind", choices=BLOCK_KINDS, default="needs_input")
    p = sub.add_parser("unblock")
    p.add_argument("id")
    p = sub.add_parser("archive")
    p.add_argument("id")
    p = sub.add_parser("comment")
    p.add_argument("id")
    p.add_argument("text")
    p = sub.add_parser("heartbeat")
    p.add_argument("id")
    p.add_argument("--note")
    for verb in ("link", "unlink"):
        p = sub.add_parser(verb)
        p.add_argument("parent")
        p.add_argument("child")
    sub.add_parser("stats")
    p = sub.add_parser("log")
    p.add_argument("id")
    p = sub.add_parser("watch", help="stream board events")
    p.add_argument("--since", type=int, default=0)
    p = sub.add_parser("dispatch", help="reclaim dead workers, promote, spawn ready tasks")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--max", type=int)
    p.add_argument("--loop", action="store_true")
    p.add_argument("--interval", type=int)
    sub.add_parser("mcp", help="run the MCP stdio server")
    a = ap.parse_args(argv)

    if a.cmd == "mcp":
        return mcp_serve()
    c = connect()
    author = os.environ.get("KANBAN_AUTHOR", "human")
    try:
        if a.cmd == "init":
            path = os.path.join(state_dir(), "config.json")
            if not os.path.exists(path):
                with open(path, "w") as f:
                    json.dump(DEFAULT_CONFIG, f, indent=2)
            print(f"board: {db_path()}\nconfig: {path}")
        elif a.cmd == "create":
            tid = create(c, a.title, a.body, a.assignee, a.parent, a.priority, a.workspace, a.triage,
                         a.idempotency_key, a.model, author)
            print(json.dumps(get(c, tid)) if a.json else f"created {tid} ({get(c, tid)['status']})")
        elif a.cmd == "list":
            rows = list_tasks(c, a.status, a.assignee, a.archived)
            print(json.dumps(rows, indent=2) if a.json else render_list(rows))
        elif a.cmd == "board":
            print(render_board(c))
        elif a.cmd == "show":
            if a.json:
                t = get(c, a.id)
                t["parents"], t["children"] = parents(c, a.id), children(c, a.id)
                t["comments"] = [dict(r) for r in c.execute("SELECT * FROM comments WHERE task_id=?", (a.id,))]
                print(json.dumps(t, indent=2))
            else:
                print(render_show(c, a.id))
        elif a.cmd == "assign":
            get(c, a.id)
            update(c, a.id, assignee=a.assignee)
            event(c, a.id, "assigned", assignee=a.assignee, by=author)
        elif a.cmd == "move":
            move(c, a.id, a.status, author)
        elif a.cmd == "complete":
            complete(c, a.id, a.result, author=author)
        elif a.cmd == "request-review":
            request_review(c, a.id, a.summary, author)
        elif a.cmd == "approve":
            complete(c, a.id, get(c, a.id)["result"] or "approved", author=author)
        elif a.cmd == "request-changes":
            request_changes(c, a.id, a.changes, author)
        elif a.cmd == "block":
            block(c, a.id, a.reason, a.kind, author)
        elif a.cmd == "unblock":
            unblock(c, a.id, author)
        elif a.cmd == "archive":
            move(c, a.id, "archived", author)
        elif a.cmd == "comment":
            add_comment(c, a.id, a.text, author)
        elif a.cmd == "heartbeat":
            heartbeat(c, a.id, a.note, author)
        elif a.cmd == "link":
            link(c, a.parent, a.child)
        elif a.cmd == "unlink":
            unlink(c, a.parent, a.child)
        elif a.cmd == "stats":
            print(render_stats(c))
        elif a.cmd == "log":
            path = os.path.join(state_dir(), "logs", f"{a.id}.log")
            print(open(path).read() if os.path.exists(path) else "(no log)")
        elif a.cmd == "watch":
            last = a.since
            while True:
                for r in c.execute("SELECT * FROM events WHERE id>? ORDER BY id", (last,)).fetchall():
                    print(f"[{fmt_ts(r['ts'])}] #{r['id']} {r['task_id']} {r['kind']} {r['payload']}", flush=True)
                    last = r["id"]
                time.sleep(2)
        elif a.cmd == "dispatch":
            cfg = load_config()
            procs = {}
            while True:
                for line in dispatch(c, cfg, a.dry_run, a.max, procs):
                    print(line, flush=True)
                if not a.loop:
                    break
                time.sleep(a.interval or cfg["dispatch_interval_seconds"])
    except KanbanError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
