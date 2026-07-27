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
import { MonitorService } from '../monitor/service.js';

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

  // Audit #5: an intermediate symlinked directory must not let retention
  // trimming delete files outside the workspace. periph/<id> → external dir;
  // an old observation's frame_path = periph/<id>/victim.txt; trimming must
  // realpath the parent and refuse to unlink the external target.
  it('does NOT delete files reached through a symlinked intermediate dir (retention)', () => {
    const dev = svc.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });

    // External directory with a victim file, outside the workspace.
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'periph-external-'));
    const victim = path.join(externalDir, 'victim.txt');
    fs.writeFileSync(victim, 'must survive');

    // periph/<id> is a SYMLINK to the external dir.
    const periphDir = path.join(tmpWs, 'periph');
    fs.mkdirSync(periphDir, { recursive: true });
    const linkDir = path.join(periphDir, dev.id);
    fs.symlinkSync(externalDir, linkDir);

    // Seed 500 observations whose frame_path points through the symlinked dir,
    // then insert one more to trigger trimming of the oldest.
    const rel = path.join('periph', dev.id, 'victim.txt');
    for (let i = 0; i < 501; i++) {
      svc.recordObservation({ device_id: dev.id, kind: 'snapshot', frame_path: rel });
    }

    // The external victim file must still exist — trimming refused to follow the
    // symlink out of periph/.
    expect(fs.existsSync(victim)).toBe(true);

    fs.rmSync(externalDir, { recursive: true, force: true });
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

  // Audit #6: same-second pagination must NOT drop rows. captured_at is
  // second-precision; with a captured_at-only cursor, a page boundary that lands
  // inside a run of same-second rows silently skips the rest. The composite
  // (captured_at, rowid) keyset cursor must return every row exactly once.
  it('listObservations paginates same-second rows without loss or dup (60 rows, page 50+10)', () => {
    const dev = svc.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });
    const SAME_SECOND = '2026-07-24 12:00:00';
    const insert = db.prepare(`
      INSERT INTO rc_periph_observations
        (id, device_id, monitor_id, kind, verdict, summary, frame_path, result_json, captured_at)
      VALUES (?, ?, NULL, 'check', 'ok', ?, NULL, '{}', ?)
    `);
    for (let i = 0; i < 60; i++) {
      insert.run(`obs-${i}`, dev.id, `s-${i}`, SAME_SECOND);
    }

    const page1 = svc.listObservations({ device_id: dev.id, limit: 50 });
    expect(page1).toHaveLength(50);

    const last = page1[page1.length - 1];
    const page2 = svc.listObservations({
      device_id: dev.id,
      limit: 50,
      before: last.captured_at,
      before_cursor: last.cursor,
    });
    // The remaining 10 same-second rows must appear — not be skipped by `< before`.
    expect(page2).toHaveLength(10);

    // No overlap, no loss: union of both pages = all 60 distinct ids.
    const ids = new Set([...page1, ...page2].map((o) => o.id));
    expect(ids.size).toBe(60);

    // A third page past the end returns empty (cursor is exhausted).
    const oldest = page2[page2.length - 1];
    const page3 = svc.listObservations({
      device_id: dev.id,
      limit: 50,
      before: oldest.captured_at,
      before_cursor: oldest.cursor,
    });
    expect(page3).toHaveLength(0);
  });

  it('listObservations exposes a monotonic cursor (rowid) on each row', () => {
    const dev = svc.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });
    svc.recordObservation({ device_id: dev.id, kind: 'note', summary: 'a' });
    svc.recordObservation({ device_id: dev.id, kind: 'note', summary: 'b' });
    const list = svc.listObservations({ device_id: dev.id });
    // DESC order → newest ('b') first with the larger cursor.
    expect(list[0].cursor).toBeGreaterThan(list[1].cursor);
    expect(Number.isInteger(list[0].cursor)).toBe(true);
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

  // ── R2-C1: device id is a path segment — traversal containment ────────────
  //
  // The device id is interpolated into `<workspaceRoot>/periph/<id>/`, and the
  // gateway-side drivers (rtsp / local-camera) mkdir + write ffmpeg output
  // there. Without this guard, `id: '../../x'` placed real JPEG frames outside
  // the workspace, the retention sweeper could never reclaim them, and an id
  // containing NUL crashed the capture. These are the negative cases.

  describe('R2-C1 device id validation', () => {
    const REJECTED: Array<[string, string]> = [
      ['parent traversal', '../escaped'],
      ['double traversal', '../../escaped'],
      ['deep traversal', '../../../../tmp/escaped'],
      ['bare dotdot', '..'],
      ['posix separator', 'a/b'],
      // path.win32 treats `\` as a separator and CLAUDE.md ships win32, so a
      // backslash id escapes there even though darwin sees a plain character.
      ['windows separator', '..\\escaped'],
      ['windows nested', 'a\\b'],
      ['absolute path', '/tmp/escaped'],
      // An embedded NUL makes mkdir throw and spawn throw SYNCHRONOUSLY — the
      // path that used to hang the tool forever (see R2-I2).
      ['null byte', `nul${String.fromCharCode(0)}x`],
      ['empty string', ''],
      ['whitespace only', '   '],
      ['leading dot', '.hidden'],
      ['leading dash', '-flag'],
      ['too long (65)', 'a'.repeat(65)],
      ['newline', 'a\nb'],
    ];

    it.each(REJECTED)('createDevice rejects %s and writes no row', (_label, badId) => {
      const before = svc.listDevices().length;
      expect(() =>
        svc.createDevice({ id: badId, name: 'Evil', kind: 'camera', driver: 'rtsp' }),
      ).toThrow(/Invalid peripheral device id/);
      expect(svc.listDevices()).toHaveLength(before);
    });

    it.each(REJECTED)('frameDirFor refuses %s (no directory created)', (_label, badId) => {
      expect(() => svc.frameDirFor(badId)).toThrow();
      // Nothing may have been created anywhere as a side effect.
      expect(fs.existsSync(path.join(tmpWs, 'periph'))).toBe(false);
    });

    const ACCEPTED: Array<[string, string]> = [
      ['server-minted uuid', '41b9e5bc-1b1c-4562-b7fd-dc6178fea337'],
      // PlaudCard registers this exact literal (PLAUD_DEVICE_ID); the rule must
      // not break the one semantic id the product actually ships.
      ['plaud literal', 'plaud'],
      ['kebab case', 'my-device'],
      ['snake case', 'my_device_1'],
      ['single char', 'a'],
      ['max length (64)', 'a'.repeat(64)],
    ];

    it.each(ACCEPTED)('createDevice accepts %s', (_label, goodId) => {
      const dev = svc.createDevice({ id: goodId, name: 'Ok', kind: 'camera', driver: 'rtsp' });
      expect(dev.id).toBe(goodId);
      expect(svc.frameDirFor(goodId)).toBe(path.join(tmpWs, 'periph', goodId));
    });

    it('a LEGACY row holding a traversal id still cannot produce a frame dir', () => {
      // Rows written before this guard (or by hand-editing rc.sqlite) bypass
      // createDevice entirely — frameDirFor is the last line of defence.
      db.prepare(`
        INSERT INTO rc_periph_devices (id, name, kind, driver, enabled, config, check_prompt, created_at, updated_at)
        VALUES (?, 'Legacy', 'camera', 'rtsp', 1, '{}', '', datetime('now'), datetime('now'))
      `).run('../../legacy-escape');

      expect(svc.getDevice('../../legacy-escape')).not.toBeNull();
      expect(() => svc.frameDirFor('../../legacy-escape')).toThrow(/Invalid peripheral device id/);
    });

    it('a symlinked periph/ escapes containment even with a valid uuid → refused', () => {
      // Case H: the id is a perfectly ordinary UUID, but `<ws>/periph` points
      // outside. A lexical prefix check passes here; only the realpath walk in
      // resolveWithinRoot catches it.
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'periph-outside-'));
      try {
        fs.symlinkSync(outside, path.join(tmpWs, 'periph'), 'dir');
        const uuid = '41b9e5bc-1b1c-4562-b7fd-dc6178fea337';
        expect(() => svc.frameDirFor(uuid)).toThrow(/symlink/i);
        // And nothing was created under the symlink target.
        expect(fs.readdirSync(outside)).toHaveLength(0);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  // ── R2-I3: deleting a device must not leave orphan device monitors ────────
  //
  // rc_monitors has no foreign key to rc_periph_devices (target is a free-form
  // TEXT column shared by every source_type), so a bare
  // `DELETE FROM rc_periph_devices` leaves `source_type='device'` monitors
  // pointing at an id that no longer resolves. Those monitors keep their
  // gateway_job_id, the dashboard's reconcile pass sees `enabled = 1` with a
  // missing job and re-registers the cron, and the job fires forever against a
  // device that is gone.
  describe('R2-I3 deleteDevice cascades bound device monitors', () => {
    let monitors: MonitorService;

    beforeEach(() => {
      monitors = new MonitorService(db);
    });

    function makeDeviceMonitor(deviceId: string, jobId: string | null = 'job-1') {
      const m = monitors.create({ name: 'Bench watch', source_type: 'device', target: deviceId });
      monitors.toggle(m.id, true);
      if (jobId) monitors.setGatewayJobId(m.id, jobId);
      return monitors.get(m.id);
    }

    it('removes device monitors bound to the deleted device', () => {
      const dev = svc.createDevice({ name: 'Cam', kind: 'camera', driver: 'rtsp' });
      const mon = makeDeviceMonitor(dev.id);
      expect(mon.enabled).toBe(true);

      svc.deleteDevice(dev.id);

      expect(svc.getDevice(dev.id)).toBeNull();
      expect(() => monitors.get(mon.id)).toThrow(/not found/i);
    });

    it('returns the freed gateway job ids so the caller can remove the cron jobs', () => {
      const dev = svc.createDevice({ name: 'Cam', kind: 'camera', driver: 'rtsp' });
      const bound = makeDeviceMonitor(dev.id, 'gw-job-42');
      const unbound = makeDeviceMonitor(dev.id, null);

      const result = svc.deleteDevice(dev.id);

      expect(result.deleted).toBe(true);
      expect(result.monitors.map((m) => m.id).sort()).toEqual([bound.id, unbound.id].sort());
      expect(result.monitors.find((m) => m.id === bound.id)?.gateway_job_id).toBe('gw-job-42');
      expect(result.monitors.find((m) => m.id === unbound.id)?.gateway_job_id).toBeNull();
    });

    it('leaves monitors bound to other devices and other source types untouched', () => {
      const doomed = svc.createDevice({ name: 'Doomed', kind: 'camera', driver: 'rtsp' });
      const keeper = svc.createDevice({ name: 'Keeper', kind: 'camera', driver: 'rtsp' });
      const otherDevice = makeDeviceMonitor(keeper.id, 'gw-keep');
      // A non-device monitor whose target happens to equal the deleted device id
      // (arxiv targets are free-form strings — the id alone must not match).
      const sameTargetOtherType = monitors.create({
        name: 'arXiv watch',
        source_type: 'arxiv',
        target: doomed.id,
      });

      const result = svc.deleteDevice(doomed.id);

      expect(result.monitors).toHaveLength(0);
      expect(monitors.get(otherDevice.id).id).toBe(otherDevice.id);
      expect(monitors.get(sameTargetOtherType.id).id).toBe(sameTargetOtherType.id);
    });

    it('is silent (and reports deleted=false) for an unknown device', () => {
      const result = svc.deleteDevice('no-such-device');
      expect(result).toEqual({ deleted: false, monitors: [] });
    });

    it('rolls back the device delete when the monitor cascade fails', () => {
      const dev = svc.createDevice({ name: 'Cam', kind: 'camera', driver: 'rtsp' });
      makeDeviceMonitor(dev.id);
      // Make the cascade's UPDATE/DELETE on rc_monitors fail mid-transaction.
      db.exec('CREATE TRIGGER rc_i3_boom BEFORE DELETE ON rc_monitors BEGIN SELECT RAISE(ABORT, \'boom\'); END');
      try {
        expect(() => svc.deleteDevice(dev.id)).toThrow(/boom/);
        // The device must still be there — a half-applied delete is the orphan
        // state this fix exists to prevent.
        expect(svc.getDevice(dev.id)).not.toBeNull();
      } finally {
        db.exec('DROP TRIGGER rc_i3_boom');
      }
    });
  });
});
