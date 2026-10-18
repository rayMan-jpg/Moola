// Persistence on D1. D1 gives us atomic INSERTs and conditional UPDATEs, which the
// payment replay guard and the job lease need (KV is eventually consistent).

import type { FeedItem, HostingNeeds, JobStatus, Manifest, ProjectInput, Quote, TokenRecord } from '../../shared/contract';

export interface JobRecord {
  id: string;
  createdAt: number;
  status: JobStatus;
  quote: Quote;
  payTx: string;
  payer: string;
  project: ProjectInput;
  token: TokenRecord;
  needs: HostingNeeds;
  budgetCents: number;
  spentCents: number;
  repo?: { url: string; fullName: string; branch: string };
  environmentId?: string;
  sessionId?: string;
  feed: FeedItem[];
  manifest?: Manifest;
  spec?: string;
  live?: string;
  error?: string;
  attempts: number;
  syncedAt?: number;
  /** Payments credited to this job (initial + top-ups), "chain:tx". */
  payments: string[];
}

export interface Store {
  getJob(id: string): Promise<JobRecord | null>;
  /** Inserts a new job. Returns false if the id already exists. */
  insertJob(job: JobRecord): Promise<boolean>;
  putJob(job: JobRecord): Promise<void>;
  /** Claims a payment for a job. Returns the job id that owns it (ours if newly claimed). */
  claimPayment(key: string, jobId: string): Promise<string>;
  releasePayment(key: string, jobId: string): Promise<void>;
  /** Takes an exclusive lease on a job for `ms`. Returns false if someone else holds it. */
  lease(id: string, ms: number): Promise<boolean>;
  unlease(id: string): Promise<void>;
  getMeta(key: string): Promise<string | null>;
  putMeta(key: string, value: string): Promise<void>;
  /** Ids of jobs still in flight, oldest first. */
  activeJobIds(limit: number): Promise<string[]>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, created_at)`,
  `CREATE TABLE IF NOT EXISTS payments (key TEXT PRIMARY KEY, job_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

let schemaReady: Promise<void> | null = null;

export class D1Store implements Store {
  constructor(private db: D1Database) {}

  private ready(): Promise<void> {
    schemaReady ??= this.db.batch(SCHEMA.map((s) => this.db.prepare(s))).then(
      () => undefined,
      (e) => {
        schemaReady = null;
        throw e;
      },
    );
    return schemaReady;
  }

  async getJob(id: string) {
    await this.ready();
    const row = await this.db.prepare('SELECT data FROM jobs WHERE id = ?').bind(id).first<{ data: string }>();
    return row ? (JSON.parse(row.data) as JobRecord) : null;
  }

  async insertJob(job: JobRecord) {
    await this.ready();
    const r = await this.db
      .prepare('INSERT OR IGNORE INTO jobs (id, created_at, status, data) VALUES (?, ?, ?, ?)')
      .bind(job.id, job.createdAt, job.status, JSON.stringify(job))
      .run();
    return (r.meta.changes ?? 0) > 0;
  }

  async putJob(job: JobRecord) {
    await this.ready();
    await this.db.prepare('UPDATE jobs SET status = ?, data = ? WHERE id = ?').bind(job.status, JSON.stringify(job), job.id).run();
  }

  async claimPayment(key: string, jobId: string) {
    await this.ready();
    await this.db
      .prepare('INSERT OR IGNORE INTO payments (key, job_id, created_at) VALUES (?, ?, ?)')
      .bind(key, jobId, Date.now())
      .run();
    const row = await this.db.prepare('SELECT job_id FROM payments WHERE key = ?').bind(key).first<{ job_id: string }>();
    return row?.job_id ?? '';
  }

  async releasePayment(key: string, jobId: string) {
    await this.ready();
    await this.db.prepare('DELETE FROM payments WHERE key = ? AND job_id = ?').bind(key, jobId).run();
  }

  async lease(id: string, ms: number) {
    await this.ready();
    const now = Date.now();
    const r = await this.db
      .prepare('UPDATE jobs SET lease_until = ? WHERE id = ? AND lease_until < ?')
      .bind(now + ms, id, now)
      .run();
    return (r.meta.changes ?? 0) > 0;
  }

  async unlease(id: string) {
    await this.ready();
    await this.db.prepare('UPDATE jobs SET lease_until = 0 WHERE id = ?').bind(id).run();
  }

  async getMeta(key: string) {
    await this.ready();
    const row = await this.db.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first<{ value: string }>();
    return row?.value ?? null;
  }

  async putMeta(key: string, value: string) {
    await this.ready();
    await this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(key, value)
      .run();
  }

  async activeJobIds(limit: number) {
    await this.ready();
    const r = await this.db
      .prepare("SELECT id FROM jobs WHERE status IN ('starting', 'running') ORDER BY created_at LIMIT ?")
      .bind(limit)
      .all<{ id: string }>();
    return r.results.map((x) => x.id);
  }
}

/** In-memory store with the same semantics, for tests and local dev. */
export class MemoryStore implements Store {
  jobs = new Map<string, { data: string; leaseUntil: number }>();
  payments = new Map<string, string>();
  meta = new Map<string, string>();

  async getJob(id: string) {
    const j = this.jobs.get(id);
    return j ? (JSON.parse(j.data) as JobRecord) : null;
  }
  async insertJob(job: JobRecord) {
    if (this.jobs.has(job.id)) return false;
    this.jobs.set(job.id, { data: JSON.stringify(job), leaseUntil: 0 });
    return true;
  }
  async putJob(job: JobRecord) {
    const j = this.jobs.get(job.id);
    if (j) j.data = JSON.stringify(job);
  }
  async claimPayment(key: string, jobId: string) {
    if (!this.payments.has(key)) this.payments.set(key, jobId);
    return this.payments.get(key)!;
  }
  async releasePayment(key: string, jobId: string) {
    if (this.payments.get(key) === jobId) this.payments.delete(key);
  }
  async lease(id: string, ms: number) {
    const j = this.jobs.get(id);
    const now = Date.now();
    if (!j || j.leaseUntil >= now) return false;
    j.leaseUntil = now + ms;
    return true;
  }
  async unlease(id: string) {
    const j = this.jobs.get(id);
    if (j) j.leaseUntil = 0;
  }
  async getMeta(key: string) {
    return this.meta.get(key) ?? null;
  }
  async putMeta(key: string, value: string) {
    this.meta.set(key, value);
  }
  async activeJobIds(limit: number) {
    return [...this.jobs.values()]
      .map((j) => JSON.parse(j.data) as JobRecord)
      .filter((j) => j.status === 'starting' || j.status === 'running')
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit)
      .map((j) => j.id);
  }
}
