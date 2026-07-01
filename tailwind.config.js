/** AERLOCK — Tailwind build config (ported verbatim from the original inline
 *  Play-CDN config). Compiling locally resolves every theme() token and bakes
 *  all utilities into dist/aerlock.css, so the site self-hosts with no CDN. */
module.exports = {
  darkMode: "class",
  content: ["./index.html", "./analytics.html", "./js/**/*.js"],
  theme: {
    extend: {
      colors: {
        "tertiary-fixed-dim": "#c1c7cf",
        "primary-fixed": "#7df4ff",
        "on-primary": "#00363a",
        "background": "#0c1324",
        "primary-container": "#00f0ff",
        "surface": "#0c1324",
        "surface-container-highest": "#2e3447",
        "on-tertiary": "#2b3137",
        "on-surface-variant": "#b9cacb",
        "on-secondary-container": "#a5b7cc",
        "surface-tint": "#00dbe9",
        "on-error-container": "#ffdad6",
        "primary": "#dbfcff",
        "on-primary-container": "#006970",
        "secondary": "#b6c8de",
        "on-surface": "#dce1fb",
        "on-error": "#690005",
        "tertiary-container": "#d4dae2",
        "outline-variant": "#3b494b",
        "secondary-fixed": "#d2e4fa",
        "secondary-fixed-dim": "#b6c8de",
        "inverse-on-surface": "#2a3043",
        "on-secondary-fixed": "#0a1d2d",
        "surface-variant": "#2e3447",
        "on-secondary": "#213243",
        "on-primary-fixed": "#002022",
        "on-primary-fixed-variant": "#004f54",
        "surface-container-low": "#151b2d",
        "inverse-primary": "#006970",
        "outline": "#849495",
        "on-secondary-fixed-variant": "#37485a",
        "on-background": "#dce1fb",
        "error": "#ffb4ab",
        "on-tertiary-fixed-variant": "#41474e",
        "error-container": "#93000a",
        "inverse-surface": "#dce1fb",
        "on-tertiary-fixed": "#161c22",
        "surface-dim": "#0c1324",
        "tertiary-fixed": "#dde3eb",
        "secondary-container": "#37485a",
        "surface-bright": "#33394c",
        "tertiary": "#f1f6ff",
        "surface-container-high": "#23293c",
        "surface-container-lowest": "#070d1f",
        "primary-fixed-dim": "#00dbe9",
        "on-tertiary-container": "#595f66",
        "surface-container": "#191f31"
      },
      borderRadius: { DEFAULT: "0px", lg: "0px", xl: "0px", full: "0px" },
      spacing: { margin: "24px", gutter: "16px", "container-max": "1440px", unit: "4px" },
      fontFamily: {
        "body-lg": ["Space Grotesk", "JetBrains Mono"],
        "headline-lg": ["Anybody"],
        "label-sm": ["JetBrains Mono"],
        "headline-sm": ["Anybody"],
        "headline-md": ["Anybody"],
        "body-md": ["Space Grotesk", "JetBrains Mono"],
        "label-md": ["JetBrains Mono"],
        "tech-data": ["JetBrains Mono"]
      },
      fontSize: {
        "body-lg": ["16px", { lineHeight: "1.5", fontWeight: "400" }],
        "headline-lg": ["48px", { lineHeight: "1.1", letterSpacing: "-0.02em", fontWeight: "700" }],
        "label-sm": ["10px", { lineHeight: "1.2", letterSpacing: "0.05em", fontWeight: "500" }],
        "headline-sm": ["24px", { lineHeight: "1.2", letterSpacing: "0em", fontWeight: "600" }],
        "headline-md": ["32px", { lineHeight: "1.2", letterSpacing: "-0.01em", fontWeight: "600" }],
        "body-md": ["14px", { lineHeight: "1.5", fontWeight: "400" }],
        "label-md": ["12px", { lineHeight: "1.2", fontWeight: "500" }]
      }
    }
  },
  plugins: [
    require("@tailwindcss/forms"),
    require("@tailwindcss/container-queries")
  ]
};
