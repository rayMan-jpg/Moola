import { DateTime } from 'luxon';
import { todaySchedule, nextAdhaan } from './prayer.js';

// Arms one timer per remaining enabled prayer today, plus a rollover timer just
// after midnight (in the configured timezone) that recomputes tomorrow's times.
// setTimeout on an absolute delta keeps this correct across DST changes.
class Scheduler {
  constructor({ getConfig, playPrayer, log }) {
    this.getConfig = getConfig;
    this.playPrayer = playPrayer;
    this.log = log;
    this.timers = [];
  }

  reschedule() {
    this.stop();
    const cfg = this.getConfig();
    const now = Date.now();

    const { entries } = todaySchedule(cfg);
    for (const entry of entries) {
      if (!cfg.adhaan.prayers[entry.key]) continue;
      const delay = entry.time.getTime() - now;
      if (delay <= 500) continue;
      this.timers.push(setTimeout(() => this.playPrayer(entry), delay));
    }

    const zone = cfg.location.timezone;
    const rollover = DateTime.now().setZone(zone).plus({ days: 1 }).startOf('day').plus({ seconds: 20 });
    this.timers.push(
      setTimeout(() => this.reschedule(), Math.max(30_000, rollover.toMillis() - now))
    );

    const next = nextAdhaan(cfg);
    if (next) {
      const at = DateTime.fromJSDate(next.time, { zone }).toFormat('ccc HH:mm');
      this.log('info', `Scheduler armed — next adhaan: ${next.name} at ${at}`);
    } else {
      this.log('warn', 'Scheduler armed, but no prayers have adhaan enabled');
    }
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}

export { Scheduler };
