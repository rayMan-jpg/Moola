/**
 * The ad auction. First-price for the MVP: the highest bid among keyword
 * matches wins and pays its own bid. (Second-price would be a one-line
 * change here: charge the runner-up's bid instead of the winner's.)
 */
import { getDb, normalizeKeywords, type AdRow } from './db.ts';

export interface AuctionWin {
  ad: AdRow;
  advertiserName: string;
  impressionId: string;
  matchedKeyword: string;
  priceCpmUsd: number;
  costUsd: number;
  publisherShareUsd: number;
}

export const PUBLISHER_REVENUE_SHARE = 0.5;

/**
 * Run the auction and, if there is a winner, record the impression and
 * charge the advertiser in one transaction. Returns null when no ad matches.
 */
export function runAuction(contextKeywords: string[], publisherId: string | null, cols: number | null): AuctionWin | null {
  const d = getDb();
  const context = normalizeKeywords(contextKeywords);
  if (context.length === 0) return null;

  const candidates = d
    .prepare(
      `SELECT ads.*, advertisers.name AS advertiser_name, advertisers.balance_usd
       FROM ads JOIN advertisers ON advertisers.id = ads.advertiser_id
       WHERE ads.status = 'ready' AND advertisers.balance_usd >= ads.bid_cpm_usd / 1000.0`
    )
    .all() as Array<AdRow & { advertiser_name: string; balance_usd: number }>;

  type Match = { row: (typeof candidates)[number]; keyword: string };
  const matches: Match[] = [];
  for (const row of candidates) {
    const adKeywords = normalizeKeywords(row.keywords);
    const hit = adKeywords.find((k) => context.includes(k));
    if (hit) matches.push({ row, keyword: hit });
  }
  if (matches.length === 0) return null;

  const topBid = Math.max(...matches.map((m) => m.row.bid_cpm_usd));
  const top = matches.filter((m) => m.row.bid_cpm_usd === topBid);
  const winner = top[Math.floor(Math.random() * top.length)];

  const impressionId = crypto.randomUUID();
  const costUsd = winner.row.bid_cpm_usd / 1000;
  const publisherShareUsd = costUsd * PUBLISHER_REVENUE_SHARE;

  d.transaction(() => {
    d.prepare(
      `INSERT INTO impressions
         (id, ad_id, publisher_id, context_keywords, matched_keyword, cols,
          price_cpm_usd, cost_usd, publisher_share_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      impressionId,
      winner.row.id,
      publisherId,
      context.join(','),
      winner.keyword,
      cols,
      winner.row.bid_cpm_usd,
      costUsd,
      publisherShareUsd
    );
    d.prepare('UPDATE advertisers SET balance_usd = balance_usd - ? WHERE id = ?').run(
      costUsd,
      winner.row.advertiser_id
    );
  })();

  return {
    ad: winner.row,
    advertiserName: winner.row.advertiser_name,
    impressionId,
    matchedKeyword: winner.keyword,
    priceCpmUsd: winner.row.bid_cpm_usd,
    costUsd,
    publisherShareUsd,
  };
}
