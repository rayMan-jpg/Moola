import { defineConfig } from 'vite';

// Served from https://<user>.github.io/Moola/ on GitHub Pages, so assets need a relative base.
export default defineConfig({
  base: './',
  define: { 'process.env': {}, global: 'globalThis' },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1500 },
  test: { environment: 'jsdom', include: ['tests/unit/**/*.test.ts'] },
});
