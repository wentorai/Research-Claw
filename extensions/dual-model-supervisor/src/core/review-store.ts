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
export const REVIEW_SCHEMA_VERSION = 3;

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

/** Replay cursor = a DB-monotonic `revision` (bumped on EVERY write, incl. an in-place
 *  started→terminal update). A wall-clock ms timestamp + business id cannot serve as a
 *  change sequence: it misses same-ms inserts AND in-place state changes (the row's key
 *  does not advance). `revision` strictly increases per write, so replay never misses a
 *  change. `nextCursor` is the max revision returned — feed it back verbatim. */
export type ReviewCursor = number;

export interface ReviewFinding {
  raw: string;
  verdict: string;
  via?: string;
  sources?: Record<string, string>;
  /** Normalized identity (no response body) — persisted so a finding is always complete. */
  identity?: { doi?: string; arxivId?: string; normTitle?: string };
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
  revision: number; // DB-monotonic change sequence (for replay cursors)
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
  revision: number;
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
    const db = this.db!;
    db.exec(`
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
        updatedAt INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS supervisor_review_meta (
        k TEXT PRIMARY KEY,
        v INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reviews_session ON supervisor_reviews(sessionKey);
      CREATE INDEX IF NOT EXISTS idx_reviews_run ON supervisor_reviews(runId);
      CREATE INDEX IF NOT EXISTS idx_reviews_updated ON supervisor_reviews(updatedAt);
    `);
    // In-place upgrade for a pre-v3 table: add the monotonic revision column.
    const cols = db.prepare('PRAGMA table_info(supervisor_reviews)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'revision')) {
      db.exec('ALTER TABLE supervisor_reviews ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_reviews_revision ON supervisor_reviews(revision)');
  }

  /**
   * Allocate the next DB-monotonic revision. Bumped on EVERY write so a replay cursor
   * over `revision` never misses a change — including an in-place started→terminal
   * update (whose reviewId/updatedAt would not advance) or a same-millisecond insert.
   *
   * MUST be called inside the SAME `BEGIN IMMEDIATE` transaction as the row write it
   * stamps. Allocating in a separate autocommit statement makes revision order differ
   * from COMMIT order: another connection can allocate a higher revision and commit
   * first, a reader can advance its cursor past it, and the lower-revision row then
   * commits permanently below the cursor — silently unreplayable forever.
   */
  private nextRevision(db: Database.Database): number {
    const row = db
      .prepare("INSERT INTO supervisor_review_meta (k, v) VALUES ('revision_seq', 1) ON CONFLICT(k) DO UPDATE SET v = v + 1 RETURNING v")
      .get() as { v: number };
    return row.v;
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
      const tx = db.transaction(() => {
        // Row-by-row so each swept review gets a DISTINCT monotonic revision (a shared
        // revision could be split across replay pages and lose rows past the cursor).
        const orphans = db.prepare("SELECT reviewId FROM supervisor_reviews WHERE state = 'started' AND updatedAt <= ?").all(cutoff) as Array<{ reviewId: string }>;
        // `AND state = 'started'` — never clobber a terminal that landed concurrently.
        const upd = db.prepare("UPDATE supervisor_reviews SET state = 'timedout', verdict = 'unverifiable', updatedAt = ?, revision = ? WHERE reviewId = ? AND state = 'started'");
        let swept = 0;
        for (const o of orphans) swept += upd.run(now, this.nextRevision(db), o.reviewId).changes;
        return swept;
      });
      return tx.immediate();
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
      // INSERT OR IGNORE: creating the row is a single atomic statement, so an existing
      // row (already started OR already terminal) is never overwritten — no read-then-write
      // window. Runs in the same IMMEDIATE transaction that allocates the revision.
      const tx = db.transaction(() => {
        db.prepare(
          `INSERT OR IGNORE INTO supervisor_reviews (reviewId, schemaVersion, sessionKey, runId, kind, state, verdict, findings, createdAt, updatedAt, revision)
           VALUES (?, ?, ?, ?, ?, 'started', 'none', '[]', ?, ?, ?)`,
        ).run(reviewId, REVIEW_SCHEMA_VERSION, meta.sessionKey, meta.runId ?? null, meta.kind, now, now, this.nextRevision(db));
      });
      tx.immediate();
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
      const findingsJson = JSON.stringify(data.findings);
      // Two atomic conditional statements — no read-then-write window. A SELECT-then-UPDATE
      // lets two connections both observe 'started' and both write a terminal (last writer
      // wins, so the FIRST terminal is silently lost).
      const tx = db.transaction(() => {
        const rev = this.nextRevision(db);
        // Only a live 'started' row may transition. changes === 0 ⇒ the row is missing OR
        // a terminal already won.
        const upd = db.prepare(
          `UPDATE supervisor_reviews SET state = ?, verdict = ?, findings = ?, updatedAt = ?, revision = ?
           WHERE reviewId = ? AND state = 'started'`,
        ).run(state, data.verdict, findingsJson, now, rev, reviewId);
        if (upd.changes > 0) return;
        // Missing row ⇒ terminal-before-started, create it directly in the terminal state.
        // Already terminal ⇒ OR IGNORE makes this a no-op: first terminal wins.
        db.prepare(
          `INSERT OR IGNORE INTO supervisor_reviews (reviewId, schemaVersion, sessionKey, runId, kind, state, verdict, findings, createdAt, updatedAt, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(reviewId, REVIEW_SCHEMA_VERSION, data.sessionKey, data.runId ?? null, data.kind, state, data.verdict, findingsJson, now, now, rev);
      });
      tx.immediate();
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
   *  - Snapshot (no `sinceRevision`): latest-first (updatedAt DESC, reviewId DESC).
   *  - Replay (`sinceRevision`): walks FORWARD by the DB-monotonic `revision`
   *    (`revision > ?`, ORDER BY revision ASC). Because revision is bumped on EVERY
   *    write — incl. an in-place started→terminal update — replay never misses a
   *    change or a same-ms insert. `nextCursor` is the max revision returned; feed it
   *    back verbatim as `sinceRevision`.
   */
  list(params: { sessionKey?: string; runId?: string; sinceRevision?: ReviewCursor; limit?: number; offset?: number }): { reviews: ReviewRecord[]; total: number; nextCursor?: ReviewCursor } {
    const db = this.getDb();
    if (!db) return { reviews: [], total: 0 };
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (params.sessionKey) { conditions.push('sessionKey = ?'); values.push(params.sessionKey); }
    if (params.runId) { conditions.push('runId = ?'); values.push(params.runId); }
    const replay = typeof params.sinceRevision === 'number';
    if (replay) {
      conditions.push('revision > ?');
      values.push(params.sinceRevision);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) as n FROM supervisor_reviews ${where}`).get(...values) as { n: number }).n;
    const limit = Math.min(params.limit ?? 50, 200);
    const offset = params.offset ?? 0;
    const order = replay ? 'revision ASC' : 'updatedAt DESC, reviewId DESC';
    const rows = db.prepare(`SELECT * FROM supervisor_reviews ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...values, limit, offset) as Row[];
    const reviews = rows.map((r) => this.toRecord(r));
    if (replay && rows.length) {
      const nextCursor = Math.max(...rows.map((r) => r.revision));
      return { reviews, total, nextCursor };
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
      revision: row.revision,
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
