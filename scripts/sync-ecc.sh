#!/usr/bin/env bash
# Refresh the ECC content fork in ecc/ from upstream at a branch, tag or commit (default: main).
set -euo pipefail
REF="${1:-main}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SRC="$TMP/ecc"
git init -q "$SRC"
git -C "$SRC" fetch -q --depth 1 https://github.com/affaan-m/ECC "$REF"
git -C "$SRC" checkout -q FETCH_HEAD
COMMIT="$(git -C "$SRC" rev-parse HEAD)"
VERSION="$(cat "$SRC/VERSION")"

# Assemble the new fork in a staging dir, then swap it in, so a failure never leaves ecc/ half-synced.
STAGE="$TMP/stage"
mkdir -p "$STAGE/skills" "$STAGE/hooks" "$STAGE/upstream"
cp -r "$SRC/agents" "$SRC/commands" "$SRC/rules" "$SRC/mcp-configs" "$STAGE/"
cp "$SRC/.mcp.json" "$SRC/LICENSE" "$SRC/VERSION" "$STAGE/"
cp "$SRC/hooks/hooks.json" "$SRC/hooks/hooks.metadata.json" "$STAGE/hooks/"
for d in "$SRC"/skills/*/; do
  n="$(basename "$d")"
  if [ -f "$d/SKILL.md" ]; then mkdir -p "$STAGE/skills/$n" && cp "$d/SKILL.md" "$STAGE/skills/$n/"; fi
done
cp "$SRC/scripts/dashboard-web.js" "$STAGE/upstream/dashboard-web.js"
cp "$ROOT/ecc/UPSTREAM.md" "$STAGE/UPSTREAM.md"
COMMIT="$COMMIT" VERSION="$VERSION" node -e '
  const fs = require("fs");
  const f = process.argv[1];
  const t = fs.readFileSync(f, "utf8").replace(/pinned at commit `[0-9a-f]+` \(ECC v[^)]*\)/, `pinned at commit \`${process.env.COMMIT}\` (ECC v${process.env.VERSION})`);
  fs.writeFileSync(f, t);
' "$STAGE/UPSTREAM.md"

rm -rf "$ROOT/ecc.old"
mv "$ROOT/ecc" "$ROOT/ecc.old"
mv "$STAGE" "$ROOT/ecc"
rm -rf "$ROOT/ecc.old"
node "$ROOT/scripts/stub-non-mit.mjs"
node "$ROOT/scripts/build-catalog.mjs"
echo "synced ecc/ to $COMMIT (v$VERSION)"
