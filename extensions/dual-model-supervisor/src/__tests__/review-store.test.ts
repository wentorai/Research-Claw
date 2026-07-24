/**
 * M6 — persisted review lifecycle (ReviewStore) protocol.
 *
 * Truth source is the DB (not broadcast): reviews are persisted and recoverable
 * via list/get regardless of any notification channel. Monotonic state machine:
 * started → one terminal; duplicates/out-of-order merge safely.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReviewStore, aggregateReview, REVIEW_SCHEMA_VERSION, type ReviewFinding } from '../core/review-store.js';

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
});
