import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';

import { defaults, validate } from '../src/config.js';
import { todaySchedule, nextAdhaan, timesForDay } from '../src/prayer.js';

function cfgWith(patch) {
  return validate(patch, defaults());
}

const LONDON = {
  location: { latitude: 51.5072, longitude: -0.1276, timezone: 'Europe/London', label: 'London' },
};

test('prayer times for a normal day are in chronological order', () => {
  const cfg = cfgWith(LONDON);
  const day = DateTime.fromISO('2026-03-10T12:00:00', { zone: 'Europe/London' });
  const entries = timesForDay(cfg, day);
  assert.equal(entries.length, 6);
  for (let i = 1; i < entries.length; i++) {
    assert.ok(
      entries[i].time.getTime() > entries[i - 1].time.getTime(),
      `${entries[i].key} should come after ${entries[i - 1].key}`
    );
  }
});

test('the computed schedule is for the correct civil date in the configured timezone', () => {
  // 13:00 UTC on Jan 5 is already Jan 6, 02:00 in Auckland — "today" must be Jan 6 there.
  const cfg = cfgWith({
    location: { latitude: -36.85, longitude: 174.76, timezone: 'Pacific/Auckland', label: 'Auckland' },
  });
  const now = new Date('2026-01-05T13:00:00Z');
  const { date, entries } = todaySchedule(cfg, now);
  assert.equal(date, '2026-01-06');
  for (const e of entries) {
    const civil = DateTime.fromJSDate(e.time, { zone: 'Pacific/Auckland' }).toISODate();
    assert.equal(civil, '2026-01-06', `${e.key} should fall on the requested day`);
  }
});

test('hanafi asr is later than shafi asr', () => {
  const day = DateTime.fromISO('2026-07-27T12:00:00', { zone: 'Europe/London' });
  const shafi = timesForDay(cfgWith({ ...LONDON, calculation: { madhab: 'shafi' } }), day);
  const hanafi = timesForDay(cfgWith({ ...LONDON, calculation: { madhab: 'hanafi' } }), day);
  const asr = (entries) => entries.find((e) => e.key === 'asr').time.getTime();
  assert.ok(asr(hanafi) > asr(shafi));
});

test('minute adjustments shift the adhaan time', () => {
  const day = DateTime.fromISO('2026-07-27T12:00:00', { zone: 'Europe/London' });
  const base = timesForDay(cfgWith(LONDON), day);
  const adjusted = timesForDay(
    cfgWith({ ...LONDON, calculation: { adjustments: { dhuhr: 10 } } }),
    day
  );
  const dhuhr = (entries) => entries.find((e) => e.key === 'dhuhr').time.getTime();
  assert.equal(dhuhr(adjusted) - dhuhr(base), 10 * 60 * 1000);
});

test('nextAdhaan rolls over to tomorrow\'s fajr after isha', () => {
  const cfg = cfgWith(LONDON);
  const lateNight = DateTime.fromISO('2026-03-10T23:55:00', { zone: 'Europe/London' }).toJSDate();
  const next = nextAdhaan(cfg, lateNight);
  assert.ok(next, 'expected a next prayer');
  assert.equal(next.key, 'fajr');
  const civil = DateTime.fromJSDate(next.time, { zone: 'Europe/London' }).toISODate();
  assert.equal(civil, '2026-03-11');
});

test('nextAdhaan skips prayers whose adhaan is disabled', () => {
  const cfg = cfgWith({
    ...LONDON,
    adhaan: { prayers: { fajr: false, dhuhr: false, asr: false, maghrib: false, isha: true } },
  });
  const morning = DateTime.fromISO('2026-03-10T06:00:00', { zone: 'Europe/London' }).toJSDate();
  const next = nextAdhaan(cfg, morning);
  assert.equal(next.key, 'isha');
});

test('sunrise never gets an adhaan', () => {
  const cfg = cfgWith(LONDON);
  const now = DateTime.fromISO('2026-03-10T00:10:00', { zone: 'Europe/London' }).toJSDate();
  let cursor = now;
  for (let i = 0; i < 5; i++) {
    const next = nextAdhaan(cfg, cursor);
    assert.notEqual(next.key, 'sunrise');
    cursor = new Date(next.time.getTime() + 1000);
  }
});
