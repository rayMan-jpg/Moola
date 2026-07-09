/**
 * moola-sdk — one call for CLI developers:
 *
 *   import { playAd } from 'moola-sdk';
 *   await playAd({ context: ['aws', 'python'] });
 *
 * Plays a short sponsored terminal video during your tool's wait state and
 * earns you 50% of the ad revenue. Designed to be impossible to regret:
 * it NEVER throws, and it silently does nothing when the output isn't an
 * interactive terminal, the terminal is too narrow, the ad server is
 * unreachable, or no ad matches the context.
 */
import { MIN_COLS, osc8, playAsset, type FrameAsset, type PlayResult } from '@moola/shared';

export interface PlayAdOptions {
  /** What the CLI/agent is working on right now, e.g. ['aws', 'python']. */
  context: string[];
  /** Ad server base URL. Default: http://localhost:4141 (or MOOLA_SERVER_URL). */
  serverUrl?: string;
  /** Your publisher API key. Default: demo-pub-key (or MOOLA_PUBLISHER_KEY). */
  publisherKey?: string;
  /** Max time to wait for the ad server before giving up. Default 2000 ms. */
  timeoutMs?: number;
  /** Log skip reasons to stderr instead of staying silent. */
  debug?: boolean;
}

export interface PlayAdOutcome {
  played: boolean;
  /** When played: whether it ran to the end or was skipped by a keypress. */
  playback?: PlayResult;
  /** When not played: the reason (for debug/telemetry). */
  reason?: string;
  adId?: string;
  title?: string;
  clickUrl?: string;
}

interface ServeResponse {
  adId: string;
  impressionId: string;
  title: string;
  advertiser: string;
  destinationUrl: string;
  clickUrl: string;
  asset: FrameAsset;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export async function playAd(opts: PlayAdOptions): Promise<PlayAdOutcome> {
  const debug = (reason: string): PlayAdOutcome => {
    if (opts.debug) console.error(`[moola] no ad: ${reason}`);
    return { played: false, reason };
  };

  try {
    const out = process.stdout;
    if (!out.isTTY) return debug('stdout is not a TTY');
    const cols = out.columns ?? 0;
    const rows = out.rows ?? 0;
    if (cols < MIN_COLS) return debug(`terminal too narrow (${cols} cols; need ${MIN_COLS})`);

    const serverUrl = (opts.serverUrl ?? process.env.MOOLA_SERVER_URL ?? 'http://localhost:4141').replace(/\/$/, '');
    const publisherKey = opts.publisherKey ?? process.env.MOOLA_PUBLISHER_KEY ?? 'demo-pub-key';
    const params = new URLSearchParams({
      keywords: opts.context.join(','),
      cols: String(cols),
      rows: String(rows),
      publisher: publisherKey,
    });

    let res: Response;
    try {
      res = await fetch(`${serverUrl}/api/serve?${params}`, {
        signal: AbortSignal.timeout(opts.timeoutMs ?? 2000),
      });
    } catch {
      return debug(`ad server unreachable at ${serverUrl}`);
    }
    if (res.status === 204) return debug('no ad matched this context');
    if (!res.ok) return debug(`ad server returned ${res.status}`);

    const ad = (await res.json()) as ServeResponse;
    // The video must fit: rows + footer + one spare line.
    if (rows > 0 && ad.asset.rows + 2 > rows) return debug(`terminal too short (${rows} rows; ad needs ${ad.asset.rows + 2})`);

    const domain = domainOf(ad.destinationUrl);
    const footer = osc8(ad.clickUrl, `▶ Sponsored: ${ad.title} — ${domain}`) + '  (press any key to skip)';
    const leaveBehind = `Ad: ${osc8(ad.clickUrl, `${ad.title} — ${domain}`)}`;

    const playback = await playAsset(ad.asset, { footer, leaveBehind });
    return { played: true, playback, adId: ad.adId, title: ad.title, clickUrl: ad.clickUrl };
  } catch (err) {
    // Whatever happened, the host CLI must not feel it.
    return debug(`unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export default { playAd };
