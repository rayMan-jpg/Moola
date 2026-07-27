import fs from 'node:fs';
import path from 'node:path';

import { createConfigStore, MEDIA_DIR, DATA_DIR } from './config.js';
import { Scheduler } from './scheduler.js';
import { CastDiscovery } from './cast/discovery.js';
import { playOnDevices } from './cast/player.js';
import { createServer, listMedia } from './server.js';
import { generateSampleChime } from './tone.js';
import { detectLanAddress } from './net.js';

const ringlog = {
  buffer: [],
  push(level, msg) {
    this.buffer.push({ ts: Date.now(), level, msg });
    if (this.buffer.length > 80) this.buffer.shift();
  },
  entries() {
    return [...this.buffer].reverse();
  },
};

function log(level, msg) {
  const stamp = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[${stamp}] ${level.toUpperCase().padEnd(5)} ${msg}`);
  ringlog.push(level, msg);
}

const store = createConfigStore();
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

if (listMedia().length === 0) {
  const sample = path.join(MEDIA_DIR, 'sample-chime.wav');
  generateSampleChime(sample);
  log('info', 'No audio found — generated media/sample-chime.wav for testing. Upload a real adhaan in the dashboard.');
}

const port = Number(process.env.PORT) || store.get().server.port;

const discovery = new CastDiscovery(log);
discovery.start();

// For Fajr a dedicated recording (or a quieter one) can be configured;
// otherwise every prayer uses the default file, falling back to whatever
// audio exists so a fresh install still makes sound.
function pickAudioFile(cfg, prayerKey) {
  const files = listMedia();
  const wanted = [];
  if (prayerKey === 'fajr' && cfg.adhaan.fajrAudioFile) wanted.push(cfg.adhaan.fajrAudioFile);
  if (cfg.adhaan.audioFile) wanted.push(cfg.adhaan.audioFile);
  for (const w of wanted) if (files.includes(w)) return w;
  return files[0] || null;
}

// Central play-out used by both the scheduler and the dashboard's test button.
// `entry` is a prayer entry ({key, name, ...}) or {test: true, deviceIds?}.
async function playAdhaan(entry) {
  const cfg = store.get();
  const online = discovery.list();

  let targets;
  if (entry.test && Array.isArray(entry.deviceIds) && entry.deviceIds.length) {
    targets = online.filter((d) => entry.deviceIds.includes(d.id));
  } else {
    const selected = new Set(cfg.devices.selected.map((s) => s.id));
    targets = online.filter((d) => selected.has(d.id));
  }

  const label = entry.test ? 'test sound' : `${entry.name} adhaan`;
  if (!targets.length) {
    log('warn', `Skipped ${label} — no selected cast devices are online`);
    return [];
  }

  const file = pickAudioFile(cfg, entry.key);
  if (!file) {
    log('warn', `Skipped ${label} — no audio files in media/`);
    return [];
  }

  const base = `http://${cfg.server.host || detectLanAddress()}:${port}`;
  const url = `${base}/media/${encodeURIComponent(file)}`;
  log('info', `Playing ${label} (${file}) on: ${targets.map((t) => t.name).join(', ')}`);

  const results = await playOnDevices(
    targets,
    url,
    {
      volume: cfg.adhaan.volume,
      restoreVolume: cfg.adhaan.restoreVolume,
      maxDurationSec: cfg.adhaan.maxDurationSec,
      title: entry.test ? 'Adhaan Cast — test' : `Adhaan — ${entry.name}`,
      subtitle: entry.arabic || '',
    },
    log
  );
  const okCount = results.filter((r) => r.ok).length;
  log(okCount === results.length ? 'info' : 'warn', `Finished ${label}: ${okCount}/${results.length} device(s) ok`);
  return results;
}

const scheduler = new Scheduler({ getConfig: () => store.get(), playPrayer: playAdhaan, log });
scheduler.reschedule();

const { app } = createServer({
  store,
  discovery,
  playAdhaan,
  scheduler,
  log,
  ringlog,
  getPort: () => port,
});

const server = app.listen(port, '0.0.0.0', () => {
  log('info', `Adhaan Cast dashboard: http://${detectLanAddress()}:${port}`);
});

function shutdown() {
  log('info', 'Shutting down');
  scheduler.stop();
  discovery.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
