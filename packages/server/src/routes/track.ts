import { Router } from 'express';
import { getDb } from '../db.ts';

export const trackRouter = Router();

/**
 * Click-through: OSC 8 links in the terminal point here, so every click is
 * recorded before the browser is bounced to the advertiser's site.
 */
trackRouter.get('/click/:impressionId', (req, res) => {
  const d = getDb();
  const row = d
    .prepare(
      `SELECT impressions.id, impressions.ad_id, ads.destination_url
       FROM impressions JOIN ads ON ads.id = impressions.ad_id
       WHERE impressions.id = ?`
    )
    .get(req.params.impressionId) as { id: string; ad_id: string; destination_url: string } | undefined;
  if (!row) {
    res.status(404).send('Unknown impression');
    return;
  }
  d.prepare('INSERT INTO clicks (id, impression_id, ad_id) VALUES (?, ?, ?)').run(
    crypto.randomUUID(),
    row.id,
    row.ad_id
  );
  res.redirect(302, row.destination_url);
});
