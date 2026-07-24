/**
 * Peripherals schema v16 regression tests.
 *
 * Mirrors fresh-install-paper-reviews.test.ts harness:
 * - runMigrations on empty DB → applyFullSchema (fresh install path)
 * - runMigrations on a v15 DB (all prior tables present, version=15) → incremental v16 migration
 *
 * Both paths must produce rc_periph_devices + rc_periph_observations.
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
 * 16), so there is no "version 15 row" to roll back to in the normal flow.
 * Instead, we construct the rc_schema_version table manually with version=15
 * and create rc_periph_devices' prerequisite tables (none required for the
 * v16 DDL itself since REFERENCES only enforces at runtime with FK pragma ON).
 *
 * runMigrations will then see currentVersion=15, skip applyFullSchema, and
 * apply only the v16 migration entry.
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

describe('peripherals schema v16', () => {
  it('SCHEMA_VERSION is 16', () => {
    expect(SCHEMA_VERSION).toBe(16);
  });

  it('fresh install (empty DB) creates both periph tables', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    const names = tableNames(db);
    expect(names).toContain('rc_periph_devices');
    expect(names).toContain('rc_periph_observations');
    expect(getCurrentVersion(db)).toBe(16);

    db.close();
  });

  it('migration from v15 creates both periph tables', () => {
    const db = buildV15Database();

    expect(getCurrentVersion(db)).toBe(15);

    // Apply only the v16 migration
    runMigrations(db);

    const names = tableNames(db);
    expect(names).toContain('rc_periph_devices');
    expect(names).toContain('rc_periph_observations');
    expect(getCurrentVersion(db)).toBe(16);

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
