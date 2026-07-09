import path from 'node:path';
import express from 'express';
import { adsRouter } from './routes/ads.ts';
import { serveRouter } from './routes/serve.ts';
import { statsRouter } from './routes/stats.ts';
import { trackRouter } from './routes/track.ts';
import { getDb } from './db.ts';

const PORT = Number(process.env.MOOLA_PORT) || 4141;

const app = express();
app.use(express.json());
app.use(adsRouter);
app.use(serveRouter);
app.use(trackRouter);
app.use(statsRouter);
app.use(express.static(path.join(import.meta.dirname, '..', 'public')));

getDb(); // fail fast if the DB can't open

app.listen(PORT, () => {
  console.log(`Moola server on http://localhost:${PORT}`);
  console.log(`  dashboard: http://localhost:${PORT}/`);
  console.log(`  ad slot:   http://localhost:${PORT}/api/serve?keywords=aws&cols=120&publisher=demo-pub-key`);
});
