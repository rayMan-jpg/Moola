import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { transcode } from '@moola/transcoder';
import { ASSETS_DIR, getDb, getOrCreateAdvertiser, normalizeKeywords, UPLOADS_DIR, type AdAssetRow } from '../db.ts';

export const adsRouter = Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname) || '.mp4'}`),
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
});

/** Kick off transcoding in the background; flip ad status when done. */
function transcodeInBackground(adId: string, videoPath: string): void {
  const d = getDb();
  transcode(videoPath, ASSETS_DIR, adId)
    .then((assets) => {
      const insert = d.prepare(
        `INSERT OR REPLACE INTO ad_assets (id, ad_id, cols, rows, fps, frame_count, file_path, bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      d.transaction(() => {
        for (const a of assets) {
          insert.run(crypto.randomUUID(), adId, a.cols, a.rows, a.fps, a.frameCount, a.filePath, a.bytes);
        }
        d.prepare(`UPDATE ads SET status = 'ready', duration_ms = ? WHERE id = ?`).run(assets[0]?.durationMs ?? null, adId);
      })();
      console.log(`[transcode] ad ${adId} ready (${assets.map((a) => `${a.cols}c`).join(', ')})`);
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      d.prepare(`UPDATE ads SET status = 'failed', error = ? WHERE id = ?`).run(msg, adId);
      console.error(`[transcode] ad ${adId} failed: ${msg}`);
    });
}

// Self-serve ad upload. Multipart form: video file + campaign fields.
adsRouter.post('/api/ads', upload.single('video'), (req, res) => {
  const { advertiserName, title, keywords, bidCpmUsd, destinationUrl } = req.body as Record<string, string>;
  const problems: string[] = [];
  if (!req.file) problems.push('video file is required (field name: video)');
  if (!advertiserName?.trim()) problems.push('advertiserName is required');
  if (!title?.trim()) problems.push('title is required');
  if (normalizeKeywords(keywords ?? '').length === 0) problems.push('at least one keyword is required');
  const bid = Number(bidCpmUsd);
  if (!Number.isFinite(bid) || bid <= 0) problems.push('bidCpmUsd must be a positive number');
  if (!/^https?:\/\//.test(destinationUrl ?? '')) problems.push('destinationUrl must start with http:// or https://');
  if (problems.length > 0) {
    res.status(400).json({ error: problems.join('; ') });
    return;
  }

  const d = getDb();
  const advertiser = getOrCreateAdvertiser(advertiserName.trim());
  const id = crypto.randomUUID();
  d.prepare(
    `INSERT INTO ads (id, advertiser_id, title, keywords, bid_cpm_usd, destination_url, video_path)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, advertiser.id, title.trim(), normalizeKeywords(keywords).join(','), bid, destinationUrl, req.file!.path);

  transcodeInBackground(id, req.file!.path);
  res.status(201).json({ id, status: 'processing' });
});

const AD_WITH_STATS = `
  SELECT ads.id, ads.title, ads.keywords, ads.bid_cpm_usd, ads.destination_url,
         ads.status, ads.error, ads.duration_ms, ads.created_at,
         advertisers.name AS advertiser_name, advertisers.balance_usd AS advertiser_balance_usd,
         (SELECT COUNT(*) FROM impressions WHERE impressions.ad_id = ads.id) AS impressions,
         (SELECT COUNT(*) FROM clicks WHERE clicks.ad_id = ads.id) AS clicks,
         (SELECT COALESCE(SUM(cost_usd), 0) FROM impressions WHERE impressions.ad_id = ads.id) AS spend_usd
  FROM ads JOIN advertisers ON advertisers.id = ads.advertiser_id`;

adsRouter.get('/api/ads', (_req, res) => {
  res.json(getDb().prepare(`${AD_WITH_STATS} ORDER BY ads.created_at DESC`).all());
});

adsRouter.get('/api/ads/:id', (req, res) => {
  const row = getDb().prepare(`${AD_WITH_STATS} WHERE ads.id = ?`).get(req.params.id);
  if (!row) {
    res.status(404).json({ error: 'ad not found' });
    return;
  }
  res.json(row);
});

// Raw frame asset for a given width (dashboard preview). Files are stored
// gzipped, so serve them as-is and let the browser decompress.
adsRouter.get('/api/ads/:id/asset', (req, res) => {
  const wanted = Number(req.query.cols) || 120;
  const assets = getDb()
    .prepare('SELECT * FROM ad_assets WHERE ad_id = ? ORDER BY cols DESC')
    .all(req.params.id) as AdAssetRow[];
  const best = assets.find((a) => a.cols <= wanted) ?? assets[assets.length - 1];
  if (!best) {
    res.status(404).json({ error: 'no transcoded asset for this ad (still processing?)' });
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Encoding', 'gzip');
  res.sendFile(best.file_path);
});
