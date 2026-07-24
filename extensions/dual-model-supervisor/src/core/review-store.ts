/**
 * Dual Model Supervisor — Review Store (persisted review lifecycle).
 *
 * The truth source for supervisor reviews is the DATABASE, not the broadcast:
 * a review is persisted the moment it starts and updated to a terminal state on
 * completion, so a dashboard that was offline / connected late can recover the
 * full state via RPC (list/get) — broadcast is only a best-effort notification.
 *
 * Lifecycle is a monotonic state machine:
 *     started  →  completed | degraded | failed   (exactly one terminal)
 * Out-of-order and duplicate transitions are merged safely:
 *  - a terminal is written at most once (first terminal wins; duplicates no-op);
 *  - a late `started` never downgrades an already-terminal review;
 *  - a terminal arriving before its `started` simply creates the record terminal.
 *
 * Identity: `reviewId` is stable per review. Automatic reviews are keyed by the
 * per-turn `runId` (so concurrent turns in one session stay distinct); manual
 * reviews carry their own id. `runId` is NOT taken from message_sending (OC does
 * not plumb it there).
 */

import Database from 'better-sqlite3';
import type { PluginLogger } from './types.js';

/** Bump when the persisted shape or aggregation rules change. */
export const REVIEW_SCHEMA_VERSION = 2;

// 'timedout' is a terminal DISTINCT from 'failed': failed = the check ran and threw;
// timedout = the process died / never completed (orphan 'started' recovered on boot).
export type ReviewState = 'started' | 'completed' | 'degraded' | 'failed' | 'timedout';
const TERMINAL: ReadonlySet<ReviewState> = new Set(['completed', 'degraded', 'failed', 'timedout']);
export function isTerminalReviewState(s: ReviewState): boolean {
  return TERMINAL.has(s);
}

/** Outcome of a persistence attempt — lets callers detect DB-unavailable rather
 *  than silently no-op'ing (which made a manual review falsely report ok). */
export type PersistOutcome =
  | { ok: true }
  | { ok: false; reason: 'db_unavailable' }
  | { ok: false; reason: 'error'; message: string };

/** A composite replay cursor: strictly greater than (updatedAt, reviewId) is a TOTAL
 *  order, so two records sharing a millisecond are never skipped on incremental replay. */
export interface ReviewCursor { updatedAt: number; reviewId: string }

export interface ReviewFinding {
  raw: string;
  verdict: string;
  via?: string;
  sources?: Record<string, string>;
}

export interface ReviewRecord {
  reviewId: string;
  schemaVersion: number;
  sessionKey: string;
  runId: string | null;
  kind: 'auto' | 'manual';
  state: ReviewState;
  verdict: string; // aggregate (exists|not_found|unverifiable|none)
  findings: ReviewFinding[];
  createdAt: number;
  updatedAt: number;
}

interface Row {
  reviewId: string;
  schemaVersion: number;
  sessionKey: string;
  runId: string | null;
  kind: string;
  state: string;
  verdict: string;
  findings: string;
  createdAt: number;
  updatedAt: number;
}

export class ReviewStore {
  private db: Database.Database | null;
  private logger: PluginLogger;

  constructor(db: Database.Database | null, logger: PluginLogger) {
    this.db = db;
    this.logger = logger;
    if (db) {
      // Retry (don't immediately fail) if another connection holds a write lock —
      // makes the boot-epoch allocation robust if two processes ever share the DB.
      try { db.pragma('busy_timeout = 5000'); } catch { /* best-effort */ }
      this.migrate();
    }
  }

  private migrate(): void {
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS supervisor_reviews (
        reviewId TEXT PRIMARY KEY,
        schemaVersion INTEGER NOT NULL,
        sessionKey TEXT NOT NULL DEFAULT '',
        runId TEXT,
        kind TEXT NOT NULL DEFAULT 'auto',
        state TEXT NOT NULL,
        verdict TEXT NOT NULL DEFAULT 'none',
        findings TEXT NOT NULL DEFAULT '[]',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS supervisor_review_meta (
        k TEXT PRIMARY KEY,
        v INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reviews_session ON supervisor_reviews(sessionKey);
      CREATE INDEX IF NOT EXISTS idx_reviews_run ON supervisor_reviews(runId);
      CREATE INDEX IF NOT EXISTS idx_reviews_updated ON supervisor_reviews(updatedAt);
      CREATE INDEX IF NOT EXISTS idx_reviews_cursor ON supervisor_reviews(updatedAt, reviewId);
    `);
  }

  private getDb(): Database.Database | null {
    return this.db?.open ? this.db : null;
  }

  /** True when a real, open DB backs this store (persistence + recovery available). */
  isAvailable(): boolean {
    return this.getDb() !== null;
  }

  /**
   * Allocate a process-global, restart-monotonic epoch. Persisted (read-modify-write)
   * so it survives restarts: each process start bumps it. Used to namespace reviewIds
   * so a per-process counter (manual-N) can never collide across restarts. Returns 0
   * when there is no DB (caller must add its own uniqueness salt in that case).
   */
  allocateBootEpoch(): number {
    const db = this.getDb();
    if (!db) return 0;
    try {
      const tx = db.transaction(() => {
        const row = db.prepare("SELECT v FROM supervisor_review_meta WHERE k = 'boot_epoch'").get() as { v: number } | undefined;
        const next = (row?.v ?? 0) + 1;
        db.prepare("INSERT INTO supervisor_review_meta (k, v) VALUES ('boot_epoch', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(next);
        return next;
      });
      // BEGIN IMMEDIATE: take the write lock upfront so a concurrent process cannot
      // read the same v and produce a duplicate epoch (deferred would deadlock/BUSY).
      return tx.immediate();
    } catch (err) {
      this.logger.error(`[ReviewStore] allocateBootEpoch failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  /**
   * Recover orphaned 'started' reviews (a crash between begin and finalize). Transitions
   * every 'started' whose updatedAt <= now - olderThanMs to the 'timedout' terminal, so a
   * review never hangs in 'started' forever. Deterministic: caller injects `now`. Returns
   * the number swept.
   */
  sweepOrphans(now: number, opts?: { olderThanMs?: number }): number {
    const db = this.getDb();
    if (!db) return 0;
    try {
      const cutoff = now - (opts?.olderThanMs ?? 0);
      const res = db
        .prepare("UPDATE supervisor_reviews SET state = 'timedout', verdict = 'unverifiable', updatedAt = ? WHERE state = 'started' AND updatedAt <= ?")
        .run(now, cutoff);
      return res.changes;
    } catch (err) {
      this.logger.error(`[ReviewStore] sweepOrphans failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  /** Persist that a review has STARTED. No-op if the review already exists
   *  (idempotent; never downgrades an already-terminal review). */
  begin(reviewId: string, meta: { sessionKey: string; runId?: string | null; kind: 'auto' | 'manual' }, now: number): PersistOutcome {
    const db = this.getDb();
    if (!db) return { ok: false, reason: 'db_unavailable' };
    try {
      const existing = db.prepare('SELECT state FROM supervisor_reviews WHERE reviewId = ?').get(reviewId) as { state: string } | undefined;
      if (existing) return { ok: true }; // already started or already terminal → do not overwrite
      db.prepare(
        `INSERT INTO supervisor_reviews (reviewId, schemaVersion, sessionKey, runId, kind, state, verdict, findings, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, 'started', 'none', '[]', ?, ?)`,
      ).run(reviewId, REVIEW_SCHEMA_VERSION, meta.sessionKey, meta.runId ?? null, meta.kind, now, now);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[ReviewStore] begin failed: ${message}`);
      return { ok: false, reason: 'error', message };
    }
  }

  /** Persist a TERMINAL transition. First terminal wins; duplicate/late terminals
   *  are ignored. If the review does not exist yet (terminal-before-started), it
   *  is created directly in the terminal state. */
  finalize(
    reviewId: string,
    state: Exclude<ReviewState, 'started'>,
    data: { sessionKey: string; runId?: string | null; kind: 'auto' | 'manual'; verdict: string; findings: ReviewFinding[] },
    now: number,
  ): PersistOutcome {
    const db = this.getDb();
    if (!db) return { ok: false, reason: 'db_unavailable' };
    try {
      const existing = db.prepare('SELECT state FROM supervisor_reviews WHERE reviewId = ?').get(reviewId) as { state: string } | undefined;
      const findingsJson = JSON.stringify(data.findings);
      if (!existing) {
        db.prepare(
          `INSERT INTO supervisor_reviews (reviewId, schemaVersion, sessionKey, runId, kind, state, verdict, findings, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(reviewId, REVIEW_SCHEMA_VERSION, data.sessionKey, data.runId ?? null, data.kind, state, data.verdict, findingsJson, now, now);
        return { ok: true };
      }
      if (isTerminalReviewState(existing.state as ReviewState)) return { ok: true }; // first terminal wins — idempotent
      db.prepare('UPDATE supervisor_reviews SET state = ?, verdict = ?, findings = ?, updatedAt = ? WHERE reviewId = ?')
        .run(state, data.verdict, findingsJson, now, reviewId);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[ReviewStore] finalize failed: ${message}`);
      return { ok: false, reason: 'error', message };
    }
  }

  get(reviewId: string): ReviewRecord | null {
    const db = this.getDb();
    if (!db) return null;
    const row = db.prepare('SELECT * FROM supervisor_reviews WHERE reviewId = ?').get(reviewId) as Row | undefined;
    return row ? this.toRecord(row) : null;
  }

  /**
   * List reviews (snapshot / replay). Filter by session or run; paginated.
   *  - Snapshot (no `since`): latest-first (updatedAt DESC, reviewId DESC).
   *  - Replay (`since` composite cursor): walks FORWARD by the total order
   *    (updatedAt, reviewId), so two records sharing a millisecond are never
   *    skipped; `nextCursor` is the last row's cursor — feed it back verbatim.
   *  - `sinceUpdatedAt` (legacy, strict `> ms`) is kept for back-compat.
   */
  list(params: { sessionKey?: string; runId?: string; since?: ReviewCursor; sinceUpdatedAt?: number; limit?: number; offset?: number }): { reviews: ReviewRecord[]; total: number; nextCursor?: ReviewCursor } {
    const db = this.getDb();
    if (!db) return { reviews: [], total: 0 };
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (params.sessionKey) { conditions.push('sessionKey = ?'); values.push(params.sessionKey); }
    if (params.runId) { conditions.push('runId = ?'); values.push(params.runId); }
    const replay = !!params.since;
    if (params.since) {
      conditions.push('(updatedAt > ? OR (updatedAt = ? AND reviewId > ?))');
      values.push(params.since.updatedAt, params.since.updatedAt, params.since.reviewId);
    } else if (typeof params.sinceUpdatedAt === 'number') {
      conditions.push('updatedAt > ?');
      values.push(params.sinceUpdatedAt);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) as n FROM supervisor_reviews ${where}`).get(...values) as { n: number }).n;
    const limit = Math.min(params.limit ?? 50, 200);
    const offset = params.offset ?? 0;
    const order = replay ? 'updatedAt ASC, reviewId ASC' : 'updatedAt DESC, reviewId DESC';
    const rows = db.prepare(`SELECT * FROM supervisor_reviews ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...values, limit, offset) as Row[];
    const reviews = rows.map((r) => this.toRecord(r));
    if (replay && reviews.length) {
      const last = reviews[reviews.length - 1];
      return { reviews, total, nextCursor: { updatedAt: last.updatedAt, reviewId: last.reviewId } };
    }
    return { reviews, total };
  }

  private toRecord(row: Row): ReviewRecord {
    let findings: ReviewFinding[] = [];
    try { findings = JSON.parse(row.findings); } catch { /* keep [] */ }
    return {
      reviewId: row.reviewId,
      schemaVersion: row.schemaVersion,
      sessionKey: row.sessionKey,
      runId: row.runId,
      kind: row.kind as 'auto' | 'manual',
      state: row.state as ReviewState,
      verdict: row.verdict,
      findings,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

/** Aggregate a grounding finding set into a review verdict + terminal state. */
export function aggregateReview(findings: ReviewFinding[]): { verdict: string; state: Exclude<ReviewState, 'started'> } {
  if (!findings.length) return { verdict: 'none', state: 'completed' };
  if (findings.some((f) => f.verdict === 'not_found')) return { verdict: 'not_found', state: 'completed' };
  if (findings.every((f) => f.verdict === 'unverifiable')) return { verdict: 'unverifiable', state: 'degraded' };
  return { verdict: 'exists', state: 'completed' };
}
