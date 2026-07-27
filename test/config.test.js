import test from 'node:test';
import assert from 'node:assert/strict';

import { defaults, validate, sanitizeFileName } from '../src/config.js';

test('validate clamps out-of-range numbers instead of crashing', () => {
  const cfg = validate(
    {
      location: { latitude: 999, longitude: -999 },
      adhaan: { volume: 7, maxDurationSec: 999999 },
      calculation: { adjustments: { fajr: 5000 } },
    },
    defaults()
  );
  assert.equal(cfg.location.latitude, 90);
  assert.equal(cfg.location.longitude, -180);
  assert.equal(cfg.adhaan.volume, 1);
  assert.equal(cfg.adhaan.maxDurationSec, 1800);
  assert.equal(cfg.calculation.adjustments.fajr, 120);
});

test('validate rejects unknown timezones and methods, keeping previous values', () => {
  const base = defaults();
  const cfg = validate(
    { location: { timezone: 'Mars/OlympusMons' }, calculation: { method: 'MadeUp' } },
    base
  );
  assert.equal(cfg.location.timezone, base.location.timezone);
  assert.equal(cfg.calculation.method, base.calculation.method);
});

test('partial updates leave unrelated settings untouched', () => {
  const base = defaults();
  base.adhaan.volume = 0.8;
  base.devices.selected = [{ id: 'abc', name: 'Kitchen display' }];
  const cfg = validate({ location: { label: 'Home' } }, base);
  assert.equal(cfg.location.label, 'Home');
  assert.equal(cfg.adhaan.volume, 0.8);
  assert.deepEqual(cfg.devices.selected, [{ id: 'abc', name: 'Kitchen display' }]);
});

test('file names with path tricks are rejected outright', () => {
  assert.equal(sanitizeFileName('adhan.mp3'), 'adhan.mp3');
  assert.equal(sanitizeFileName('../../etc/passwd'), null);
  assert.equal(sanitizeFileName('nested/adhan.mp3'), null);
  assert.equal(sanitizeFileName('.hidden.mp3'), null);
  assert.equal(sanitizeFileName(''), null);
  assert.equal(sanitizeFileName(null), null);
});

test('device selection is normalised to {id, name} pairs', () => {
  const cfg = validate(
    { devices: { selected: [{ id: ' dev-1 ', name: 'Hub' }, { bogus: true }, null] } },
    defaults()
  );
  assert.deepEqual(cfg.devices.selected, [{ id: 'dev-1', name: 'Hub' }]);
});
