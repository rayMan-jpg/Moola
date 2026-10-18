// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { D1Store, MemoryStore, type JobRecord, type Store } from '../../../worker/src/store';

interface SqliteStatement {
  run(...args: unknown[]): { changes: number | bigint };
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}

/** Just enough of D1 on node:sqlite (SQLite with JSON1, like D1) to run the store's real SQL. */
async function d1(): Promise<D1Database> {
  // Not a static import: the worker's types don't include Node's.
  const { DatabaseSync } = (await import('node:sqlite' as string)) as { DatabaseSync: new (path: string) => { prepare(sql: string): SqliteStatement; exec(sql: string): void } };
  const raw = new DatabaseSync(':memory:');
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    run: async () => ({ meta: { changes: Number(raw.prepare(sql).run(...args).changes) } }),
    first: async () => raw.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: raw.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (ss: ReturnType<typeof stmt>[]) => {
      raw.exec('BEGIN');
      try {
        const out = [];
        for (const s of ss) out.push(await s.run());
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as D1Database;
}

const job = (id: string, createdAt: number, status: JobRecord['status'], nextAttemptAt?: number) =>
  ({ id, createdAt, status, nextAttemptAt, payments: [], feed: [], attempts: 1 }) as unknown as JobRecord;

describe.each([
  ['D1 (SQL on SQLite)', async () => new D1Store(await d1()) as Store],
  ['MemoryStore', async () => new MemoryStore() as Store],
])('activeJobIds on %s', (_name, make) => {
  it('lists running jobs and starting jobs that are due, oldest first; skips ones parked in backoff', async () => {
    const s = await make();
    const now = 1_800_000_000_000;
    const rows = [
      job('q_parked1', 1, 'starting', now + 60_000),
      job('q_fresh', 2, 'starting'), // never attempted: no nextAttemptAt
      job('q_parked2', 3, 'starting', now + 1),
      job('q_due', 4, 'starting', now),
      job('q_paused', 5, 'paused'),
      job('q_done', 6, 'done'),
      job('q_running', 7, 'running', now + 60_000), // a stale backoff on a running job doesn't matter
      job('q_running2', 8, 'running'),
    ];
    for (const r of rows) expect(await s.insertJob(r)).toBe(true);
    expect(await s.activeJobIds(8, now)).toEqual(['q_fresh', 'q_due', 'q_running', 'q_running2']);
    expect(await s.activeJobIds(2, now)).toEqual(['q_fresh', 'q_due']);
    expect(await s.activeJobIds(8, now + 60_000)).toEqual(['q_parked1', 'q_fresh', 'q_parked2', 'q_due', 'q_running', 'q_running2']);
  });
});
