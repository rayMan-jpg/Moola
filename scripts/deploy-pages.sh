#!/usr/bin/env bash
# Build and publish dist/ to the gh-pages branch (GitHub Pages serves it at /<repo>/).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# Build only from the lockfile, never from whatever happens to be in node_modules.
npm ci --ignore-scripts --no-audit --no-fund
npm run build
SHA="$(git rev-parse --short HEAD)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp -r dist/. "$TMP/"
touch "$TMP/.nojekyll"
cd "$TMP"
git init -q -b gh-pages
git add -A
git -c user.name="${GIT_AUTHOR_NAME:-Claude}" -c user.email="${GIT_AUTHOR_EMAIL:-noreply@anthropic.com}" commit -q -m "Deploy ${SHA}"
git push -f -q "$(git -C "$ROOT" remote get-url origin)" gh-pages:gh-pages
echo "deployed ${SHA} to gh-pages"
