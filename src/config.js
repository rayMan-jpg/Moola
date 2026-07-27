import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IANAZone } from 'luxon';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const MEDIA_DIR = path.join(ROOT, 'media');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const CALCULATION_METHODS = [
  'MoonsightingCommittee',
  'MuslimWorldLeague',
  'NorthAmerica',
  'Egyptian',
  'Karachi',
  'UmmAlQura',
  'Dubai',
  'Kuwait',
  'Qatar',
  'Singapore',
  'Tehran',
  'Turkey',
];

const HIGH_LATITUDE_RULES = ['auto', 'middleofthenight', 'seventhofthenight', 'twilightangle'];
const PRAYERS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];

function guessTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function defaults() {
  return {
    location: {
      latitude: 51.5072,
      longitude: -0.1276,
      timezone: guessTimezone(),
      label: 'Set your location',
    },
    calculation: {
      method: 'MoonsightingCommittee',
      madhab: 'shafi',
      highLatitudeRule: 'auto',
      adjustments: { fajr: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 },
    },
    adhaan: {
      prayers: { fajr: true, dhuhr: true, asr: true, maghrib: true, isha: true },
      audioFile: null,
      fajrAudioFile: null,
      volume: 0.5,
      restoreVolume: true,
      maxDurationSec: 300,
    },
    devices: { selected: [] },
    server: { port: 8090, host: null },
  };
}

function clampNumber(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

// Media files are addressed by bare name only; anything that looks like a path
// or a hidden file is rejected rather than "fixed".
function sanitizeFileName(name) {
  if (typeof name !== 'string' || !name.trim()) return null;
  const base = path.basename(name.trim());
  if (base !== name.trim() || base.startsWith('.') || base.length > 120) return null;
  return base;
}

function validate(raw, base) {
  const cfg = structuredClone(base);
  if (!raw || typeof raw !== 'object') return cfg;

  const loc = raw.location || {};
  cfg.location.latitude = clampNumber(loc.latitude, -90, 90, cfg.location.latitude);
  cfg.location.longitude = clampNumber(loc.longitude, -180, 180, cfg.location.longitude);
  if (typeof loc.timezone === 'string' && IANAZone.isValidZone(loc.timezone)) {
    cfg.location.timezone = loc.timezone;
  }
  if (typeof loc.label === 'string') cfg.location.label = loc.label.slice(0, 80);

  const calc = raw.calculation || {};
  if (CALCULATION_METHODS.includes(calc.method)) cfg.calculation.method = calc.method;
  if (calc.madhab === 'shafi' || calc.madhab === 'hanafi') cfg.calculation.madhab = calc.madhab;
  if (HIGH_LATITUDE_RULES.includes(calc.highLatitudeRule)) {
    cfg.calculation.highLatitudeRule = calc.highLatitudeRule;
  }
  const adj = calc.adjustments || {};
  for (const p of PRAYERS) {
    cfg.calculation.adjustments[p] = Math.round(
      clampNumber(adj[p], -120, 120, cfg.calculation.adjustments[p])
    );
  }

  const adhaan = raw.adhaan || {};
  const prayers = adhaan.prayers || {};
  for (const p of PRAYERS) {
    if (typeof prayers[p] === 'boolean') cfg.adhaan.prayers[p] = prayers[p];
  }
  if ('audioFile' in adhaan) {
    cfg.adhaan.audioFile = adhaan.audioFile === null ? null : sanitizeFileName(adhaan.audioFile);
  }
  if ('fajrAudioFile' in adhaan) {
    cfg.adhaan.fajrAudioFile =
      adhaan.fajrAudioFile === null ? null : sanitizeFileName(adhaan.fajrAudioFile);
  }
  cfg.adhaan.volume = clampNumber(adhaan.volume, 0, 1, cfg.adhaan.volume);
  if (typeof adhaan.restoreVolume === 'boolean') cfg.adhaan.restoreVolume = adhaan.restoreVolume;
  cfg.adhaan.maxDurationSec = Math.round(
    clampNumber(adhaan.maxDurationSec, 10, 1800, cfg.adhaan.maxDurationSec)
  );

  const devices = raw.devices || {};
  if (Array.isArray(devices.selected)) {
    cfg.devices.selected = devices.selected
      .filter((d) => d && typeof d.id === 'string' && d.id.trim())
      .slice(0, 20)
      .map((d) => ({
        id: d.id.trim().slice(0, 120),
        name: (typeof d.name === 'string' ? d.name : d.id).trim().slice(0, 80),
      }));
  }

  const server = raw.server || {};
  cfg.server.port = Math.round(clampNumber(server.port, 1, 65535, cfg.server.port));
  if ('host' in server) {
    cfg.server.host =
      typeof server.host === 'string' && server.host.trim()
        ? server.host.trim().slice(0, 120)
        : null;
  }

  return cfg;
}

function createConfigStore() {
  let current = defaults();
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    current = validate(raw, current);
  } catch {
    // First run (or unreadable file) — start from defaults.
  }

  function persist() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${CONFIG_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2));
    fs.renameSync(tmp, CONFIG_PATH);
  }

  return {
    get: () => current,
    update(raw) {
      current = validate(raw, current);
      persist();
      return current;
    },
  };
}

export {
  createConfigStore,
  defaults,
  validate,
  sanitizeFileName,
  CALCULATION_METHODS,
  HIGH_LATITUDE_RULES,
  PRAYERS,
  DATA_DIR,
  MEDIA_DIR,
  CONFIG_PATH,
};
