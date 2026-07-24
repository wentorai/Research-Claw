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
export const REVIEW_SCHEMA_VERSION = 1;

export type ReviewState = 'started' | 'completed' | 'degraded' | 'failed';
const TERMINAL: ReadonlySet<ReviewState> = new Set(['completed', 'degraded', 'failed']);
export function isTerminalReviewState(s: ReviewState): boolean {
  return TERMINAL.has(s);
}

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
    if (db) this.migrate();
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
      CREATE INDEX IF NOT EXISTS idx_reviews_session ON supervisor_reviews(sessionKey);
      CREATE INDEX IF NOT EXISTS idx_reviews_run ON supervisor_reviews(runId);
      CREATE INDEX IF NOT EXISTS idx_reviews_updated ON supervisor_reviews(updatedAt);
    `);
  }

  private getDb(): Database.Database | null {
    return this.db?.open ? this.db : null;
  }

  /** Persist that a review has STARTED. No-op if the review already exists
   *  (idempotent; never downgrades an already-terminal review). */
  begin(reviewId: string, meta: { sessionKey: string; runId?: string | null; kind: 'auto' | 'manual' }, now: number): void {
    const db = this.getDb();
    if (!db) return;
    try {
      const existing = db.prepare('SELECT state FROM supervisor_reviews WHERE reviewId = ?').get(reviewId) as { state: string } | undefined;
      if (existing) return; // already started or already terminal → do not overwrite
      db.prepare(
        `INSERT INTO supervisor_reviews (reviewId, schemaVersion, sessionKey, runId, kind, state, verdict, findings, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, 'started', 'none', '[]', ?, ?)`,
      ).run(reviewId, REVIEW_SCHEMA_VERSION, meta.sessionKey, meta.runId ?? null, meta.kind, now, now);
    } catch (err) {
      this.logger.error(`[ReviewStore] begin failed: ${err instanceof Error ? err.message : String(err)}`);
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
  ): void {
    const db = this.getDb();
    if (!db) return;
    try {
      const existing = db.prepare('SELECT state FROM supervisor_reviews WHERE reviewId = ?').get(reviewId) as { state: string } | undefined;
      const findingsJson = JSON.stringify(data.findings);
      if (!existing) {
        db.prepare(
          `INSERT INTO supervisor_reviews (reviewId, schemaVersion, sessionKey, runId, kind, state, verdict, findings, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(reviewId, REVIEW_SCHEMA_VERSION, data.sessionKey, data.runId ?? null, data.kind, state, data.verdict, findingsJson, now, now);
        return;
      }
      if (isTerminalReviewState(existing.state as ReviewState)) return; // first terminal wins — idempotent
      db.prepare('UPDATE supervisor_reviews SET state = ?, verdict = ?, findings = ?, updatedAt = ? WHERE reviewId = ?')
        .run(state, data.verdict, findingsJson, now, reviewId);
    } catch (err) {
      this.logger.error(`[ReviewStore] finalize failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  get(reviewId: string): ReviewRecord | null {
    const db = this.getDb();
    if (!db) return null;
    const row = db.prepare('SELECT * FROM supervisor_reviews WHERE reviewId = ?').get(reviewId) as Row | undefined;
    return row ? this.toRecord(row) : null;
  }

  /** List reviews (snapshot / replay). Filter by session or run; paginated;
   *  ordered by updatedAt DESC. `sinceUpdatedAt` supports incremental replay. */
  list(params: { sessionKey?: string; runId?: string; sinceUpdatedAt?: number; limit?: number; offset?: number }): { reviews: ReviewRecord[]; total: number } {
    const db = this.getDb();
    if (!db) return { reviews: [], total: 0 };
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (params.sessionKey) { conditions.push('sessionKey = ?'); values.push(params.sessionKey); }
    if (params.runId) { conditions.push('runId = ?'); values.push(params.runId); }
    if (typeof params.sinceUpdatedAt === 'number') { conditions.push('updatedAt > ?'); values.push(params.sinceUpdatedAt); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) as n FROM supervisor_reviews ${where}`).get(...values) as { n: number }).n;
    const limit = Math.min(params.limit ?? 50, 200);
    const offset = params.offset ?? 0;
    const rows = db.prepare(`SELECT * FROM supervisor_reviews ${where} ORDER BY updatedAt DESC LIMIT ? OFFSET ?`).all(...values, limit, offset) as Row[];
    return { reviews: rows.map((r) => this.toRecord(r)), total };
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
