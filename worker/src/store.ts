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
  /** Set (and saved) right before sessions.create, so a retry looks for that session first. */
  sessionRequestedAt?: number;
  feed: FeedItem[];
  manifest?: Manifest;
  spec?: string;
  live?: string;
  error?: string;
  attempts: number;
  /** Next engine start attempt (backoff after a failed one). */
  nextAttemptAt?: number;
  syncedAt?: number;
  /** Times the session was nudged to continue after retries_exhausted, and when the next nudge may go. */
  resumes?: number;
  resumeAfter?: number;
  /** Syncs that found the session finished but no manifest yet (outputs lag behind the idle event). */
  collectTries?: number;
  /** Payments credited to this job (initial + top-ups), "chain:tx". */
  payments: string[];
  /**
   * A top-up being credited, saved under the lease before the session cap is raised: a retry (or
   * the next top-up) applies this target instead of recomputing it from spend made since.
   */
  crediting?: { paymentKey: string; targetCents: number; usdCents: number };
}

export interface Store {
  getJob(id: string): Promise<JobRecord | null>;
  /** Inserts a new job. Returns false if the id already exists. */
  insertJob(job: JobRecord): Promise<boolean>;
  /**
   * Writes the job. With a lease token this is a compare-and-set: nothing is written (false) unless
   * that lease is still ours, and `creditKey` marks that payment credited in the same transaction.
   * Without a token the write is unconditional (tests and tooling only).
   */
  putJob(job: JobRecord, leaseToken?: string, creditKey?: string): Promise<boolean>;
  /** Claims a payment for a job. Returns the job id that owns it (ours if newly claimed). */
  claimPayment(key: string, jobId: string): Promise<string>;
  /** Who owns a payment, and whether its budget has been credited. */
  payment(key: string): Promise<{ jobId: string; credited: boolean } | null>;
  /** Takes an exclusive lease on a job for `ms`. Returns its token, or null if someone else holds it. */
  lease(id: string, ms: number): Promise<string | null>;
  /** Extends a lease we still hold. */
  renew(id: string, token: string, ms: number): Promise<boolean>;
  /** Releases the lease if it is still ours. */
  unlease(id: string, token: string): Promise<void>;
  getMeta(key: string): Promise<string | null>;
  putMeta(key: string, value: string): Promise<void>;
  /**
   * Ids of jobs in flight that have work due at `now`, oldest first: running jobs, and starting
   * jobs whose next attempt is due (ones parked in backoff would only fill the sweep's slots).
   */
  activeJobIds(limit: number, now: number): Promise<string[]>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0, lease_token TEXT)`,
  `CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, created_at)`,
  `CREATE TABLE IF NOT EXISTS payments (key TEXT PRIMARY KEY, job_id TEXT NOT NULL, created_at INTEGER NOT NULL, credited INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

// Columns added after the first deploy. Each ALTER fails harmlessly once its column exists; `then`
// runs only on the deploy that added it, with the time the migration started.
const MIGRATIONS: { sql: string; then?: string }[] = [
  { sql: 'ALTER TABLE jobs ADD COLUMN lease_token TEXT' },
  // Before this column, failed top-ups released their claim, so every older row was credited.
  { sql: 'ALTER TABLE payments ADD COLUMN credited INTEGER NOT NULL DEFAULT 0', then: 'UPDATE payments SET credited = 1 WHERE created_at < ?' },
];

export function newLeaseToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let schemaReady: Promise<void> | null = null;

export class D1Store implements Store {
  constructor(private db: D1Database) {}

  private ready(): Promise<void> {
    schemaReady ??= this.migrate().catch((e) => {
      schemaReady = null;
      throw e;
    });
    return schemaReady;
  }

  private async migrate() {
    const started = Date.now();
    await this.db.batch(SCHEMA.map((s) => this.db.prepare(s)));
    for (const m of MIGRATIONS) {
      try {
        await this.db.prepare(m.sql).run();
      } catch (e) {
        if (/duplicate column/i.test(String((e as Error)?.message ?? e))) continue;
        throw e;
      }
      if (m.then) await this.db.prepare(m.then).bind(started).run();
    }
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

  async putJob(job: JobRecord, leaseToken?: string, creditKey?: string) {
    await this.ready();
    const data = JSON.stringify(job);
    if (leaseToken === undefined) {
      const r = await this.db.prepare('UPDATE jobs SET status = ?, data = ? WHERE id = ?').bind(job.status, data, job.id).run();
      return (r.meta.changes ?? 0) > 0;
    }
    const stmts: D1PreparedStatement[] = [];
    if (creditKey) {
      // Runs first in the same transaction, and only while the lease is ours, like the job write.
      stmts.push(
        this.db
          .prepare('UPDATE payments SET credited = 1 WHERE key = ? AND job_id = ? AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND lease_token = ?)')
          .bind(creditKey, job.id, job.id, leaseToken),
      );
    }
    stmts.push(this.db.prepare('UPDATE jobs SET status = ?, data = ? WHERE id = ? AND lease_token = ?').bind(job.status, data, job.id, leaseToken));
    const rs = await this.db.batch(stmts);
    return (rs[rs.length - 1].meta.changes ?? 0) > 0;
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

  async payment(key: string) {
    await this.ready();
    const row = await this.db.prepare('SELECT job_id, credited FROM payments WHERE key = ?').bind(key).first<{ job_id: string; credited: number }>();
    return row ? { jobId: row.job_id, credited: row.credited === 1 } : null;
  }

  async lease(id: string, ms: number) {
    await this.ready();
    const now = Date.now();
    const token = newLeaseToken();
    const r = await this.db
      .prepare('UPDATE jobs SET lease_until = ?, lease_token = ? WHERE id = ? AND lease_until < ?')
      .bind(now + ms, token, id, now)
      .run();
    return (r.meta.changes ?? 0) > 0 ? token : null;
  }

  async renew(id: string, token: string, ms: number) {
    await this.ready();
    const r = await this.db
      .prepare('UPDATE jobs SET lease_until = ? WHERE id = ? AND lease_token = ?')
      .bind(Date.now() + ms, id, token)
      .run();
    return (r.meta.changes ?? 0) > 0;
  }

  async unlease(id: string, token: string) {
    await this.ready();
    await this.db.prepare('UPDATE jobs SET lease_until = 0, lease_token = NULL WHERE id = ? AND lease_token = ?').bind(id, token).run();
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

  async activeJobIds(limit: number, now: number) {
    await this.ready();
    const r = await this.db
      .prepare(
        "SELECT id FROM jobs WHERE status = 'running' OR (status = 'starting' AND COALESCE(json_extract(data, '$.nextAttemptAt'), 0) <= ?) ORDER BY created_at LIMIT ?",
      )
      .bind(now, limit)
      .all<{ id: string }>();
    return r.results.map((x) => x.id);
  }
}

/** In-memory store with the same semantics, for tests and local dev. */
export class MemoryStore implements Store {
  jobs = new Map<string, { data: string; leaseUntil: number; leaseToken: string | null }>();
  payments = new Map<string, { jobId: string; credited: boolean }>();
  meta = new Map<string, string>();

  async getJob(id: string) {
    const j = this.jobs.get(id);
    return j ? (JSON.parse(j.data) as JobRecord) : null;
  }
  async insertJob(job: JobRecord) {
    if (this.jobs.has(job.id)) return false;
    this.jobs.set(job.id, { data: JSON.stringify(job), leaseUntil: 0, leaseToken: null });
    return true;
  }
  async putJob(job: JobRecord, leaseToken?: string, creditKey?: string) {
    const j = this.jobs.get(job.id);
    if (!j || (leaseToken !== undefined && j.leaseToken !== leaseToken)) return false;
    j.data = JSON.stringify(job);
    const p = creditKey ? this.payments.get(creditKey) : undefined;
    if (p?.jobId === job.id) p.credited = true;
    return true;
  }
  async claimPayment(key: string, jobId: string) {
    if (!this.payments.has(key)) this.payments.set(key, { jobId, credited: false });
    return this.payments.get(key)!.jobId;
  }
  async payment(key: string) {
    const p = this.payments.get(key);
    return p ? { ...p } : null;
  }
  async lease(id: string, ms: number) {
    const j = this.jobs.get(id);
    const now = Date.now();
    if (!j || j.leaseUntil >= now) return null;
    j.leaseUntil = now + ms;
    j.leaseToken = newLeaseToken();
    return j.leaseToken;
  }
  async renew(id: string, token: string, ms: number) {
    const j = this.jobs.get(id);
    if (!j || j.leaseToken !== token) return false;
    j.leaseUntil = Date.now() + ms;
    return true;
  }
  async unlease(id: string, token: string) {
    const j = this.jobs.get(id);
    if (j?.leaseToken === token) {
      j.leaseUntil = 0;
      j.leaseToken = null;
    }
  }
  async getMeta(key: string) {
    return this.meta.get(key) ?? null;
  }
  async putMeta(key: string, value: string) {
    this.meta.set(key, value);
  }
  async activeJobIds(limit: number, now: number) {
    return [...this.jobs.values()]
      .map((j) => JSON.parse(j.data) as JobRecord)
      .filter((j) => j.status === 'running' || (j.status === 'starting' && (j.nextAttemptAt ?? 0) <= now))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit)
      .map((j) => j.id);
  }
}
