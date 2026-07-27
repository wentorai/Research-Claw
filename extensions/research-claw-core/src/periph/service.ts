/**
 * PeriphService — peripheral device CRUD, observation recording with retention
 * trimming, and workspace gitignore management.
 *
 * Style: mirrors src/monitor/service.ts — raw better-sqlite3 handle injected
 * in constructor, inline prepare(), row-interface assertions, dynamic UPDATE
 * sets/params, db.transaction() for multi-statement writes, JSON columns with
 * JSON.stringify / JSON.parse (try-catch on parse).
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type Database from 'better-sqlite3';

import { resolveWithinRoot } from '../workspace/path-guard.js';
import type { PeriphDevice, PeriphObservation, PeriphKind, PeriphDriver, PeriphVerdict } from './types.js';

export { type PeriphDevice, type PeriphObservation, type PeriphKind, type PeriphDriver, type PeriphVerdict } from './types.js';

/** Maximum number of observations kept per device (oldest are trimmed). */
export const OBSERVATION_RETENTION_PER_DEVICE = 500;

// ── Device id validation ────────────────────────────────────────────────────

/**
 * A device id doubles as a PATH SEGMENT (`<workspaceRoot>/periph/<id>/`), so it
 * must be a single safe segment — not merely a unique string. Accepts what the
 * product actually mints: `randomUUID()` (hex + dashes) and the fixed `'plaud'`
 * literal. Rejects everything that could change the shape of the resolved path:
 * `..`, `/`, `\` (a Windows separator — CLAUDE.md ships win32), NUL, leading
 * dots/dashes, absolute paths, control characters, and over-long ids.
 */
const DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class PeriphDeviceIdError extends Error {
  override readonly name = 'PeriphDeviceIdError';
  constructor(public readonly deviceId: string) {
    // The id is caller-supplied, never a credential — safe to echo back so the
    // dashboard/agent can see what was rejected.
    super(`Invalid peripheral device id: ${JSON.stringify(deviceId)}`);
  }
}

export function isValidPeriphDeviceId(id: unknown): id is string {
  return typeof id === 'string' && DEVICE_ID_RE.test(id);
}

export function assertValidPeriphDeviceId(id: unknown): asserts id is string {
  if (!isValidPeriphDeviceId(id)) throw new PeriphDeviceIdError(String(id));
}

// ── DB row types ────────────────────────────────────────────────────────────

interface DeviceRow {
  id: string;
  name: string;
  kind: string;
  driver: string;
  enabled: number;
  config: string;
  check_prompt: string;
  last_seen_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface ObservationRow {
  id: string;
  device_id: string;
  monitor_id: string | null;
  kind: string;
  verdict: string;
  summary: string;
  frame_path: string | null;
  result_json: string;
  captured_at: string;
  /** SQLite rowid, aliased via `rowid AS _cursor` in list/get SELECTs. */
  _cursor?: number;
}

// ── Row → domain mappers ────────────────────────────────────────────────────

function rowToDevice(row: DeviceRow): PeriphDevice {
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(row.config) as Record<string, unknown>; } catch { /* keep empty */ }
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as PeriphKind,
    driver: row.driver as PeriphDriver,
    enabled: row.enabled !== 0,
    config,
    check_prompt: row.check_prompt,
    last_seen_at: row.last_seen_at,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToObservation(row: ObservationRow): PeriphObservation {
  let result_json: Record<string, unknown> = {};
  try { result_json = JSON.parse(row.result_json) as Record<string, unknown>; } catch { /* keep empty */ }
  return {
    id: row.id,
    device_id: row.device_id,
    monitor_id: row.monitor_id,
    kind: row.kind as PeriphObservation['kind'],
    verdict: row.verdict as PeriphVerdict,
    summary: row.summary,
    frame_path: row.frame_path,
    result_json,
    captured_at: row.captured_at,
    cursor: row._cursor ?? 0,
  };
}

/** Result of {@link PeriphService.deleteDevice} — see its doc comment. */
export interface PeriphDeviceDeletion {
  /** false when no device row matched (the monitor cascade still ran). */
  deleted: boolean;
  /** Device monitors removed by the cascade, with the cron job each still holds. */
  monitors: Array<{ id: string; gateway_job_id: string | null }>;
}

// ── PeriphService ────────────────────────────────────────────────────────────

export class PeriphService {
  private readonly db: Database.Database;
  private readonly workspaceRoot: string;

  constructor(db: Database.Database, opts: { workspaceRoot: string }) {
    this.db = db;
    this.workspaceRoot = opts.workspaceRoot;
  }

  // ── Devices ──────────────────────────────────────────────────────────────

  listDevices(): PeriphDevice[] {
    const rows = this.db
      .prepare('SELECT * FROM rc_periph_devices ORDER BY created_at ASC')
      .all() as DeviceRow[];
    return rows.map(rowToDevice);
  }

  getDevice(id: string): PeriphDevice | null {
    const row = this.db
      .prepare('SELECT * FROM rc_periph_devices WHERE id = ?')
      .get(id) as DeviceRow | undefined;
    return row ? rowToDevice(row) : null;
  }

  createDevice(input: {
    id?: string;
    name: string;
    kind: PeriphKind;
    driver: PeriphDriver;
    config?: Record<string, unknown>;
    check_prompt?: string;
  }): PeriphDevice {
    // A caller-supplied id becomes a frame-directory path segment; validate it
    // BEFORE it can reach the DB, so no row can exist that frameDirFor must
    // later refuse. Server-minted UUIDs always satisfy the same rule.
    if (input.id !== undefined) assertValidPeriphDeviceId(input.id);
    const id = input.id ?? randomUUID();
    const config = JSON.stringify(input.config ?? {});
    const check_prompt = input.check_prompt ?? '';

    // Let better-sqlite3 propagate DB CHECK constraint errors as-is.
    this.db.prepare(`
      INSERT INTO rc_periph_devices (id, name, kind, driver, enabled, config, check_prompt, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, datetime('now'), datetime('now'))
    `).run(id, input.name, input.kind, input.driver, config, check_prompt);

    return this.getDevice(id)!;
  }

  updateDevice(
    id: string,
    patch: Partial<Pick<PeriphDevice, 'name' | 'enabled' | 'config' | 'check_prompt' | 'last_seen_at' | 'last_error'>>,
  ): PeriphDevice {
    const current = this.getDevice(id);
    if (!current) throw new Error(`PeriphDevice not found: ${id}`);

    const sets: string[] = [];
    const params: unknown[] = [];

    if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name); }
    if (patch.enabled !== undefined) { sets.push('enabled = ?'); params.push(patch.enabled ? 1 : 0); }
    if (patch.config !== undefined) { sets.push('config = ?'); params.push(JSON.stringify(patch.config)); }
    if (patch.check_prompt !== undefined) { sets.push('check_prompt = ?'); params.push(patch.check_prompt); }
    if (patch.last_seen_at !== undefined) { sets.push('last_seen_at = ?'); params.push(patch.last_seen_at); }
    if (patch.last_error !== undefined) { sets.push('last_error = ?'); params.push(patch.last_error); }

    // Empty patch — return current without any DB write.
    if (sets.length === 0) return current;

    sets.push("updated_at = datetime('now')");
    params.push(id);

    this.db.prepare(`UPDATE rc_periph_devices SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.getDevice(id)!;
  }

  /**
   * Delete a device, its observations (FK CASCADE) and every monitor bound to
   * it via `source_type='device'`.
   *
   * rc_monitors.target is a free-form TEXT column shared by all source types,
   * so SQLite cannot express this as a foreign key — the cascade is explicit
   * and matches on `source_type='device' AND target = id`, never on the id
   * alone (an arxiv/web monitor may legitimately carry the same string).
   *
   * Both statements run in one transaction: a half-applied delete would leave
   * exactly the orphan state this exists to prevent.
   *
   * The removed monitors are returned with their `gateway_job_id` because the
   * OpenClaw cron job lives outside this DB — the caller (rc.periph RPC →
   * dashboard) removes it, the same division of labour as `MonitorService.delete`.
   * The monitor cascade runs even when the device row is already gone, so a
   * retry after a failed delete still clears leftovers.
   */
  deleteDevice(id: string): PeriphDeviceDeletion {
    const run = this.db.transaction((deviceId: string): PeriphDeviceDeletion => {
      const monitors = this.db.prepare(
        "SELECT id, gateway_job_id FROM rc_monitors WHERE source_type = 'device' AND target = ?",
      ).all(deviceId) as Array<{ id: string; gateway_job_id: string | null }>;

      const info = this.db.prepare('DELETE FROM rc_periph_devices WHERE id = ?').run(deviceId);
      if (monitors.length > 0) {
        this.db.prepare(
          "DELETE FROM rc_monitors WHERE source_type = 'device' AND target = ?",
        ).run(deviceId);
      }

      return { deleted: info.changes > 0, monitors };
    });
    return run(id);
  }

  // ── Observations ─────────────────────────────────────────────────────────

  /**
   * Record an observation for a device.
   *
   * After insert, if the per-device observation count exceeds
   * OBSERVATION_RETENTION_PER_DEVICE (500), the oldest excess rows are removed.
   * For each trimmed row whose frame_path resolves within
   * <workspaceRoot>/periph/, the corresponding file is unlinked after the
   * transaction commits (individual try-catch; missing files are ignored).
   */
  recordObservation(input: {
    device_id: string;
    kind: PeriphObservation['kind'];
    verdict?: PeriphVerdict;
    summary?: string;
    frame_path?: string | null;
    result_json?: Record<string, unknown>;
    monitor_id?: string;
  }): PeriphObservation {
    const id = randomUUID();
    const verdict = input.verdict ?? 'info';
    const summary = input.summary ?? '';
    const frame_path = input.frame_path ?? null;
    const result_json = JSON.stringify(input.result_json ?? {});
    const monitor_id = input.monitor_id ?? null;

    // Paths to unlink after the transaction (validated within transaction).
    let pathsToUnlink: string[] = [];

    const insertAndTrim = this.db.transaction(() => {
      // Insert the new observation (FK violation throws if device_id unknown).
      this.db.prepare(`
        INSERT INTO rc_periph_observations
          (id, device_id, monitor_id, kind, verdict, summary, frame_path, result_json, captured_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(id, input.device_id, monitor_id, input.kind, verdict, summary, frame_path, result_json);

      // Check if trimming is needed.
      const count = (
        this.db
          .prepare('SELECT COUNT(*) c FROM rc_periph_observations WHERE device_id = ?')
          .get(input.device_id) as { c: number }
      ).c;

      if (count > OBSERVATION_RETENTION_PER_DEVICE) {
        // Identify rows to delete (oldest beyond the retention window).
        // Use rowid as tiebreaker (always insertion-order, unlike UUIDs).
        const toDelete = this.db.prepare(`
          SELECT id, frame_path FROM rc_periph_observations
          WHERE device_id = ?
            AND rowid NOT IN (
              SELECT rowid FROM rc_periph_observations
              WHERE device_id = ?
              ORDER BY captured_at DESC, rowid DESC
              LIMIT ${OBSERVATION_RETENTION_PER_DEVICE}
            )
        `).all(input.device_id, input.device_id) as Array<{ id: string; frame_path: string | null }>;

        // Collect validated frame_paths before deleting.
        // Audit #5: a lexical prefix check does NOT follow symlinks. If
        // `periph/<id>` (an intermediate dir) is a symlink to an external
        // directory, unlinkSync on `periph/<id>/victim` would delete the real
        // external file. So we realpath the PARENT directory and require its REAL
        // location to be under the REAL periph/ dir, then unlink by real path.
        // (A frame_path that is itself a symlink is safe: unlink removes the link,
        // not its target.)
        const periphRoot = path.resolve(this.workspaceRoot, 'periph');
        let realPeriph: string | null = null;
        try { realPeriph = fs.realpathSync(periphRoot); } catch { realPeriph = null; }
        for (const row of toDelete) {
          if (!row.frame_path || realPeriph === null) continue;
          const abs = path.resolve(this.workspaceRoot, row.frame_path);
          // Cheap lexical gate first (rejects `..` escapes after normalization).
          if (!abs.startsWith(periphRoot + path.sep) && !abs.startsWith(periphRoot + '/')) continue;
          try {
            const realParent = fs.realpathSync(path.dirname(abs));
            if (realParent !== realPeriph && !realParent.startsWith(realPeriph + path.sep)) {
              continue; // parent dir escapes periph/ via symlink — refuse to delete
            }
            pathsToUnlink.push(path.join(realParent, path.basename(abs)));
          } catch {
            // Parent dir missing/unreadable — nothing safe to delete.
          }
        }

        // Delete in DB (within the transaction).
        this.db.prepare(`
          DELETE FROM rc_periph_observations
          WHERE device_id = ?
            AND rowid NOT IN (
              SELECT rowid FROM rc_periph_observations
              WHERE device_id = ?
              ORDER BY captured_at DESC, rowid DESC
              LIMIT ${OBSERVATION_RETENTION_PER_DEVICE}
            )
        `).run(input.device_id, input.device_id);
      }
    });

    insertAndTrim();

    // Unlink frame files after transaction commits, individually try-catched.
    for (const absPath of pathsToUnlink) {
      try {
        fs.unlinkSync(absPath);
      } catch {
        // File not found or permission error — silently ignore.
      }
    }

    return rowToObservation(
      this.db
        .prepare('SELECT rowid AS _cursor, * FROM rc_periph_observations WHERE id = ?')
        .get(id) as ObservationRow,
    );
  }

  /**
   * List observations in captured_at DESC order.
   *
   * @param q.device_id     — filter by device (omit for all devices)
   * @param q.limit         — default 50, capped at 200
   * @param q.before        — cursor part 1: the captured_at of the last row seen
   * @param q.before_cursor — cursor part 2: the rowid (`PeriphObservation.cursor`)
   *                          of the last row seen. REQUIRED alongside `before` for
   *                          correct pagination: captured_at is second-precision so
   *                          `captured_at < before` alone drops all rows sharing the
   *                          page boundary's second. The composite comparison
   *                          `(captured_at, rowid) < (before, before_cursor)` matches
   *                          the `ORDER BY captured_at DESC, rowid DESC` exactly.
   */
  listObservations(q: {
    device_id?: string;
    limit?: number;
    before?: string;
    before_cursor?: number;
  }): PeriphObservation[] {
    const limit = Math.min(q.limit ?? 50, 200);
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (q.device_id) {
      clauses.push('device_id = ?');
      params.push(q.device_id);
    }
    if (q.before) {
      if (typeof q.before_cursor === 'number') {
        // Composite keyset cursor: strictly-older second, OR same second with a
        // smaller rowid. Mirrors ORDER BY (captured_at DESC, rowid DESC).
        clauses.push('(captured_at < ? OR (captured_at = ? AND rowid < ?))');
        params.push(q.before, q.before, q.before_cursor);
      } else {
        // Backward-compatible degraded path (no tiebreak) — may drop same-second
        // rows at the page boundary; callers should always send before_cursor.
        clauses.push('captured_at < ?');
        params.push(q.before);
      }
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = this.db
      .prepare(
        `SELECT rowid AS _cursor, * FROM rc_periph_observations ${where} ORDER BY captured_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...params, limit) as ObservationRow[];

    return rows.map(rowToObservation);
  }

  // ── Gitignore ────────────────────────────────────────────────────────────

  /**
   * Idempotently ensure <workspaceRoot>/.gitignore contains a standalone
   * "periph/" line (exact line match). Creates the file if absent.
   */
  ensurePeriphGitignore(): void {
    const giPath = path.join(this.workspaceRoot, '.gitignore');

    let content = '';
    try {
      content = fs.readFileSync(giPath, 'utf8');
    } catch {
      // File doesn't exist — will be created below.
    }

    // Check for an exact standalone "periph/" line.
    const lines = content.split('\n');
    const alreadyPresent = lines.some((l) => l.trim() === 'periph/');
    if (alreadyPresent) return;

    // Append (with comment and newline guard).
    const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    const addition = `${separator}# Research-Claw peripherals frames (auto)\nperiph/\n`;
    fs.writeFileSync(giPath, content + addition, 'utf8');
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  /**
   * Canonical frame storage directory for a device, guaranteed to stay inside
   * `<workspaceRoot>/periph/`.
   *
   * Two independent layers, because either alone is insufficient:
   *  1. id-shape validation — createDevice enforces it too, but a legacy row or
   *     a hand-edited SQLite file can still hold a traversal id, and this is the
   *     only place that turns an id into a path.
   *  2. resolveWithinRoot — a valid id still escapes if `periph/` (or the
   *     workspace root itself) is a SYMLINK to an external directory; the guard
   *     realpath-walks the first existing ancestor and rejects that.
   *
   * Throws (PeriphDeviceIdError / PathEscapeError) rather than returning an
   * unsafe path — callers must not mkdir or spawn ffmpeg before this succeeds.
   */
  frameDirFor(deviceId: string): string {
    assertValidPeriphDeviceId(deviceId);
    return resolveWithinRoot(this.workspaceRoot, path.join('periph', deviceId));
  }
}
