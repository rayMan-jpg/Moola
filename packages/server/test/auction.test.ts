import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.MOOLA_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'moola-test-'));

const { getDb } = await import('../src/db.ts');
const { runAuction } = await import('../src/auction.ts');

function addAd(id: string, advertiserId: string, keywords: string, bid: number, balance = 100) {
  const d = getDb();
  d.prepare(`INSERT OR IGNORE INTO advertisers (id, name, balance_usd) VALUES (?, ?, ?)`).run(
    advertiserId,
    `adv ${advertiserId}`,
    balance
  );
  d.prepare(
    `INSERT INTO ads (id, advertiser_id, title, keywords, bid_cpm_usd, destination_url, video_path, status)
     VALUES (?, ?, ?, ?, ?, 'https://example.com', '/dev/null', 'ready')`
  ).run(id, advertiserId, `ad ${id}`, keywords, bid);
}

describe('runAuction', () => {
  beforeAll(() => {
    addAd('a-aws-high', 'adv1', 'aws,cloud', 5);
    addAd('a-aws-low', 'adv2', 'aws', 2);
    addAd('a-python', 'adv3', 'python,pip', 3);
    addAd('a-broke', 'adv4', 'aws', 9, 0); // out of budget — must never win
  });

  it('highest matching bid wins', () => {
    const win = runAuction(['aws'], null, 120);
    expect(win?.ad.id).toBe('a-aws-high');
    expect(win?.matchedKeyword).toBe('aws');
    expect(win?.priceCpmUsd).toBe(5);
  });

  it('keyword matching is case/space-insensitive and scoped', () => {
    const win = runAuction([' PYTHON '], null, 120);
    expect(win?.ad.id).toBe('a-python');
  });

  it('returns null when nothing matches', () => {
    expect(runAuction(['golf'], null, 120)).toBeNull();
  });

  it('records the impression, charges the advertiser, splits 50/50', () => {
    const d = getDb();
    const before = (d.prepare(`SELECT balance_usd FROM advertisers WHERE id = 'adv3'`).get() as any).balance_usd;
    const win = runAuction(['pip'], null, 80)!;
    expect(win.costUsd).toBeCloseTo(3 / 1000);
    expect(win.publisherShareUsd).toBeCloseTo(win.costUsd / 2);
    const after = (d.prepare(`SELECT balance_usd FROM advertisers WHERE id = 'adv3'`).get() as any).balance_usd;
    expect(before - after).toBeCloseTo(win.costUsd);
    const imp = d.prepare('SELECT * FROM impressions WHERE id = ?').get(win.impressionId) as any;
    expect(imp.ad_id).toBe('a-python');
    expect(imp.matched_keyword).toBe('pip');
  });

  it('skips advertisers whose balance cannot cover one impression', () => {
    // a-broke bids $9 CPM but has $0 — the $5 ad must win instead.
    const win = runAuction(['aws'], null, 120);
    expect(win?.ad.id).toBe('a-aws-high');
  });
});
