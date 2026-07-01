# AERLOCK — Developer Handoff

This is the marketing landing page + a local telemetry console. It is a **static
site** (HTML/CSS/JS, no server runtime). This doc is for the developer wiring it
to the actual DApp and to hosting.

## Structure

```
index.html            Landing page
analytics.html        Telemetry Console (private dashboard; noindex)
src/input.css         Tailwind source + AERLOCK custom styles
dist/aerlock.css      Compiled stylesheet (self-hosted; replaces the Tailwind CDN)
tailwind.config.js    Theme tokens (ported from the original design)
js/aerlock.js         Aesthetic behaviours (boot, decrypt, clock, reveal, mobile nav)
js/aerlock-analytics.js  Cookieless journey tracker
favicon.svg / favicon-*.png / og-image.png / site.webmanifest   Icons + social card
robots.txt / sitemap.xml
```

## Build

CSS is precompiled (no CDN). Rebuild after editing `src/input.css`, the theme,
or any markup that introduces new Tailwind classes:

```bash
npm install       # one time
npm run build     # → dist/aerlock.css (minified)
npm run watch     # rebuild on change during development
npm run dev       # build + serve on :8080
```

Tailwind scans `index.html`, `analytics.html`, and `js/**/*.js` for class names,
so **if you add classes in a new file, add it to `content` in `tailwind.config.js`.**

## Integration points

### 1. "ENTER VAULT" → the DApp
The hero CTA calls the app when `window.AERLOCK_APP_URL` is set; otherwise it
shows non-blocking "VAULT ACCESS PENDING" feedback. Wire it by adding, before
`js/aerlock.js` loads:

```html
<script>window.AERLOCK_APP_URL = "https://app.aerlock.io/";</script>
```

(Or replace the `#aerlock-enter-vault` button with your own handler / wallet-connect flow.)

### 2. Analytics — send to a backend (optional)
By default the tracker only writes to `localStorage` (read by `analytics.html`).
To also stream events to a collector, set before `js/aerlock-analytics.js` loads:

```html
<script>window.AERLOCK_ANALYTICS = { endpoint: "https://collect.aerlock.io/e" };</script>
```

Events POST via `navigator.sendBeacon` as `text/plain` (CORS-simple, no preflight),
one JSON object per event: `{id, type, ts, session, path, props}`.
Config flags: `{ disabled: true }` to turn tracking off; the tracker also honours
browser **Do Not Track**.

### 3. Tracking custom interactions
- Add `data-track="some_label"` to any element to log a named click.
- Or call the API directly: `window.aerlockTrack("event_type", { any: "props" })`
  and `window.aerlockFlush()` to force-persist immediately.
- Event types emitted automatically: `pageview`, `click`, `section_view`,
  `scroll_depth` (25/50/75/100%), `page_exit` (active dwell time).

### 4. Telemetry Console
`analytics.html` reads the same-origin `localStorage` buffer and renders KPIs,
a section funnel, top interactions, scroll depth, traffic sources, and a raw
event log (CSV/JSON export, purge). It is `noindex`. If you move analytics to a
real backend, point this dashboard at your API instead of `localStorage`.

## Hosting / subdomain

Fully static — deploy the repo root to any static host / CDN / subdomain
(e.g. `aerlock.io` and `app.aerlock.io` for the DApp). Upload everything except
`node_modules/` and `src/` (only `dist/aerlock.css` is needed at runtime; keep
`src/` in the repo for rebuilds). No server, no env vars required.

### Before going live — replace placeholders with the real domain
- `index.html`: `<link rel="canonical">`, `og:url`, `og:image`, `twitter:image`,
  and the JSON-LD `url`/`logo`/`image` (currently `https://aerlock.io/...`).
- `sitemap.xml` `<loc>` and `robots.txt` `Sitemap:`.
- Provide `og-image.png` at the site root (already generated, 1200×630).
