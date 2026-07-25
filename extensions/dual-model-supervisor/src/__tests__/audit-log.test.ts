/**
 * R5 — audit persistence is OBSERVABLE, never a silent drop. record() returns an
 * outcome so a caller can tell whether an entry was persisted. Persistence is
 * best-effort ("persisted when the DB is available; failure observable"), NOT a
 * zero-loss guarantee. DB-unavailable is logged (once) + returned, not swallowed.
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { AuditLogService } from '../core/audit-log.js';

const ENTRY = { sessionId: 's', type: 'output_review' as const, action: 'pass' as const, details: 'ok', timestamp: 1000 };

describe('AuditLogService.record observability', () => {
  it('returns ok:true and persists when the DB is available', () => {
    const db = new Database(':memory:');
    const svc = new AuditLogService(db, { info() {}, warn() {}, error() {} });
    expect(svc.record(ENTRY)).toEqual({ ok: true });
    expect(svc.list({}).length).toBe(1);
    db.close();
  });

  it('returns db_unavailable (not a silent no-op) and warns once when there is no DB', () => {
    const warns: string[] = [];
    const svc = new AuditLogService(null, { info() {}, warn: (m: string) => warns.push(m), error() {} });
    expect(svc.record(ENTRY)).toEqual({ ok: false, reason: 'db_unavailable' });
    expect(svc.record(ENTRY)).toEqual({ ok: false, reason: 'db_unavailable' }); // still observable
    expect(warns.length).toBe(1); // warned once — observable, not flooding the log
    expect(warns[0]).toMatch(/not being persisted|unavailable/i);
  });
});
