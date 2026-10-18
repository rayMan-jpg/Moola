import { defineConfig } from 'vitest/config';

// Live tests hit mainnet RPC + launchpad APIs. They only simulate; nothing is ever broadcast.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/live/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // pump's SDK imports named exports from CJS anchor, which Node's ESM loader rejects; let Vite transform it.
    server: { deps: { inline: [/@pump-fun\//] } },
  },
});
