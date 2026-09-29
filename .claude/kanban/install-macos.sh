#!/bin/bash
# Install the Kanban board on macOS and keep its dispatcher running with launchd.
#
#   curl -fsSL https://raw.githubusercontent.com/rayMan-jpg/Moola/claude/kanban-feature-integration-92r3xt/.claude/kanban/install-macos.sh | bash
#
# or, from inside a checkout:  bash .claude/kanban/install-macos.sh
#
# Env overrides: MOOLA_DIR (checkout location, default ~/Moola), MOOLA_BRANCH,
# DEEPSEEK_API_KEY (adds a "deepseek" worker profile), KANBAN_NO_DAEMON=1 (skip launchd).
set -euo pipefail

REPO_URL="https://github.com/rayMan-jpg/Moola.git"
BRANCH="${MOOLA_BRANCH:-claude/kanban-feature-integration-92r3xt}"
LABEL="com.moola.kanban-dispatch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# 1. Prerequisites
command -v git >/dev/null || die "git not found. Run: xcode-select --install"
PY="$(command -v python3 || true)"
[ -n "$PY" ] || die "python3 not found. Run: xcode-select --install"
CLAUDE="$(command -v claude || true)"
[ -n "$CLAUDE" ] || die "Claude Code not found. Install it (https://claude.ai/code), run 'claude' once to log in, then re-run this."

# 2. Checkout: use the current repo if we're in it, else clone/update ~/Moola
if [ -f ".claude/kanban/kanban.py" ]; then
  DIR="$(pwd)"
else
  DIR="${MOOLA_DIR:-$HOME/Moola}"
  if [ -d "$DIR/.git" ]; then
    say "Updating $DIR"
    git -C "$DIR" fetch -q origin "$BRANCH"
    git -C "$DIR" checkout -q "$BRANCH"
    git -C "$DIR" pull -q --ff-only origin "$BRANCH"
  else
    say "Cloning into $DIR"
    git clone -q -b "$BRANCH" "$REPO_URL" "$DIR"
  fi
fi
cd "$DIR"
K=("$PY" "$DIR/.claude/kanban/kanban.py")

# 3. Board + config
say "Initialising board"
"${K[@]}" init
if [ -n "${DEEPSEEK_API_KEY:-}" ] && ! grep -q '"deepseek"' .kanban/config.json; then
  say "Adding deepseek worker profile"
  "$PY" - <<'EOF'
import json
p = ".kanban/config.json"
cfg = json.load(open(p))
cfg["profiles"]["deepseek"] = {
    "harness": "claude", "model": "deepseek-chat", "permission_mode": "acceptEdits",
    "env": {"ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
            "ANTHROPIC_AUTH_TOKEN": "${DEEPSEEK_API_KEY}",
            "ANTHROPIC_SMALL_FAST_MODEL": "deepseek-chat"}}
json.dump(cfg, open(p, "w"), indent=2)
EOF
fi

# 4. Background dispatcher (launchd). launchd doesn't read your shell profile,
#    so PATH and the DeepSeek key are written into the agent's environment.
if [ -z "${KANBAN_NO_DAEMON:-}" ] && [ "$(uname)" = "Darwin" ]; then
  say "Installing launchd agent $LABEL"
  mkdir -p "$HOME/Library/LaunchAgents" "$DIR/.kanban/logs"
  DS_ENV=""
  [ -n "${DEEPSEEK_API_KEY:-}" ] && DS_ENV="<key>DEEPSEEK_API_KEY</key><string>${DEEPSEEK_API_KEY}</string>"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$PY</string><string>$DIR/.claude/kanban/kanban.py</string><string>dispatch</string><string>--loop</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$CLAUDE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>KANBAN_ROOT</key><string>$DIR</string>
    $DS_ENV
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/.kanban/logs/dispatcher.log</string>
  <key>StandardErrorPath</key><string>$DIR/.kanban/logs/dispatcher.log</string>
</dict>
</plist>
EOF
  chmod 600 "$PLIST"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
fi

# 5. Smoke test: one card, handled by a real worker
say "Smoke test"
T=$("${K[@]}" create "Smoke test: reply with the current date" --workspace scratch \
    --idempotency-key "install-smoke-$(date +%Y%m%d)" | awk '{print $2}')
if [ -n "${KANBAN_NO_DAEMON:-}" ] || [ "$(uname)" != "Darwin" ]; then "${K[@]}" dispatch; fi
for _ in $(seq 1 36); do
  S=$("${K[@]}" show "$T" --json | "$PY" -c 'import sys,json;print(json.load(sys.stdin)["status"])')
  case "$S" in done|blocked|review) break;; esac
  sleep 5
done
"${K[@]}" show "$T"

cat <<EOF

Installed in $DIR  (card $T: $S)
  Board:        cd $DIR && python3 .claude/kanban/kanban.py board
  Plan work:    cd $DIR && claude    then:  /kanban plan <your goal>
  Live events:  python3 .claude/kanban/kanban.py watch
  Dispatcher:   tail -f $DIR/.kanban/logs/dispatcher.log
  Stop daemon:  launchctl bootout gui/\$(id -u)/$LABEL
EOF
