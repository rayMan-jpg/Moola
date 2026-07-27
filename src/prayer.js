import * as adhan from 'adhan';
import { DateTime } from 'luxon';

const PRAYER_META = [
  { key: 'fajr', name: 'Fajr', arabic: 'الفجر' },
  { key: 'sunrise', name: 'Sunrise', arabic: 'الشروق' },
  { key: 'dhuhr', name: 'Dhuhr', arabic: 'الظهر' },
  { key: 'asr', name: 'Asr', arabic: 'العصر' },
  { key: 'maghrib', name: 'Maghrib', arabic: 'المغرب' },
  { key: 'isha', name: 'Isha', arabic: 'العشاء' },
];

function buildParams(cfg) {
  const factory =
    adhan.CalculationMethod[cfg.calculation.method] || adhan.CalculationMethod.MuslimWorldLeague;
  const params = factory();
  params.madhab = cfg.calculation.madhab === 'hanafi' ? adhan.Madhab.Hanafi : adhan.Madhab.Shafi;

  const coords = new adhan.Coordinates(cfg.location.latitude, cfg.location.longitude);
  const rule = cfg.calculation.highLatitudeRule;
  if (rule === 'auto') {
    if (typeof adhan.HighLatitudeRule.recommended === 'function') {
      params.highLatitudeRule = adhan.HighLatitudeRule.recommended(coords);
    }
  } else if (rule === 'middleofthenight') {
    params.highLatitudeRule = adhan.HighLatitudeRule.MiddleOfTheNight;
  } else if (rule === 'seventhofthenight') {
    params.highLatitudeRule = adhan.HighLatitudeRule.SeventhOfTheNight;
  } else if (rule === 'twilightangle') {
    params.highLatitudeRule = adhan.HighLatitudeRule.TwilightAngle;
  }

  for (const p of ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']) {
    params.adjustments[p] = cfg.calculation.adjustments[p] | 0;
  }
  return { params, coords };
}

// adhan reads the civil date from the Date's components in the *server's* local
// timezone, so we hand it a Date whose local components spell out the day we
// want in the *user's* timezone. The returned times are exact instants, so the
// server's own timezone never affects correctness beyond this.
function civilDateFor(dayDt) {
  return new Date(dayDt.year, dayDt.month - 1, dayDt.day, 12, 0, 0);
}

// dayDt: a luxon DateTime pinned to the configured timezone.
function timesForDay(cfg, dayDt) {
  const { params, coords } = buildParams(cfg);
  const pt = new adhan.PrayerTimes(coords, civilDateFor(dayDt), params);
  return PRAYER_META.map((m) => ({ ...m, time: pt[m.key] }));
}

function todaySchedule(cfg, now = new Date()) {
  const today = DateTime.fromJSDate(now, { zone: cfg.location.timezone });
  return { date: today.toISODate(), entries: timesForDay(cfg, today) };
}

// The next prayer with adhaan enabled, looking into tomorrow once today is done.
// Sunrise is never a candidate: it has no entry in cfg.adhaan.prayers.
function nextAdhaan(cfg, now = new Date()) {
  for (let offset = 0; offset < 2; offset++) {
    const day = DateTime.fromJSDate(now, { zone: cfg.location.timezone }).plus({ days: offset });
    const hit = timesForDay(cfg, day).find(
      (e) => cfg.adhaan.prayers[e.key] && e.time.getTime() > now.getTime()
    );
    if (hit) return hit;
  }
  return null;
}

export { PRAYER_META, buildParams, timesForDay, todaySchedule, nextAdhaan };
