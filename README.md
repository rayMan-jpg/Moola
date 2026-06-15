# AERLOCK — High-Altitude Security

A static landing page for AERLOCK, a (fictional) high-altitude security /
zero-knowledge custody protocol. Aviation-HUD / CRT-terminal aesthetic built on
Tailwind (CDN) with a self-contained, privacy-respecting analytics layer.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The landing page. Original design preserved; aesthetic enhancements added (boot sequence, decrypt headline, radar dial, animated telemetry counters, scroll reveals, grain/vignette, live UTC clock). |
| `analytics.html` | **Telemetry Console** — the separate dashboard for viewing captured user-journey data. `noindex`. |
| `js/aerlock.js` | Front-end aesthetic behaviours. |
| `js/aerlock-analytics.js` | The journey tracker (loaded on the landing page). |
| `robots.txt`, `sitemap.xml` | SEO crawl directives. |

## Running locally

It's a static site — serve the folder with any static server:

```bash
python3 -m http.server 8000
# open http://localhost:8000/        (landing page)
# open http://localhost:8000/analytics.html  (telemetry console)
```

A server (rather than `file://`) is recommended so `localStorage` shares one
origin between the two pages.

## SEO

- Descriptive `<title>` + meta description, keywords, author, theme-color.
- Canonical URL, `robots` meta.
- Open Graph + Twitter card tags for social previews.
- `Organization` JSON-LD structured data.
- `robots.txt` and `sitemap.xml`.

> Update the `https://aerlock.io/` placeholders and `og-image.png` reference to
> the real production domain and a 1200×630 share image when deploying.

## User-journey tracking

`js/aerlock-analytics.js` captures, with **no cookies and no third parties**:

- **pageview** — path, referrer, viewport, language, UTM params
- **click** — any `[data-track]` element plus buttons & links
- **section_view** — sections entering the viewport (funnel order)
- **scroll_depth** — 25 / 50 / 75 / 100% milestones
- **page_exit** — active time on page (journey duration)

Events are buffered in `localStorage` (ring-buffered to 5,000) so the console
works with zero backend. It honours **Do Not Track** and a `disabled` flag.

### Sending to a real backend

Set an endpoint before the tracker loads and events will also be mirrored via
`navigator.sendBeacon`:

```html
<script>window.AERLOCK_ANALYTICS = { endpoint: "https://collect.example.com/e" };</script>
```

### The console (`analytics.html`)

Reads the local buffer and renders KPIs (sessions, pageviews, events, avg.
dwell, distinct paths), a **section funnel** with drop-off, **top
interactions**, **scroll-depth** distribution, **traffic sources**, and a live
**raw event stream** with filtering. Supports **CSV / JSON export** and
**purge**. Auto-refreshes every 5s and reacts to cross-tab writes.

To tag a new element for click tracking, add `data-track="some_label"`.
