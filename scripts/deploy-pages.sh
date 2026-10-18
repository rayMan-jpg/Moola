#!/usr/bin/env bash
# Build and publish dist/ to the gh-pages branch (GitHub Pages serves it at /<repo>/).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# Deploy exactly what is committed: the gh-pages commit is labeled with HEAD's SHA.
if [ -n "$(git status --porcelain)" ]; then
  echo "refusing to deploy a dirty working tree; commit or stash first" >&2
  exit 1
fi
SHA="$(git rev-parse --short HEAD)"
ORIGIN="$(git remote get-url origin)"
# Build only from the lockfile, never from whatever happens to be in node_modules.
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# Keep the previous deploy's hashed assets so tabs opened before this deploy can still lazy-load chunks.
if git fetch -q --depth 1 "$ORIGIN" gh-pages 2>/dev/null; then
  mkdir -p "$TMP/assets"
  git archive FETCH_HEAD assets 2>/dev/null | tar -x -C "$TMP" || true
fi
cp -r dist/. "$TMP/"
touch "$TMP/.nojekyll"
cd "$TMP"
git init -q -b gh-pages
git add -A
git -c user.name="${GIT_AUTHOR_NAME:-Claude}" -c user.email="${GIT_AUTHOR_EMAIL:-noreply@anthropic.com}" commit -q -m "Deploy ${SHA}"
git push -f -q "$ORIGIN" gh-pages:gh-pages
echo "deployed ${SHA} to gh-pages"
