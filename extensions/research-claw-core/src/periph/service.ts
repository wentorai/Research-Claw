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

import type { PeriphDevice, PeriphObservation, PeriphKind, PeriphDriver, PeriphVerdict } from './types.js';

export { type PeriphDevice, type PeriphObservation, type PeriphKind, type PeriphDriver, type PeriphVerdict } from './types.js';

/** Maximum number of observations kept per device (oldest are trimmed). */
export const OBSERVATION_RETENTION_PER_DEVICE = 500;

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
  };
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

  deleteDevice(id: string): void {
    this.db.prepare('DELETE FROM rc_periph_devices WHERE id = ?').run(id);
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
        const periphRoot = path.resolve(this.workspaceRoot, 'periph');
        for (const row of toDelete) {
          if (row.frame_path) {
            const abs = path.resolve(this.workspaceRoot, row.frame_path);
            // Strict prefix check — must be within <workspaceRoot>/periph/
            // (include the path separator to prevent "periph-evil" bypass).
            if (abs.startsWith(periphRoot + path.sep) || abs.startsWith(periphRoot + '/')) {
              pathsToUnlink.push(abs);
            }
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
        .prepare('SELECT * FROM rc_periph_observations WHERE id = ?')
        .get(id) as ObservationRow,
    );
  }

  /**
   * List observations in captured_at DESC order.
   *
   * @param q.device_id  — filter by device (omit for all devices)
   * @param q.limit      — default 50, capped at 200
   * @param q.before     — cursor: only return rows with captured_at < before
   */
  listObservations(q: {
    device_id?: string;
    limit?: number;
    before?: string;
  }): PeriphObservation[] {
    const limit = Math.min(q.limit ?? 50, 200);
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (q.device_id) {
      clauses.push('device_id = ?');
      params.push(q.device_id);
    }
    if (q.before) {
      clauses.push('captured_at < ?');
      params.push(q.before);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = this.db
      .prepare(
        `SELECT * FROM rc_periph_observations ${where} ORDER BY captured_at DESC, rowid DESC LIMIT ?`,
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

  /** Canonical frame storage directory for a device. */
  frameDirFor(deviceId: string): string {
    return path.join(this.workspaceRoot, 'periph', deviceId);
  }
}
