import { Router } from 'express';
import { getDb } from '../db.ts';

export const statsRouter = Router();

/** Dashboard rollup: money in, money out, who earned what. */
statsRouter.get('/api/stats/summary', (_req, res) => {
  const d = getDb();
  const totals = d
    .prepare(
      `SELECT COUNT(*) AS impressions,
              COALESCE(SUM(cost_usd), 0) AS total_spend_usd,
              COALESCE(SUM(publisher_share_usd), 0) AS publisher_earnings_usd
       FROM impressions`
    )
    .get() as { impressions: number; total_spend_usd: number; publisher_earnings_usd: number };
  const clicks = (d.prepare('SELECT COUNT(*) AS n FROM clicks').get() as { n: number }).n;
  const advertisers = d
    .prepare('SELECT name, balance_usd FROM advertisers ORDER BY name')
    .all();
  const publishers = d
    .prepare(
      `SELECT publishers.name,
              COUNT(impressions.id) AS impressions,
              COALESCE(SUM(impressions.publisher_share_usd), 0) AS earnings_usd
       FROM publishers
       LEFT JOIN impressions ON impressions.publisher_id = publishers.id
       GROUP BY publishers.id ORDER BY publishers.name`
    )
    .all();

  res.json({
    impressions: totals.impressions,
    clicks,
    totalSpendUsd: totals.total_spend_usd,
    publisherEarningsUsd: totals.publisher_earnings_usd,
    platformRevenueUsd: totals.total_spend_usd - totals.publisher_earnings_usd,
    advertisers,
    publishers,
  });
});
