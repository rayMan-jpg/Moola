#!/usr/bin/env bash
# Refresh the ECC content fork in ecc/ from upstream (or a given ref).
set -euo pipefail
REF="${1:-main}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git clone --depth 1 --branch "$REF" https://github.com/affaan-m/ECC "$TMP/ecc"
SRC="$TMP/ecc"; DST="$ROOT/ecc"
rm -rf "$DST/agents" "$DST/commands" "$DST/rules" "$DST/mcp-configs" "$DST/skills" "$DST/hooks"
mkdir -p "$DST/skills" "$DST/hooks" "$DST/upstream"
cp -r "$SRC/agents" "$SRC/commands" "$SRC/rules" "$SRC/mcp-configs" "$DST/"
cp "$SRC/.mcp.json" "$SRC/LICENSE" "$SRC/VERSION" "$DST/"
cp "$SRC/hooks/hooks.json" "$SRC/hooks/hooks.metadata.json" "$DST/hooks/"
for d in "$SRC"/skills/*/; do
  n="$(basename "$d")"
  [ -f "$d/SKILL.md" ] && mkdir -p "$DST/skills/$n" && cp "$d/SKILL.md" "$DST/skills/$n/"
done
cp "$SRC/scripts/dashboard-web.js" "$DST/upstream/dashboard-web.js"
sed -i -E "s/pinned at commit \`[0-9a-f]+\` \(ECC v[^)]*\)/pinned at commit \`$(git -C "$SRC" rev-parse HEAD)\` (ECC v$(cat "$SRC/VERSION"))/" "$DST/UPSTREAM.md"
node "$ROOT/scripts/stub-non-mit.mjs"
node "$ROOT/scripts/build-catalog.mjs"
