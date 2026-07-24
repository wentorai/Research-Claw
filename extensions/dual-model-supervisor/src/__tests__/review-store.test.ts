/**
 * M6 — persisted review lifecycle (ReviewStore) protocol.
 *
 * Truth source is the DB (not broadcast): reviews are persisted and recoverable
 * via list/get regardless of any notification channel. Monotonic state machine:
 * started → one terminal; duplicates/out-of-order merge safely.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReviewStore, aggregateReview, REVIEW_SCHEMA_VERSION, isTerminalReviewState, type ReviewFinding } from '../core/review-store.js';

const LOGGER = { info() {}, warn() {}, error() {} };
let db: Database.Database;
let store: ReviewStore;

beforeEach(() => {
  db = new Database(':memory:');
  store = new ReviewStore(db, LOGGER);
});
afterEach(() => db.close());

const F = (raw: string, verdict: string, sources?: Record<string, string>): ReviewFinding => ({ raw, verdict, via: 'openalex_doi', sources });

describe('M6 review lifecycle state machine', () => {
  it('persists started, then a single completed terminal (recoverable via get)', () => {
    store.begin('auto:run-1', { sessionKey: 'skA', runId: 'run-1', kind: 'auto' }, 1000);
    expect(store.get('auto:run-1')!.state).toBe('started');
    expect(store.get('auto:run-1')!.schemaVersion).toBe(REVIEW_SCHEMA_VERSION);

    const findings = [F('10.1/x', 'exists', { openalex_doi: 'hit' })];
    const agg = aggregateReview(findings);
    store.finalize('auto:run-1', agg.state, { sessionKey: 'skA', runId: 'run-1', kind: 'auto', verdict: agg.verdict, findings }, 2000);
    const r = store.get('auto:run-1')!;
    expect(r.state).toBe('completed');
    expect(r.verdict).toBe('exists');
    expect(r.findings[0].sources).toEqual({ openalex_doi: 'hit' }); // findings completeness
  });

  it('all-unverifiable findings → degraded terminal (observable failure)', () => {
    store.begin('auto:run-2', { sessionKey: 'skA', runId: 'run-2', kind: 'auto' }, 1000);
    const findings = [F('10.9/x', 'unverifiable'), F('10.9/y', 'unverifiable')];
    const agg = aggregateReview(findings);
    store.finalize('auto:run-2', agg.state, { sessionKey: 'skA', runId: 'run-2', kind: 'auto', verdict: agg.verdict, findings }, 2000);
    expect(store.get('auto:run-2')!.state).toBe('degraded');
  });

  it('duplicate terminal is idempotent — the first terminal wins', () => {
    store.begin('r', { sessionKey: 'skA', kind: 'auto' }, 1);
    store.finalize('r', 'completed', { sessionKey: 'skA', kind: 'auto', verdict: 'exists', findings: [F('a', 'exists')] }, 2);
    store.finalize('r', 'failed', { sessionKey: 'skA', kind: 'auto', verdict: 'none', findings: [] }, 3); // late/duplicate
    const rec = store.get('r')!;
    expect(rec.state).toBe('completed');
    expect(rec.verdict).toBe('exists');
  });

  it('a late `started` never downgrades an already-terminal review (out-of-order)', () => {
    store.finalize('r', 'completed', { sessionKey: 'skA', kind: 'auto', verdict: 'exists', findings: [] }, 5); // terminal before started
    store.begin('r', { sessionKey: 'skA', kind: 'auto' }, 6); // late started
    expect(store.get('r')!.state).toBe('completed');
  });

  it('terminal-before-started creates the record directly in the terminal state', () => {
    store.finalize('r2', 'completed', { sessionKey: 'skA', kind: 'auto', verdict: 'exists', findings: [] }, 5);
    expect(store.get('r2')!.state).toBe('completed');
  });
});

describe('M6 review persistence / replay (no broadcast involved)', () => {
  it('lists by sessionKey and by runId, isolating concurrent turns in one session', () => {
    store.begin('auto:runA', { sessionKey: 'sk1', runId: 'runA', kind: 'auto' }, 10);
    store.begin('auto:runB', { sessionKey: 'sk1', runId: 'runB', kind: 'auto' }, 20);
    store.begin('auto:runC', { sessionKey: 'sk2', runId: 'runC', kind: 'auto' }, 30);
    expect(store.list({ sessionKey: 'sk1' }).total).toBe(2);
    expect(store.list({ runId: 'runB' }).reviews.map((r) => r.reviewId)).toEqual(['auto:runB']);
  });

  it('supports incremental replay via sinceUpdatedAt (dedup on reconnect)', () => {
    store.finalize('a', 'completed', { sessionKey: 'sk', kind: 'auto', verdict: 'exists', findings: [] }, 100);
    store.finalize('b', 'completed', { sessionKey: 'sk', kind: 'auto', verdict: 'exists', findings: [] }, 200);
    const since = store.list({ sessionKey: 'sk', sinceUpdatedAt: 150 });
    expect(since.reviews.map((r) => r.reviewId)).toEqual(['b']); // only newer than the cursor
  });

  it('paginates', () => {
    for (let i = 0; i < 5; i++) store.finalize(`r${i}`, 'completed', { sessionKey: 'sk', kind: 'auto', verdict: 'exists', findings: [] }, 100 + i);
    const page = store.list({ sessionKey: 'sk', limit: 2, offset: 0 });
    expect(page.total).toBe(5);
    expect(page.reviews.length).toBe(2);
  });

  // H4-d: composite (updatedAt, reviewId) cursor — same-millisecond records are never skipped.
  it('same-millisecond records are NOT skipped on replay (composite cursor)', () => {
    store.finalize('a', 'completed', { sessionKey: 'sk', kind: 'auto', verdict: 'exists', findings: [] }, 200);
    store.finalize('b', 'completed', { sessionKey: 'sk', kind: 'auto', verdict: 'exists', findings: [] }, 200); // SAME ms
    const p1 = store.list({ sessionKey: 'sk', since: { updatedAt: 0, reviewId: '' }, limit: 1 });
    expect(p1.reviews.map((r) => r.reviewId)).toEqual(['a']);
    const p2 = store.list({ sessionKey: 'sk', since: p1.nextCursor, limit: 1 });
    expect(p2.reviews.map((r) => r.reviewId)).toEqual(['b']); // co-ms record reachable, not skipped
    const p3 = store.list({ sessionKey: 'sk', since: p2.nextCursor, limit: 1 });
    expect(p3.reviews).toEqual([]); // clean end, no infinite loop
  });
});

describe('M6 (reopened) restart identity, orphan recovery, DB availability', () => {
  // H4-a: boot epoch is PERSISTED, so a per-process counter can't collide across restarts.
  it('allocateBootEpoch is persisted + monotonic across store re-instantiation on the same DB', () => {
    const db2 = new Database(':memory:');
    const e1 = new ReviewStore(db2, LOGGER).allocateBootEpoch();
    const e2 = new ReviewStore(db2, LOGGER).allocateBootEpoch(); // simulate restart on the SAME db
    expect(e2).toBe(e1 + 1); // proves DB persistence, not an in-memory counter
    db2.close();
  });

  // H4-b: orphan 'started' recovery.
  it('sweepOrphans transitions crash-orphaned started → timedout and never touches a terminal', () => {
    store.begin('auto:orphan', { sessionKey: 'sk', runId: 'r', kind: 'auto' }, 1000); // never finalized (crash)
    store.finalize('done', 'completed', { sessionKey: 'sk', kind: 'auto', verdict: 'exists', findings: [] }, 1000);
    expect(store.sweepOrphans(5000)).toBe(1);
    expect(store.get('auto:orphan')!.state).toBe('timedout');
    expect(isTerminalReviewState('timedout')).toBe(true);
    expect(store.get('done')!.state).toBe('completed'); // terminal untouched
  });

  it('sweepOrphans respects olderThanMs deterministically (injected now, no real timer)', () => {
    store.begin('r', { sessionKey: 'sk', kind: 'auto' }, 1000);
    expect(store.sweepOrphans(1000 + 25_000, { olderThanMs: 30_000 })).toBe(0); // not yet expired
    expect(store.get('r')!.state).toBe('started');
    expect(store.sweepOrphans(1000 + 40_000, { olderThanMs: 30_000 })).toBe(1); // expired
    expect(store.get('r')!.state).toBe('timedout');
  });

  it('a swept timedout review is terminal — a late begin cannot resurrect it', () => {
    store.begin('r', { sessionKey: 'sk', kind: 'auto' }, 1000);
    store.sweepOrphans(5000);
    store.begin('r', { sessionKey: 'sk', kind: 'auto' }, 6000); // late begin
    expect(store.get('r')!.state).toBe('timedout');
  });

  // H4-e: DB-unavailable is observable, not a silent no-op.
  it('begin/finalize report db_unavailable and isAvailable=false with no DB', () => {
    const s = new ReviewStore(null, LOGGER);
    expect(s.isAvailable()).toBe(false);
    expect(s.begin('r', { sessionKey: 'r', kind: 'manual' }, 1)).toEqual({ ok: false, reason: 'db_unavailable' });
    expect(s.finalize('r', 'completed', { sessionKey: 'r', kind: 'manual', verdict: 'none', findings: [] }, 2)).toEqual({ ok: false, reason: 'db_unavailable' });
  });

  it('begin/finalize report ok with a real DB', () => {
    expect(store.begin('r', { sessionKey: 'sk', kind: 'auto' }, 1).ok).toBe(true);
    expect(store.finalize('r', 'completed', { sessionKey: 'sk', kind: 'auto', verdict: 'exists', findings: [] }, 2).ok).toBe(true);
    expect(store.isAvailable()).toBe(true);
  });
});
