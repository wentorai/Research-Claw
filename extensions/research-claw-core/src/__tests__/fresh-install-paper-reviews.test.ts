/**
 * Fresh-install schema regression tests.
 *
 * applyFullSchema records SCHEMA_VERSION directly, so incremental migrations
 * never run on a brand-new database. Every table a live service depends on
 * must therefore exist in CREATE_TABLES_SQL with its final (post-migration)
 * shape. This guards the rc_paper_reviews gap (v13/v14 tables missing from
 * the full DDL → `rc.review.*` failed with "no such table" on fresh installs).
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations, getCurrentVersion } from '../db/migrations.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import { PaperReviewService } from '../paper-review/service.js';
import type { WorkspaceService } from '../workspace/service.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof BetterSqlite3;

/** Tables created by migrations for features that no longer have live consumers. */
const LEGACY_MIGRATION_ONLY_TABLES = new Set(['rc_radar_config']);

function tableExists(db: BetterSqlite3.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { cnt: number };
  return row.cnt > 0;
}

describe('fresh install (runMigrations on empty DB)', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('records the current schema version', () => {
    expect(getCurrentVersion(db)).toBe(SCHEMA_VERSION);
  });

  it('creates rc_paper_reviews', () => {
    expect(tableExists(db, 'rc_paper_reviews')).toBe(true);
  });

  it('creates rc_paper_reviews in its final v14 shape (failed status + failure_reason)', () => {
    const columns = new Set(
      (db.pragma('table_info(rc_paper_reviews)') as Array<{ name: string }>).map((c) => c.name),
    );
    expect(columns.has('failure_reason')).toBe(true);

    const insert = db.prepare(`
      INSERT INTO rc_paper_reviews (id, file_path, title, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    `);
    expect(() => insert.run('r-failed', 'sources/a.pdf', 'a', 'failed')).not.toThrow();
    expect(() => insert.run('r-bogus', 'sources/b.pdf', 'b', 'bogus')).toThrow();
  });

  it('creates the rc_paper_reviews indexes', () => {
    const indexes = new Set(
      (db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'rc_paper_reviews'`)
        .all() as Array<{ name: string }>).map((r) => r.name),
    );
    expect(indexes.has('idx_rc_paper_reviews_file')).toBe(true);
    expect(indexes.has('idx_rc_paper_reviews_updated')).toBe(true);
    expect(indexes.has('idx_rc_paper_reviews_status')).toBe(true);
  });

  it('supports the full PaperReviewService lifecycle', () => {
    const workspaceStub = { tree: async () => ({ tree: [] }) } as unknown as WorkspaceService;
    const service = new PaperReviewService(db, workspaceStub);

    const created = service.create({ file_path: 'sources/paper.pdf', title: 'Test Paper' });
    expect(created.status).toBe('draft');

    const failed = service.update(created.id, { status: 'failed', failure_reason: 'timed out' });
    expect(failed.status).toBe('failed');
    expect(failed.failure_reason).toBe('timed out');

    const completed = service.update(created.id, {
      status: 'completed',
      overall_score: 7,
      report_markdown: '# Review',
      failure_reason: null,
    });
    expect(completed.overall_score).toBe(7);

    expect(service.list().total).toBe(1);
    expect(service.delete(created.id)).toBe(true);
  });

  it('contains every table migrations create, except legacy migration-only tables', () => {
    const migrationsSource = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/migrations.ts'),
      'utf8',
    );
    const migrationTables = new Set(
      [...migrationsSource.matchAll(/CREATE TABLE IF NOT EXISTS (rc_\w+)/g)].map((m) => m[1]),
    );
    expect(migrationTables.size).toBeGreaterThan(0);

    for (const table of migrationTables) {
      if (LEGACY_MIGRATION_ONLY_TABLES.has(table)) continue;
      expect(tableExists(db, table), `fresh install missing table: ${table}`).toBe(true);
    }
  });
});
