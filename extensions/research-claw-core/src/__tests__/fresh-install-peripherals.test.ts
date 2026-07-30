/**
 * Peripherals schema regression tests (v16 tables + v17 local-camera driver).
 *
 * Mirrors fresh-install-paper-reviews.test.ts harness:
 * - runMigrations on empty DB → applyFullSchema (fresh install path)
 * - runMigrations on a v15 DB (all prior tables present, version=15) → incremental v16+v17 migrations
 * - runMigrations on a v16 DB (old driver CHECK) → incremental v17 widens the driver enum
 *
 * All paths must produce rc_periph_devices + rc_periph_observations, and the
 * driver CHECK must admit 'local-camera' after v17 (§15 v1.3 场景②).
 */

import { createRequire } from 'node:module';
import type BetterSqlite3 from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

import { runMigrations, getCurrentVersion } from '../db/migrations.js';
import { SCHEMA_VERSION } from '../db/schema.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof BetterSqlite3;

function tableNames(db: BetterSqlite3.Database): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

/**
 * Build a minimal v15 database to test the incremental migration path.
 *
 * applyFullSchema writes SCHEMA_VERSION directly as a single row (currently
 * 17), so there is no "version 15 row" to roll back to in the normal flow.
 * Instead, we construct the rc_schema_version table manually with version=15
 * and create rc_periph_devices' prerequisite tables (none required for the
 * v16 DDL itself since REFERENCES only enforces at runtime with FK pragma ON).
 *
 * runMigrations will then see currentVersion=15, skip applyFullSchema, and
 * apply the v16 + v17 migration entries.
 */
function buildV15Database(): BetterSqlite3.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  // Minimal stub: schema version table with version=15 recorded.
  // The v16 migration SQL uses CREATE TABLE IF NOT EXISTS and CREATE INDEX IF
  // NOT EXISTS, so it is safe to run even without the full schema in place.
  // We also skip FK enforcement during construction (already OFF by default
  // for fresh connections; we turn it ON after setup).
  db.exec(`
    CREATE TABLE IF NOT EXISTS rc_schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO rc_schema_version (version) VALUES (15);
  `);

  return db;
}

/**
 * Build a v16 database with the OLD driver CHECK (no 'local-camera') plus seed
 * rows, to exercise the v17 rebuild migration: rows must survive and the driver
 * enum must widen to admit 'local-camera'.
 */
function buildV16Database(): BetterSqlite3.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS rc_schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    -- v16 devices table with the pre-v17 (narrow) driver CHECK.
    CREATE TABLE rc_periph_devices (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      kind          TEXT NOT NULL CHECK(kind IN ('camera','audio-recorder','lab-instrument','embodied')),
      driver        TEXT NOT NULL CHECK(driver IN ('browser-camera','mcp-plaud','rtsp','oc-node')),
      enabled       INTEGER NOT NULL DEFAULT 1,
      config        TEXT NOT NULL DEFAULT '{}',
      check_prompt  TEXT NOT NULL DEFAULT '',
      last_seen_at  TEXT,
      last_error    TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE rc_periph_observations (
      id           TEXT PRIMARY KEY,
      device_id    TEXT NOT NULL REFERENCES rc_periph_devices(id) ON DELETE CASCADE,
      monitor_id   TEXT,
      kind         TEXT NOT NULL CHECK(kind IN ('snapshot','check','note')),
      verdict      TEXT NOT NULL DEFAULT 'info' CHECK(verdict IN ('ok','alert','info','unverified','missed','error')),
      summary      TEXT NOT NULL DEFAULT '',
      frame_path   TEXT,
      result_json  TEXT NOT NULL DEFAULT '{}',
      captured_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO rc_schema_version (version) VALUES (15);
    INSERT INTO rc_schema_version (version) VALUES (16);
    INSERT INTO rc_periph_devices (id, name, kind, driver) VALUES ('keep-cam', 'Existing Cam', 'camera', 'rtsp');
    INSERT INTO rc_periph_observations (id, device_id, kind, summary) VALUES ('keep-obs', 'keep-cam', 'snapshot', 'pre-v17');
  `);
  return db;
}

describe('peripherals schema (v16 tables + v17 local-camera)', () => {
  it('SCHEMA_VERSION includes all migrations through prompt presets', () => {
    expect(SCHEMA_VERSION).toBe(19);
  });

  it('fresh install (empty DB) creates both periph tables', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    const names = tableNames(db);
    expect(names).toContain('rc_periph_devices');
    expect(names).toContain('rc_periph_observations');
    expect(getCurrentVersion(db)).toBe(SCHEMA_VERSION);

    db.close();
  });

  it('migration from v15 creates both periph tables and reaches v17', () => {
    const db = buildV15Database();

    expect(getCurrentVersion(db)).toBe(15);

    // Apply the v16 + v17 migrations
    runMigrations(db);

    const names = tableNames(db);
    expect(names).toContain('rc_periph_devices');
    expect(names).toContain('rc_periph_observations');
    expect(getCurrentVersion(db)).toBe(SCHEMA_VERSION);

    db.close();
  });

  it('v17 migration widens driver enum, preserves rows + FK cascade', () => {
    const db = buildV16Database();
    expect(getCurrentVersion(db)).toBe(16);

    // The pre-v17 CHECK must reject 'local-camera'.
    expect(() =>
      db
        .prepare(`INSERT INTO rc_periph_devices (id, name, kind, driver) VALUES ('pre', 'x', 'camera', 'local-camera')`)
        .run(),
    ).toThrow();

    runMigrations(db);
    expect(getCurrentVersion(db)).toBe(SCHEMA_VERSION);

    // Existing rows survived the table rebuild.
    expect(
      (db.prepare(`SELECT COUNT(*) c FROM rc_periph_devices WHERE id = 'keep-cam'`).get() as { c: number }).c,
    ).toBe(1);
    expect(
      (db.prepare(`SELECT COUNT(*) c FROM rc_periph_observations WHERE id = 'keep-obs'`).get() as { c: number }).c,
    ).toBe(1);

    // Now 'local-camera' is accepted.
    db.pragma('foreign_keys = ON');
    expect(() =>
      db
        .prepare(`INSERT INTO rc_periph_devices (id, name, kind, driver) VALUES ('lc', 'USB Cam', 'camera', 'local-camera')`)
        .run(),
    ).not.toThrow();

    // The rebuilt child FK still cascades against the rebuilt parent.
    db.prepare(`DELETE FROM rc_periph_devices WHERE id = 'keep-cam'`).run();
    expect(
      (db.prepare(`SELECT COUNT(*) c FROM rc_periph_observations WHERE device_id = 'keep-cam'`).get() as { c: number }).c,
    ).toBe(0);

    db.close();
  });

  it('fresh install driver CHECK admits local-camera', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    expect(() =>
      db
        .prepare(`INSERT INTO rc_periph_devices (id, name, kind, driver) VALUES ('lc1', 'USB Cam', 'camera', 'local-camera')`)
        .run(),
    ).not.toThrow();
    // A bogus driver is still rejected.
    expect(() =>
      db
        .prepare(`INSERT INTO rc_periph_devices (id, name, kind, driver) VALUES ('bad', 'x', 'camera', 'bogus-driver')`)
        .run(),
    ).toThrow();
    db.close();
  });

  it('observation cascades on device delete and enforces verdict enum', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    db
      .prepare(
        `INSERT INTO rc_periph_devices (id, name, kind, driver) VALUES ('d1', 'cam', 'camera', 'browser-camera')`,
      )
      .run();

    db
      .prepare(
        `INSERT INTO rc_periph_observations (id, device_id, kind) VALUES ('o1', 'd1', 'snapshot')`,
      )
      .run();

    // Invalid verdict enum should throw
    expect(() =>
      db
        .prepare(
          `INSERT INTO rc_periph_observations (id, device_id, kind, verdict) VALUES ('o2', 'd1', 'snapshot', 'bogus')`,
        )
        .run(),
    ).toThrow();

    // DELETE CASCADE: deleting device removes all its observations
    db.prepare(`DELETE FROM rc_periph_devices WHERE id = 'd1'`).run();
    expect(
      (db.prepare(`SELECT COUNT(*) c FROM rc_periph_observations`).get() as { c: number }).c,
    ).toBe(0);

    db.close();
  });

  it('enforces kind enum on rc_periph_devices', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    expect(() =>
      db
        .prepare(`INSERT INTO rc_periph_devices (id, name, kind, driver) VALUES ('d2', 'cam', 'bogus-kind', 'browser-camera')`)
        .run(),
    ).toThrow();

    expect(() =>
      db
        .prepare(`INSERT INTO rc_periph_devices (id, name, kind, driver) VALUES ('d3', 'inst', 'lab-instrument', 'mcp-plaud')`)
        .run(),
    ).not.toThrow();

    db.close();
  });

  it('enforces observations.kind enum', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    db
      .prepare(`INSERT INTO rc_periph_devices (id, name, kind, driver) VALUES ('d4', 'mic', 'audio-recorder', 'mcp-plaud')`)
      .run();

    expect(() =>
      db
        .prepare(`INSERT INTO rc_periph_observations (id, device_id, kind) VALUES ('o3', 'd4', 'invalid')`)
        .run(),
    ).toThrow();

    expect(() =>
      db
        .prepare(`INSERT INTO rc_periph_observations (id, device_id, kind) VALUES ('o4', 'd4', 'note')`)
        .run(),
    ).not.toThrow();

    db.close();
  });
});
