/**
 * PeriphService — TDD test suite
 *
 * Covers:
 *  - CRUD round-trip (createDevice, getDevice, listDevices, updateDevice, deleteDevice)
 *  - JSON column serialization (config, result_json)
 *  - enabled 0/1 ↔ boolean coercion
 *  - Retention trim: 505 inserts → exactly 500 remain, oldest 5 frame files deleted
 *  - Path escape prevention (periph-evil directory must NOT be unlinked)
 *  - ensurePeriphGitignore idempotency (two calls → only one "periph/" line)
 *  - listObservations filter / cursor / limit defaults
 *  - Unknown device_id error on recordObservation
 *  - createDevice with explicit id
 *  - updateDevice with empty patch (no DB write)
 *  - frameDirFor returns correct path
 */

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';

import { runMigrations } from '../db/migrations.js';
import { PeriphService, OBSERVATION_RETENTION_PER_DEVICE } from '../periph/service.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof BetterSqlite3;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(): BetterSqlite3.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeTmpWs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'periph-test-'));
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('PeriphService', () => {
  let db: BetterSqlite3.Database;
  let tmpWs: string;
  let svc: PeriphService;

  beforeEach(() => {
    db = makeDb();
    tmpWs = makeTmpWs();
    svc = new PeriphService(db, { workspaceRoot: tmpWs });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  });

  // ── OBSERVATION_RETENTION_PER_DEVICE constant ──────────────────────────────

  it('OBSERVATION_RETENTION_PER_DEVICE is 500', () => {
    expect(OBSERVATION_RETENTION_PER_DEVICE).toBe(500);
  });

  // ── createDevice ──────────────────────────────────────────────────────────

  it('createDevice returns PeriphDevice with auto id', () => {
    const dev = svc.createDevice({ name: 'Camera 1', kind: 'camera', driver: 'browser-camera' });
    expect(dev.id).toBeTruthy();
    expect(dev.name).toBe('Camera 1');
    expect(dev.kind).toBe('camera');
    expect(dev.driver).toBe('browser-camera');
    expect(dev.enabled).toBe(true);
    expect(dev.config).toEqual({});
    expect(dev.check_prompt).toBe('');
    expect(dev.last_seen_at).toBeNull();
    expect(dev.last_error).toBeNull();
    expect(dev.created_at).toBeTruthy();
    expect(dev.updated_at).toBeTruthy();
  });

  it('createDevice uses explicit id when provided', () => {
    const dev = svc.createDevice({ id: 'plaud', name: 'Plaud Note', kind: 'audio-recorder', driver: 'mcp-plaud' });
    expect(dev.id).toBe('plaud');
  });

  it('createDevice serializes config JSON', () => {
    const cfg = { fps: 30, resolution: '1080p', nested: { a: 1 } };
    const dev = svc.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera', config: cfg });
    expect(dev.config).toEqual(cfg);
  });

  it('createDevice rejects invalid kind via DB CHECK', () => {
    expect(() =>
      svc.createDevice({ name: 'X', kind: 'invalid-kind' as never, driver: 'browser-camera' }),
    ).toThrow();
  });

  it('createDevice rejects invalid driver via DB CHECK', () => {
    expect(() =>
      svc.createDevice({ name: 'X', kind: 'camera', driver: 'invalid-driver' as never }),
    ).toThrow();
  });

  // ── getDevice ─────────────────────────────────────────────────────────────

  it('getDevice returns null for unknown id', () => {
    expect(svc.getDevice('nonexistent')).toBeNull();
  });

  it('getDevice returns the device after creation', () => {
    const dev = svc.createDevice({ name: 'Lab Cam', kind: 'lab-instrument', driver: 'rtsp' });
    const fetched = svc.getDevice(dev.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(dev.id);
    expect(fetched!.kind).toBe('lab-instrument');
  });

  // ── listDevices ───────────────────────────────────────────────────────────

  it('listDevices returns all devices', () => {
    expect(svc.listDevices()).toHaveLength(0);
    svc.createDevice({ name: 'A', kind: 'camera', driver: 'browser-camera' });
    svc.createDevice({ name: 'B', kind: 'embodied', driver: 'oc-node' });
    expect(svc.listDevices()).toHaveLength(2);
  });

  // ── enabled boolean coercion ──────────────────────────────────────────────

  it('enabled is returned as boolean true by default', () => {
    const dev = svc.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });
    expect(typeof dev.enabled).toBe('boolean');
    expect(dev.enabled).toBe(true);
    // Verify raw DB stores 1
    const raw = db.prepare('SELECT enabled FROM rc_periph_devices WHERE id = ?').get(dev.id) as { enabled: number };
    expect(raw.enabled).toBe(1);
  });

  // ── updateDevice ──────────────────────────────────────────────────────────

  it('updateDevice changes allowed fields', () => {
    const dev = svc.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });
    const updated = svc.updateDevice(dev.id, {
      name: 'New Name',
      enabled: false,
      config: { fps: 60 },
      check_prompt: 'check this',
    });
    expect(updated.name).toBe('New Name');
    expect(updated.enabled).toBe(false);
    expect(updated.config).toEqual({ fps: 60 });
    expect(updated.check_prompt).toBe('check this');
  });

  it('updateDevice with empty patch returns current without DB write', () => {
    const dev = svc.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });
    const before = svc.getDevice(dev.id)!;
    const result = svc.updateDevice(dev.id, {});
    // Should return same data, no DB mutation
    expect(result.updated_at).toBe(before.updated_at);
    expect(result.name).toBe(before.name);
  });

  it('updateDevice throws for unknown device', () => {
    expect(() => svc.updateDevice('no-such', { name: 'X' })).toThrow();
  });

  it('updateDevice sets last_seen_at and last_error', () => {
    const dev = svc.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });
    const ts = '2026-01-01T00:00:00Z';
    const updated = svc.updateDevice(dev.id, { last_seen_at: ts, last_error: 'timeout' });
    expect(updated.last_seen_at).toBe(ts);
    expect(updated.last_error).toBe('timeout');
  });

  // ── deleteDevice ──────────────────────────────────────────────────────────

  it('deleteDevice removes device and cascades observations', () => {
    const dev = svc.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });
    svc.recordObservation({ device_id: dev.id, kind: 'snapshot' });
    svc.deleteDevice(dev.id);
    expect(svc.getDevice(dev.id)).toBeNull();
    const cnt = (db.prepare('SELECT COUNT(*) c FROM rc_periph_observations').get() as { c: number }).c;
    expect(cnt).toBe(0);
  });

  it('deleteDevice is silent for unknown device', () => {
    // Should not throw
    expect(() => svc.deleteDevice('no-such')).not.toThrow();
  });

  // ── recordObservation ─────────────────────────────────────────────────────

  it('recordObservation inserts and returns PeriphObservation', () => {
    const dev = svc.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });
    const obs = svc.recordObservation({
      device_id: dev.id,
      kind: 'snapshot',
      verdict: 'ok',
      summary: 'all good',
      result_json: { foo: 'bar' },
    });
    expect(obs.id).toBeTruthy();
    expect(obs.device_id).toBe(dev.id);
    expect(obs.kind).toBe('snapshot');
    expect(obs.verdict).toBe('ok');
    expect(obs.summary).toBe('all good');
    expect(obs.result_json).toEqual({ foo: 'bar' });
    expect(obs.frame_path).toBeNull();
    expect(obs.monitor_id).toBeNull();
    expect(obs.captured_at).toBeTruthy();
  });

  it('recordObservation with frame_path stores the path', () => {
    const dev = svc.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });
    const fp = path.join('periph', dev.id, 'frame.jpg');
    fs.mkdirSync(path.join(tmpWs, 'periph', dev.id), { recursive: true });
    fs.writeFileSync(path.join(tmpWs, fp), 'x');
    const obs = svc.recordObservation({ device_id: dev.id, kind: 'snapshot', frame_path: fp });
    expect(obs.frame_path).toBe(fp);
  });

  it('recordObservation defaults verdict to info and summary to empty string', () => {
    const dev = svc.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });
    const obs = svc.recordObservation({ device_id: dev.id, kind: 'note' });
    expect(obs.verdict).toBe('info');
    expect(obs.summary).toBe('');
    expect(obs.result_json).toEqual({});
  });

  it('recordObservation throws for unknown device_id (FK violation)', () => {
    expect(() =>
      svc.recordObservation({ device_id: 'no-such-device', kind: 'snapshot' }),
    ).toThrow();
  });

  // ── Retention trim: 505 → 500 with file deletion ──────────────────────────

  it('trims to 500 observations per device and deletes oldest frame files', () => {
    const dev = svc.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });
    const frameDir = path.join(tmpWs, 'periph', dev.id);
    fs.mkdirSync(frameDir, { recursive: true });

    for (let i = 0; i < 505; i++) {
      const fp = path.join('periph', dev.id, `f${i}.jpg`);
      fs.writeFileSync(path.join(tmpWs, fp), 'x');
      svc.recordObservation({ device_id: dev.id, kind: 'snapshot', frame_path: fp });
    }

    // DB count must be exactly 500
    const cnt = (
      db.prepare('SELECT COUNT(*) c FROM rc_periph_observations').get() as { c: number }
    ).c;
    expect(cnt).toBe(500);

    // listObservations respects limit cap 200
    expect(svc.listObservations({ device_id: dev.id, limit: 200 })).toHaveLength(200);

    // Oldest 5 frame files (f0..f4) must have been deleted
    for (let i = 0; i < 5; i++) {
      expect(fs.existsSync(path.join(tmpWs, 'periph', dev.id, `f${i}.jpg`))).toBe(false);
    }

    // Newest frame file (f504) must still exist
    expect(fs.existsSync(path.join(tmpWs, 'periph', dev.id, 'f504.jpg'))).toBe(true);
  });

  it('does NOT delete frame_path outside periph/ (path escape prevention)', () => {
    const dev = svc.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });

    // Pre-create 500 observations so the next insert triggers trim
    for (let i = 0; i < 500; i++) {
      svc.recordObservation({ device_id: dev.id, kind: 'note' });
    }

    // Create a file outside periph/ dir (simulates escape attempt via periph-evil)
    const outsideFile = path.join(tmpWs, 'important.txt');
    fs.writeFileSync(outsideFile, 'keep me');

    // Attempt to store a path that escapes the periph/ prefix
    // (../important.txt resolves outside periph/)
    const escapePath = path.join('periph', dev.id, '..', '..', 'important.txt');
    svc.recordObservation({ device_id: dev.id, kind: 'snapshot', frame_path: escapePath });

    // The file should NOT have been deleted
    expect(fs.existsSync(outsideFile)).toBe(true);
  });

  it('does not delete frame file when it does not exist (no throw)', () => {
    const dev = svc.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });

    for (let i = 0; i < 500; i++) {
      svc.recordObservation({ device_id: dev.id, kind: 'note' });
    }
    // Insert one with a frame_path that does NOT exist on disk
    const fp = path.join('periph', dev.id, 'ghost.jpg');
    // Do NOT create the file
    expect(() =>
      svc.recordObservation({ device_id: dev.id, kind: 'snapshot', frame_path: fp }),
    ).not.toThrow();
  });

  // ── listObservations ──────────────────────────────────────────────────────

  it('listObservations returns latest first (captured_at DESC)', () => {
    const dev = svc.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });
    for (let i = 0; i < 5; i++) {
      svc.recordObservation({ device_id: dev.id, kind: 'snapshot', summary: `obs-${i}` });
    }
    const list = svc.listObservations({ device_id: dev.id });
    // Returned in DESC order — last inserted (obs-4) should be first
    expect(list[0].summary).toBe('obs-4');
  });

  it('listObservations default limit is 50', () => {
    const dev = svc.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });
    for (let i = 0; i < 60; i++) {
      svc.recordObservation({ device_id: dev.id, kind: 'note' });
    }
    const list = svc.listObservations({ device_id: dev.id });
    expect(list).toHaveLength(50);
  });

  it('listObservations caps limit at 200', () => {
    const dev = svc.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });
    for (let i = 0; i < 250; i++) {
      svc.recordObservation({ device_id: dev.id, kind: 'note' });
    }
    expect(svc.listObservations({ device_id: dev.id, limit: 300 })).toHaveLength(200);
  });

  it('listObservations filters by device_id', () => {
    const d1 = svc.createDevice({ name: 'A', kind: 'camera', driver: 'browser-camera' });
    const d2 = svc.createDevice({ name: 'B', kind: 'audio-recorder', driver: 'mcp-plaud' });
    svc.recordObservation({ device_id: d1.id, kind: 'snapshot' });
    svc.recordObservation({ device_id: d1.id, kind: 'note' });
    svc.recordObservation({ device_id: d2.id, kind: 'check' });
    expect(svc.listObservations({ device_id: d1.id })).toHaveLength(2);
    expect(svc.listObservations({ device_id: d2.id })).toHaveLength(1);
  });

  it('listObservations without device_id returns all', () => {
    const d1 = svc.createDevice({ name: 'A', kind: 'camera', driver: 'browser-camera' });
    const d2 = svc.createDevice({ name: 'B', kind: 'audio-recorder', driver: 'mcp-plaud' });
    svc.recordObservation({ device_id: d1.id, kind: 'snapshot' });
    svc.recordObservation({ device_id: d2.id, kind: 'note' });
    expect(svc.listObservations({})).toHaveLength(2);
  });

  it('listObservations before cursor (captured_at) filters correctly', () => {
    const dev = svc.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });
    // Use direct DB inserts with explicit timestamps (sync code can't sleep for
    // distinct captured_at values). Three rows straddling the pivot:
    //   older-id  < pivot  → MUST be returned
    //   pivot-id  = pivot  → excluded (strict <)
    //   newer-id  > pivot  → excluded
    const pivotTs = '2026-06-01T12:00:00.000Z';
    db.prepare(
      `INSERT INTO rc_periph_observations (id, device_id, kind, captured_at) VALUES (?, ?, ?, ?)`,
    ).run('older-id', dev.id, 'note', '2026-05-31T12:00:00.000Z');
    db.prepare(
      `INSERT INTO rc_periph_observations (id, device_id, kind, captured_at) VALUES (?, ?, ?, ?)`,
    ).run('pivot-id', dev.id, 'note', pivotTs);
    db.prepare(
      `INSERT INTO rc_periph_observations (id, device_id, kind, captured_at) VALUES (?, ?, ?, ?)`,
    ).run('newer-id', dev.id, 'note', '2026-06-02T12:00:00.000Z');

    // before=pivotTs should return only rows with captured_at < pivotTs
    const result = svc.listObservations({ device_id: dev.id, before: pivotTs });
    const ids = result.map((r) => r.id);
    // Positive assertion: the one row strictly older than the pivot IS returned
    // (guards against the filter matching nothing — which made not.toContain vacuous).
    expect(ids).toContain('older-id');
    expect(result).toHaveLength(1);
    expect(ids).not.toContain('pivot-id');
    expect(ids).not.toContain('newer-id');
  });

  // ── ensurePeriphGitignore ─────────────────────────────────────────────────

  it('ensurePeriphGitignore creates .gitignore with periph/ line', () => {
    svc.ensurePeriphGitignore();
    const gi = fs.readFileSync(path.join(tmpWs, '.gitignore'), 'utf8');
    expect(gi).toContain('periph/');
  });

  it('ensurePeriphGitignore is idempotent (two calls → one periph/ line)', () => {
    svc.ensurePeriphGitignore();
    svc.ensurePeriphGitignore();
    const gi = fs.readFileSync(path.join(tmpWs, '.gitignore'), 'utf8');
    const matches = gi.match(/^periph\/$/gm) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('ensurePeriphGitignore appends to existing .gitignore', () => {
    const giPath = path.join(tmpWs, '.gitignore');
    fs.writeFileSync(giPath, '# existing\nnode_modules/\n');
    svc.ensurePeriphGitignore();
    const gi = fs.readFileSync(giPath, 'utf8');
    expect(gi).toContain('node_modules/');
    expect(gi).toContain('periph/');
  });

  it('ensurePeriphGitignore does not duplicate if periph/ already present', () => {
    const giPath = path.join(tmpWs, '.gitignore');
    fs.writeFileSync(giPath, '# stuff\nperiph/\n');
    svc.ensurePeriphGitignore();
    const gi = fs.readFileSync(giPath, 'utf8');
    const matches = gi.match(/^periph\/$/gm) ?? [];
    expect(matches).toHaveLength(1);
  });

  // ── frameDirFor ───────────────────────────────────────────────────────────

  it('frameDirFor returns <workspaceRoot>/periph/<deviceId>', () => {
    expect(svc.frameDirFor('my-device')).toBe(path.join(tmpWs, 'periph', 'my-device'));
  });
});
