/**
 * `npm run doctor` — checks that everything Moola needs is present.
 * Prints one ✅/❌ line per check and exits non-zero if anything failed.
 */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ffmpegPath, ffprobePath } from '../packages/transcoder/src/ffbin.ts';

const require = createRequire(import.meta.url);
let failures = 0;

function check(name: string, fn: () => string | void): void {
  try {
    const detail = fn();
    console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    failures++;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`❌ ${name} — ${msg.split('\n')[0]}`);
  }
}

check('Node.js >= 20', () => {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) throw new Error(`found v${process.versions.node}; install Node 20 or newer`);
  return `v${process.versions.node}`;
});

check('ffmpeg binary', () => {
  const bin = ffmpegPath();
  const out = execFileSync(bin, ['-version'], { encoding: 'utf8' });
  return `${bin} (${out.split(' ').slice(0, 3).join(' ')})`;
});

check('ffprobe binary', () => {
  const bin = ffprobePath();
  const out = execFileSync(bin, ['-version'], { encoding: 'utf8' });
  return `${bin} (${out.split(' ').slice(0, 3).join(' ')})`;
});

check('better-sqlite3 loads', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1);');
  const row = db.prepare('SELECT x FROM t').get() as { x: number };
  db.close();
  if (row.x !== 1) throw new Error('sqlite round-trip failed');
  return 'in-memory round-trip OK';
});

check('data/ directory writable', () => {
  const dir = path.resolve(import.meta.dirname, '..', 'data');
  mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  mkdirSync(path.join(dir, 'assets'), { recursive: true });
  accessSync(dir, constants.W_OK);
  return dir;
});

if (failures > 0) {
  console.log(`\n${failures} check(s) failed. Fix the ❌ lines above, then re-run: npm run doctor`);
  process.exit(1);
} else {
  console.log('\nAll checks passed. Next: npm run demo:video');
}
