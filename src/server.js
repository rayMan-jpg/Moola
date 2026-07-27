import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { DateTime } from 'luxon';

import { MEDIA_DIR, CALCULATION_METHODS, sanitizeFileName } from './config.js';
import { todaySchedule, nextAdhaan } from './prayer.js';
import { detectLanAddress } from './net.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac']);

// Intl.supportedValuesOf omits bare "UTC", which can be the configured zone on
// a fresh install — the current zone must always be an option or the dropdown
// renders blank.
function timezoneOptions(zone) {
  const zones = typeof Intl.supportedValuesOf === 'function' ? [...Intl.supportedValuesOf('timeZone')] : [];
  if (!zones.includes(zone)) zones.unshift(zone);
  if (!zones.includes('UTC')) zones.push('UTC');
  return zones;
}

function listMedia() {
  try {
    return fs
      .readdirSync(MEDIA_DIR)
      .filter((f) => AUDIO_EXTENSIONS.has(path.extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function createServer({ store, discovery, playAdhaan, scheduler, log, ringlog, getPort }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use(express.static(PUBLIC_DIR));
  // express.static handles Range requests, which cast devices rely on.
  app.use('/media', express.static(MEDIA_DIR, { fallthrough: false }));

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        fs.mkdirSync(MEDIA_DIR, { recursive: true });
        cb(null, MEDIA_DIR);
      },
      filename: (req, file, cb) => {
        const clean = sanitizeFileName(file.originalname);
        if (!clean) return cb(new Error('unusable file name'));
        let name = clean;
        const ext = path.extname(clean);
        const stem = path.basename(clean, ext);
        for (let i = 1; fs.existsSync(path.join(MEDIA_DIR, name)); i++) {
          name = `${stem}-${i}${ext}`;
        }
        cb(null, name);
      },
    }),
    limits: { fileSize: 30 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
      const ok = AUDIO_EXTENSIONS.has(path.extname(file.originalname || '').toLowerCase());
      cb(ok ? null : new Error('only audio files are accepted (mp3, wav, ogg, m4a, aac, flac)'), ok);
    },
  });

  function stateJson() {
    const cfg = store.get();
    const now = new Date();
    const zone = cfg.location.timezone;
    const { date, entries } = todaySchedule(cfg, now);
    const next = nextAdhaan(cfg, now);

    const today = entries.map((e) => ({
      key: e.key,
      name: e.name,
      arabic: e.arabic,
      epochMs: e.time.getTime(),
      display: DateTime.fromJSDate(e.time, { zone }).toFormat('HH:mm'),
      isPrayer: e.key !== 'sunrise',
      enabled: !!cfg.adhaan.prayers[e.key],
      past: e.time.getTime() < now.getTime(),
      next: !!(next && next.key === e.key && Math.abs(next.time.getTime() - e.time.getTime()) < 1000),
    }));

    const discovered = discovery.list();
    const selectedIds = new Set(cfg.devices.selected.map((s) => s.id));
    const devices = discovered.map((d) => ({
      id: d.id,
      name: d.name,
      model: d.model,
      host: d.host,
      selected: selectedIds.has(d.id),
      online: true,
    }));
    for (const s of cfg.devices.selected) {
      if (!devices.some((d) => d.id === s.id)) {
        devices.push({ id: s.id, name: s.name, model: 'Not visible right now', host: null, selected: true, online: false });
      }
    }

    return {
      settings: cfg,
      date,
      zone,
      today,
      next: next
        ? {
            key: next.key,
            name: next.name,
            arabic: next.arabic,
            epochMs: next.time.getTime(),
            display: DateTime.fromJSDate(next.time, { zone }).toFormat('HH:mm'),
          }
        : null,
      devices,
      media: listMedia(),
      log: ringlog.entries(),
      serverBase: `http://${cfg.server.host || detectLanAddress()}:${getPort()}`,
      methods: CALCULATION_METHODS,
      timezones: timezoneOptions(zone),
    };
  }

  app.get('/api/state', (req, res) => res.json(stateJson()));

  app.put('/api/settings', (req, res) => {
    const before = store.get();
    const updated = store.update(req.body);
    scheduler.reschedule();
    log('info', 'Settings saved');
    if (updated.server.port !== before.server.port) {
      log('warn', `Port change to ${updated.server.port} takes effect after a restart`);
    }
    res.json(stateJson());
  });

  app.post('/api/test', async (req, res) => {
    const ids = Array.isArray(req.body && req.body.deviceIds) ? req.body.deviceIds : null;
    try {
      const results = await playAdhaan({ test: true, deviceIds: ids });
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/devices/rescan', (req, res) => {
    discovery.rescan();
    res.json({ ok: true });
  });

  app.post('/api/media/upload', (req, res) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        const msg = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
          ? 'file is larger than 30 MB'
          : err.message;
        return res.status(400).json({ error: msg });
      }
      if (!req.file) return res.status(400).json({ error: 'no file received' });
      log('info', `Uploaded audio: ${req.file.filename}`);
      const cfg = store.get();
      if (!cfg.adhaan.audioFile) {
        store.update({ adhaan: { audioFile: req.file.filename } });
        log('info', `"${req.file.filename}" set as the adhaan sound`);
      }
      res.json({ file: req.file.filename, media: listMedia() });
    });
  });

  app.delete('/api/media/:name', (req, res) => {
    const clean = sanitizeFileName(req.params.name);
    if (!clean) return res.status(400).json({ error: 'bad file name' });
    const target = path.join(MEDIA_DIR, clean);
    if (!fs.existsSync(target)) return res.status(404).json({ error: 'not found' });
    fs.unlinkSync(target);
    const cfg = store.get();
    const patch = {};
    if (cfg.adhaan.audioFile === clean) patch.audioFile = null;
    if (cfg.adhaan.fajrAudioFile === clean) patch.fajrAudioFile = null;
    if (Object.keys(patch).length) store.update({ adhaan: patch });
    log('info', `Deleted audio: ${clean}`);
    res.json({ media: listMedia() });
  });

  // JSON for API paths, static errors elsewhere.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.statusCode || err.status || 500;
    if (req.path.startsWith('/api/')) return res.status(status).json({ error: err.message });
    res.status(status).send(err.message);
  });

  return { app, listMedia };
}

export { createServer, listMedia, AUDIO_EXTENSIONS };
