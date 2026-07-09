#!/usr/bin/env node
// Thin launcher so `npx moola-transcode` works while the source stays TypeScript.
import { register } from 'tsx/esm/api';
register();
await import('../src/cli.ts');
