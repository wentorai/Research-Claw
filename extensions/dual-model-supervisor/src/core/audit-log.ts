/**
 * Dual Model Supervisor — Audit Log Service (SQLite)
 */

import Database from 'better-sqlite3';
import type { AuditLogEntry, AuditLogType, PluginLogger } from './types.js';

export class AuditLogService {
  private db: Database.Database | null;
  private logger: PluginLogger;

  /**
   * @param db   SQLite database instance (shared across plugin lifecycle). May be null if DB init failed — service degrades to log-only.
   * @param logger Plugin logger for error reporting
   */
  constructor(db: Database.Database | null, logger: PluginLogger) {
    this.db = db;
    this.logger = logger;
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
  record(entry: Omit<AuditLogEntry, 'id'>): void {
    if (!this.db) return;
    try {
      this.db.prepare(
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
      this.logger.error(`Audit log write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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

    if (!this.db) return [];
    return this.db.prepare(query).all(...values, limit, offset) as AuditLogEntry[];
  }

  /**
   * Get audit statistics, computed from database for accuracy after restart.
   */
  getStats(): { total: number; blocked: number; corrected: number; warnings: number } {
    if (!this.db) return { total: 0, blocked: 0, corrected: 0, warnings: 0 };
    const totalResult = this.db.prepare('SELECT COUNT(*) as count FROM supervisor_audit_log').get() as { count: number };
    const blockedResult = this.db.prepare("SELECT COUNT(*) as count FROM supervisor_audit_log WHERE action = 'block'").get() as { count: number };
    const correctedResult = this.db.prepare("SELECT COUNT(*) as count FROM supervisor_audit_log WHERE action = 'correct'").get() as { count: number };
    const warningsResult = this.db.prepare("SELECT COUNT(*) as count FROM supervisor_audit_log WHERE action = 'warn'").get() as { count: number };

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
    if (!this.db) return 0;
    const cutoff = Date.now() - maxAgeMs;
    const result = this.db.prepare(
      `DELETE FROM supervisor_audit_log WHERE timestamp < ?`,
    ).run(cutoff);
    return result.changes;
  }
}
