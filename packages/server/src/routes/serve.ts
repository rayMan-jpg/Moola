import { Router } from 'express';
import { readAsset } from '@moola/transcoder';
import { MIN_COLS, pickWidth } from '@moola/shared';
import { getDb, type AdAssetRow, type PublisherRow } from '../db.ts';
import { runAuction } from '../auction.ts';

export const serveRouter = Router();

/**
 * The ad slot. A publisher's SDK calls this when its CLI enters a wait state.
 *   GET /api/serve?keywords=aws,python&cols=120&rows=40&publisher=<apiKey>
 * 204 = no ad (SDK skips silently). 200 = winner + full frame asset.
 */
serveRouter.get('/api/serve', (req, res) => {
  const d = getDb();
  const keywords = String(req.query.keywords ?? '').split(',');
  const cols = Number(req.query.cols) || 0;

  const publisher = req.query.publisher
    ? (d.prepare('SELECT * FROM publishers WHERE api_key = ?').get(String(req.query.publisher)) as PublisherRow | undefined)
    : undefined;

  if (cols < MIN_COLS) {
    res.status(204).end();
    return;
  }

  const win = runAuction(keywords, publisher?.id ?? null, cols);
  if (!win) {
    res.status(204).end();
    return;
  }

  const assets = d.prepare('SELECT * FROM ad_assets WHERE ad_id = ?').all(win.ad.id) as AdAssetRow[];
  const width = pickWidth(cols, assets.map((a) => a.cols));
  const asset = assets.find((a) => a.cols === width);
  if (!asset) {
    res.status(204).end();
    return;
  }

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json({
    adId: win.ad.id,
    impressionId: win.impressionId,
    title: win.ad.title,
    advertiser: win.advertiserName,
    matchedKeyword: win.matchedKeyword,
    destinationUrl: win.ad.destination_url,
    clickUrl: `${baseUrl}/click/${win.impressionId}`,
    asset: readAsset(asset.file_path),
  });
});
