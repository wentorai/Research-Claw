/**
 * Dual Model Supervisor — Audit Log Service (SQLite)
 */

import Database from 'better-sqlite3';
import type { AuditLogEntry, AuditLogType, PluginLogger } from './types.js';

/** Observable outcome of an audit write — a caller can tell whether it was persisted
 *  rather than assuming "zero loss". Audit persistence is best-effort: entries persist
 *  WHEN the DB is available, and any failure is observable (returned + logged). */
export type AuditPersistOutcome =
  | { ok: true }
  | { ok: false; reason: 'db_unavailable' }
  | { ok: false; reason: 'error'; message: string };

export class AuditLogService {
  private db: Database.Database | null;
  private logger: PluginLogger;
  private onPersisted?: (entry: Omit<AuditLogEntry, 'id'>) => void;
  /** Warn once when the DB goes unavailable, so persistence loss is observable
   *  without flooding the log on every subsequent audit write. */
  private _warnedDbUnavailable = false;

  /**
   * @param db   SQLite database instance (shared across plugin lifecycle). May be null if DB init failed — service degrades to log-only.
   * @param logger Plugin logger for error reporting
   */
  constructor(
    db: Database.Database | null,
    logger: PluginLogger,
    onPersisted?: (entry: Omit<AuditLogEntry, 'id'>) => void,
  ) {
    this.db = db;
    this.logger = logger;
    this.onPersisted = onPersisted;
    if (db) this._runMigrations();
  }

  /** Create the audit log table and indexes if they do not exist yet. */
  private _runMigrations(): void {
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS supervisor_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '',
        metadata TEXT,
        timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_audit_session ON supervisor_audit_log(sessionId);
      CREATE INDEX IF NOT EXISTS idx_audit_type ON supervisor_audit_log(type);
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON supervisor_audit_log(timestamp);
    `);
  }

  /**
   * Record an audit log entry.
   */
  private getDb(): Database.Database | null {
    if (!this.db?.open) return null;
    return this.db;
  }

  /**
   * Record an audit log entry. Returns an observable outcome so a caller can tell
   * whether it was persisted — persistence is best-effort ("persisted when the DB is
   * available; failure observable"), NOT a zero-loss guarantee. DB-unavailable and
   * write failures are surfaced (returned + logged), never silently dropped.
   */
  record(entry: Omit<AuditLogEntry, 'id'>): AuditPersistOutcome {
    const db = this.getDb();
    if (!db) {
      if (!this._warnedDbUnavailable) {
        this.logger.warn('[AuditLog] audit persistence unavailable (DB not open) — entries are NOT being persisted');
        this._warnedDbUnavailable = true;
      }
      return { ok: false, reason: 'db_unavailable' };
    }
    this._warnedDbUnavailable = false;
    try {
      db.prepare(
        `INSERT INTO supervisor_audit_log (sessionId, type, action, details, metadata, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        entry.sessionId,
        entry.type,
        entry.action,
        entry.details,
        entry.metadata ?? null,
        entry.timestamp,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Audit log write failed: ${message}`);
      return { ok: false, reason: 'error', message };
    }
    try {
      this.onPersisted?.(entry);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Audit log notification failed: ${message}`);
    }
    return { ok: true };
  }

  /**
   * Query audit log entries.
   */
  list(params: {
    limit?: number;
    offset?: number;
    sessionId?: string;
    type?: AuditLogType;
    action?: string;
  }): AuditLogEntry[] {
    const db = this.getDb();
    if (!db) return [];

    const limit = Math.min(params.limit ?? 50, 200);
    const offset = params.offset ?? 0;

    const conditions: string[] = [];
    const values: unknown[] = [];

    if (params.sessionId) {
      conditions.push('sessionId = ?');
      values.push(params.sessionId);
    }
    if (params.type) {
      conditions.push('type = ?');
      values.push(params.type);
    }
    if (params.action) {
      conditions.push('action = ?');
      values.push(params.action);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const query = `SELECT * FROM supervisor_audit_log ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`;

    return db.prepare(query).all(...values, limit, offset) as AuditLogEntry[];
  }

  /**
   * Count entries matching the same filters as list(). Pagination is deliberately
   * excluded: callers use this as the complete result count, not the current page size.
   */
  count(params: {
    sessionId?: string;
    type?: AuditLogType;
    action?: string;
  } = {}): number {
    const db = this.getDb();
    if (!db) return 0;

    const conditions: string[] = [];
    const values: unknown[] = [];
    if (params.sessionId) {
      conditions.push('sessionId = ?');
      values.push(params.sessionId);
    }
    if (params.type) {
      conditions.push('type = ?');
      values.push(params.type);
    }
    if (params.action) {
      conditions.push('action = ?');
      values.push(params.action);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = db
      .prepare(`SELECT COUNT(*) as count FROM supervisor_audit_log ${where}`)
      .get(...values) as { count: number };
    return result.count;
  }

  /** Delete every locally persisted audit entry. This is intentionally separate
   * from purge(), because its RPC caller requires an explicit `scope: "all"` guard. */
  clear(): number {
    const db = this.getDb();
    if (!db) return 0;
    return db.prepare('DELETE FROM supervisor_audit_log').run().changes;
  }

  /**
   * Get audit statistics, computed from database for accuracy after restart.
   */
  getStats(): { total: number; blocked: number; corrected: number; warnings: number } {
    const db = this.getDb();
    if (!db) return { total: 0, blocked: 0, corrected: 0, warnings: 0 };
    const totalResult = db.prepare('SELECT COUNT(*) as count FROM supervisor_audit_log').get() as { count: number };
    const blockedResult = db.prepare("SELECT COUNT(*) as count FROM supervisor_audit_log WHERE action = 'block'").get() as { count: number };
    const correctedResult = db.prepare("SELECT COUNT(*) as count FROM supervisor_audit_log WHERE action = 'correct'").get() as { count: number };
    const warningsResult = db.prepare("SELECT COUNT(*) as count FROM supervisor_audit_log WHERE action = 'warn'").get() as { count: number };

    return {
      total: totalResult.count,
      blocked: blockedResult.count,
      corrected: correctedResult.count,
      warnings: warningsResult.count,
    };
  }

  /**
   * Purge old entries (older than maxAgeMs).
   */
  purge(maxAgeMs: number): number {
    const db = this.getDb();
    if (!db) return 0;
    const cutoff = Date.now() - maxAgeMs;
    const result = db.prepare(
      `DELETE FROM supervisor_audit_log WHERE timestamp < ?`,
    ).run(cutoff);
    return result.changes;
  }
}
