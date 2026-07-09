CREATE TABLE IF NOT EXISTS advertisers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  balance_usd REAL NOT NULL DEFAULT 100.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ads (
  id TEXT PRIMARY KEY,
  advertiser_id TEXT NOT NULL REFERENCES advertisers(id),
  title TEXT NOT NULL,
  -- comma-separated, lowercased, e.g. "aws,cloud,deploy"
  keywords TEXT NOT NULL,
  -- dollars per 1000 impressions
  bid_cpm_usd REAL NOT NULL,
  destination_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'failed')),
  error TEXT,
  video_path TEXT NOT NULL,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ad_assets (
  id TEXT PRIMARY KEY,
  ad_id TEXT NOT NULL REFERENCES ads(id),
  cols INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  fps INTEGER NOT NULL,
  frame_count INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  UNIQUE (ad_id, cols)
);

CREATE TABLE IF NOT EXISTS publishers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS impressions (
  id TEXT PRIMARY KEY,
  ad_id TEXT NOT NULL REFERENCES ads(id),
  publisher_id TEXT REFERENCES publishers(id),
  context_keywords TEXT NOT NULL,
  matched_keyword TEXT,
  cols INTEGER,
  -- winning bid at auction time
  price_cpm_usd REAL NOT NULL,
  -- what the advertiser paid for this single impression (price_cpm_usd / 1000)
  cost_usd REAL NOT NULL,
  -- the publisher's 50% share of cost_usd
  publisher_share_usd REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clicks (
  id TEXT PRIMARY KEY,
  impression_id TEXT NOT NULL REFERENCES impressions(id),
  ad_id TEXT NOT NULL REFERENCES ads(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ads_status ON ads(status);
CREATE INDEX IF NOT EXISTS idx_impressions_ad ON impressions(ad_id);
CREATE INDEX IF NOT EXISTS idx_clicks_ad ON clicks(ad_id);
