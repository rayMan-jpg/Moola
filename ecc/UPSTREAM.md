# ECC fork

This directory is a content fork of [affaan-m/ECC](https://github.com/affaan-m/ECC) (MIT, see `LICENSE`),
pinned at commit `76aaa77df6adc5b889e689007bf99b9a4f74af34` (ECC v2.2.3).

Kept: `agents/`, `commands/`, `rules/`, `skills/*/SKILL.md`, `hooks/hooks.json` (+ metadata), `mcp-configs/`, `.mcp.json`.
`upstream/dashboard-web.js` is ECC's original browser dashboard, kept for reference: MOOLA's catalog
(`scripts/build-catalog.mjs`) ports its loaders and the site in `src/` is the degen re-skin of that dashboard.

Refresh with `scripts/sync-ecc.sh`.
