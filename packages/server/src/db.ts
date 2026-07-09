/**
 * All SQLite access goes through this module so the driver can be swapped
 * in one place (fallback plan: pure-JS sql.js if better-sqlite3's native
 * binding ever fails to load on a platform).
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
// MOOLA_DATA_DIR override keeps tests away from the real local database.
export const DATA_DIR = process.env.MOOLA_DATA_DIR ?? path.join(REPO_ROOT, 'data');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
export const ASSETS_DIR = path.join(DATA_DIR, 'assets');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    mkdirSync(UPLOADS_DIR, { recursive: true });
    mkdirSync(ASSETS_DIR, { recursive: true });
    db = new Database(path.join(DATA_DIR, 'moola.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const schema = readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf8');
    db.exec(schema);
  }
  return db;
}

export interface AdvertiserRow {
  id: string;
  name: string;
  balance_usd: number;
  created_at: string;
}

export interface AdRow {
  id: string;
  advertiser_id: string;
  title: string;
  keywords: string;
  bid_cpm_usd: number;
  destination_url: string;
  status: 'processing' | 'ready' | 'failed';
  error: string | null;
  video_path: string;
  duration_ms: number | null;
  created_at: string;
}

export interface AdAssetRow {
  id: string;
  ad_id: string;
  cols: number;
  rows: number;
  fps: number;
  frame_count: number;
  file_path: string;
  bytes: number;
}

export interface PublisherRow {
  id: string;
  name: string;
  api_key: string;
  created_at: string;
}

/** Get an advertiser by name, creating it with the fake starting balance if new. */
export function getOrCreateAdvertiser(name: string): AdvertiserRow {
  const d = getDb();
  const existing = d.prepare('SELECT * FROM advertisers WHERE name = ?').get(name) as AdvertiserRow | undefined;
  if (existing) return existing;
  const id = crypto.randomUUID();
  d.prepare('INSERT INTO advertisers (id, name) VALUES (?, ?)').run(id, name);
  return d.prepare('SELECT * FROM advertisers WHERE id = ?').get(id) as AdvertiserRow;
}

/** Normalize a keywords string/array to canonical csv form: lowercase, trimmed, deduped. */
export function normalizeKeywords(input: string | string[]): string[] {
  const parts = Array.isArray(input) ? input : input.split(',');
  return [...new Set(parts.map((k) => k.trim().toLowerCase()).filter(Boolean))];
}
