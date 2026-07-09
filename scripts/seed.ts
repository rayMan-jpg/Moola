/**
 * `npm run seed` — populates the local Moola instance with a demo publisher,
 * two advertisers, and three ready-to-serve ads (transcoded synchronously).
 * Re-runnable: uses fixed IDs and skips transcoding when assets exist.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { transcode } from '../packages/transcoder/src/index.ts';
import { ASSETS_DIR, getDb, REPO_ROOT } from '../packages/server/src/db.ts';

const d = getDb();
const videosDir = path.join(REPO_ROOT, 'demo', 'videos');

const ads = [
  {
    id: 'ad-moola-cloud',
    advertiser: { id: 'adv-moola-cloud', name: 'Moola Cloud Inc' },
    title: 'Moola Cloud — deploy faster',
    keywords: 'aws,cloud,deploy,hosting',
    bidCpmUsd: 5.0,
    destinationUrl: 'https://example.com/moola-cloud',
    video: 'moola-cloud.mp4',
  },
  {
    id: 'ad-pytools-pro',
    advertiser: { id: 'adv-pytools', name: 'PyTools GmbH' },
    title: 'PyTools Pro — ship Python 10x faster',
    keywords: 'python,pip,tooling,packaging',
    bidCpmUsd: 3.0,
    destinationUrl: 'https://example.com/pytools',
    video: 'pytools-pro.mp4',
  },
  {
    id: 'ad-test-pattern',
    advertiser: { id: 'adv-pytools', name: 'PyTools GmbH' },
    title: 'Test Pattern Special',
    keywords: 'test,demo',
    bidCpmUsd: 1.0,
    destinationUrl: 'https://example.com/test-pattern',
    video: 'test-pattern.mp4',
  },
];

// Make sure the sample videos exist (generate them if not).
if (ads.some((a) => !existsSync(path.join(videosDir, a.video)))) {
  console.log('Sample videos missing — generating them first...');
  execFileSync('npx', ['tsx', path.join(REPO_ROOT, 'demo', 'make-sample-videos.ts')], { stdio: 'inherit' });
}

// Demo publisher with a fixed, documented API key.
d.prepare(
  `INSERT INTO publishers (id, name, api_key) VALUES ('pub-demo', 'Demo CLI Tool', 'demo-pub-key')
   ON CONFLICT(api_key) DO NOTHING`
).run();

for (const ad of ads) {
  d.prepare(
    `INSERT INTO advertisers (id, name) VALUES (?, ?) ON CONFLICT(name) DO NOTHING`
  ).run(ad.advertiser.id, ad.advertiser.name);
  const advertiserId = (
    d.prepare('SELECT id FROM advertisers WHERE name = ?').get(ad.advertiser.name) as { id: string }
  ).id;

  const videoPath = path.join(videosDir, ad.video);
  d.prepare(
    `INSERT INTO ads (id, advertiser_id, title, keywords, bid_cpm_usd, destination_url, video_path, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'processing')
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, keywords = excluded.keywords,
       bid_cpm_usd = excluded.bid_cpm_usd, destination_url = excluded.destination_url`
  ).run(ad.id, advertiserId, ad.title, ad.keywords, ad.bidCpmUsd, ad.destinationUrl, videoPath);

  const haveAssets =
    (d.prepare('SELECT COUNT(*) AS n FROM ad_assets WHERE ad_id = ?').get(ad.id) as { n: number }).n > 0 &&
    (d.prepare('SELECT status FROM ads WHERE id = ?').get(ad.id) as { status: string }).status === 'ready';
  if (haveAssets) {
    console.log(`= ${ad.title} (already transcoded)`);
    continue;
  }

  process.stdout.write(`~ transcoding ${ad.video} ... `);
  const assets = await transcode(videoPath, ASSETS_DIR, ad.id);
  const insert = d.prepare(
    `INSERT OR REPLACE INTO ad_assets (id, ad_id, cols, rows, fps, frame_count, file_path, bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  d.transaction(() => {
    for (const a of assets) {
      insert.run(crypto.randomUUID(), ad.id, a.cols, a.rows, a.fps, a.frameCount, a.filePath, a.bytes);
    }
    d.prepare(`UPDATE ads SET status = 'ready', duration_ms = ? WHERE id = ?`).run(assets[0].durationMs, ad.id);
  })();
  console.log(`done (${assets.map((a) => `${a.cols}c`).join(', ')})`);
}

const counts = {
  advertisers: (d.prepare('SELECT COUNT(*) AS n FROM advertisers').get() as { n: number }).n,
  ads: (d.prepare(`SELECT COUNT(*) AS n FROM ads WHERE status = 'ready'`).get() as { n: number }).n,
  publishers: (d.prepare('SELECT COUNT(*) AS n FROM publishers').get() as { n: number }).n,
};
console.log(
  `\nSeeded: ${counts.advertisers} advertisers, ${counts.ads} ready ads, ${counts.publishers} publisher (api key: demo-pub-key)`
);
console.log('Next: npm run dev   (then, in another terminal: npm run demo)');
