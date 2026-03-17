/**
 * Research-Claw Core — Version-based Migration Runner
 *
 * Manages schema evolution for the local SQLite database.
 *
 * Strategy:
 *   - If the `rc_schema_version` table does not exist, the database is
 *     brand new — apply the full v1 schema (all tables, indexes, FTS,
 *     triggers) inside a single transaction and record version 1.
 *   - If it exists, read the current version and apply any incremental
 *     migrations whose version number is higher.
 *   - Each migration runs inside its own transaction for atomicity.
 */

import type BetterSqlite3 from 'better-sqlite3';

import {
  SCHEMA_VERSION,
  CREATE_TABLES_SQL,
  CREATE_INDEXES_SQL,
  CREATE_FTS_SQL,
  CREATE_TRIGGERS_SQL,
} from './schema.js';

// ── Types ───────────────────────────────────────────────────────────

interface SchemaVersionRow {
  version: number;
}

interface TableExistsRow {
  cnt: number;
}

/** A single incremental migration step. */
interface Migration {
  /** Target version number (must be > previous version). */
  version: number;
  /** Human-readable name for logging / tracking. */
  name: string;
  /** SQL statements to apply. Empty string means no-op (e.g. v1 initial). */
  sql: string;
}

// ── Migration registry ──────────────────────────────────────────────
//
// Version 1 is the initial schema — it is applied via the full DDL
// arrays rather than through this list, so its `sql` is empty.
// Append future migrations here with incrementing version numbers.

const MIGRATIONS: readonly Migration[] = [
  {
    version: 2,
    name: 'add_radar_config',
    sql: `CREATE TABLE IF NOT EXISTS rc_radar_config (
  id         TEXT PRIMARY KEY DEFAULT 'default',
  keywords   TEXT NOT NULL DEFAULT '[]',
  authors    TEXT NOT NULL DEFAULT '[]',
  journals   TEXT NOT NULL DEFAULT '[]',
  sources    TEXT NOT NULL DEFAULT '["arxiv","semantic_scholar"]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);`,
  },
  {
    version: 3,
    name: 'add_agent_notifications',
    sql: `CREATE TABLE IF NOT EXISTS rc_agent_notifications (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL DEFAULT 'system',
  title      TEXT NOT NULL,
  body       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read       INTEGER NOT NULL DEFAULT 0
);`,
  },
  {
    version: 4,
    name: 'add_task_related_file_path',
    sql: `ALTER TABLE rc_tasks ADD COLUMN related_file_path TEXT;`,
  },
  {
    version: 5,
    name: 'add_cron_state_schedule',
    sql: `ALTER TABLE rc_cron_state ADD COLUMN schedule TEXT;`,
  },
  {
    version: 6,
    name: 'add_radar_scan_cache',
    sql: [
      `ALTER TABLE rc_radar_config ADD COLUMN last_scan_at TEXT;`,
      `ALTER TABLE rc_radar_config ADD COLUMN last_scan_results TEXT;`,
    ].join('\n'),
  },
  {
    version: 7,
    name: 'add_paper_academic_fields',
    sql: [
      // 11 new academic metadata columns
      `ALTER TABLE rc_papers ADD COLUMN keywords TEXT DEFAULT '[]';`,
      `ALTER TABLE rc_papers ADD COLUMN language TEXT;`,
      `ALTER TABLE rc_papers ADD COLUMN paper_type TEXT;`,
      `ALTER TABLE rc_papers ADD COLUMN volume TEXT;`,
      `ALTER TABLE rc_papers ADD COLUMN issue TEXT;`,
      `ALTER TABLE rc_papers ADD COLUMN pages TEXT;`,
      `ALTER TABLE rc_papers ADD COLUMN publisher TEXT;`,
      `ALTER TABLE rc_papers ADD COLUMN issn TEXT;`,
      `ALTER TABLE rc_papers ADD COLUMN isbn TEXT;`,
      `ALTER TABLE rc_papers ADD COLUMN discipline TEXT;`,
      `ALTER TABLE rc_papers ADD COLUMN citation_count INTEGER;`,
      // Indexes for new columns
      `CREATE INDEX IF NOT EXISTS idx_rc_papers_language ON rc_papers(language);`,
      `CREATE INDEX IF NOT EXISTS idx_rc_papers_paper_type ON rc_papers(paper_type);`,
      `CREATE INDEX IF NOT EXISTS idx_rc_papers_discipline ON rc_papers(discipline);`,
      `CREATE INDEX IF NOT EXISTS idx_rc_papers_isbn ON rc_papers(isbn);`,
      // Rebuild FTS5 with keywords column (FTS5 does not support ALTER)
      `DROP TABLE IF EXISTS rc_papers_fts;`,
      `CREATE VIRTUAL TABLE rc_papers_fts USING fts5(title, authors, abstract, notes, keywords, content='rc_papers', content_rowid='rowid');`,
      `DROP TRIGGER IF EXISTS rc_papers_fts_insert;`,
      `CREATE TRIGGER rc_papers_fts_insert AFTER INSERT ON rc_papers BEGIN INSERT INTO rc_papers_fts(rowid, title, authors, abstract, notes, keywords) VALUES (new.rowid, new.title, new.authors, new.abstract, new.notes, new.keywords); END;`,
      `DROP TRIGGER IF EXISTS rc_papers_fts_update;`,
      `CREATE TRIGGER rc_papers_fts_update AFTER UPDATE ON rc_papers BEGIN INSERT INTO rc_papers_fts(rc_papers_fts, rowid, title, authors, abstract, notes, keywords) VALUES ('delete', old.rowid, old.title, old.authors, old.abstract, old.notes, old.keywords); INSERT INTO rc_papers_fts(rowid, title, authors, abstract, notes, keywords) VALUES (new.rowid, new.title, new.authors, new.abstract, new.notes, new.keywords); END;`,
      `DROP TRIGGER IF EXISTS rc_papers_fts_delete;`,
      `CREATE TRIGGER rc_papers_fts_delete BEFORE DELETE ON rc_papers BEGIN INSERT INTO rc_papers_fts(rc_papers_fts, rowid, title, authors, abstract, notes, keywords) VALUES ('delete', old.rowid, old.title, old.authors, old.abstract, old.notes, old.keywords); END;`,
      // Rebuild FTS index to include existing data
      `INSERT INTO rc_papers_fts(rc_papers_fts) VALUES('rebuild');`,
    ].join('\n'),
  },
];

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Check whether the `rc_schema_version` table exists in the database.
 */
function schemaVersionTableExists(db: BetterSqlite3.Database): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM sqlite_master
       WHERE type = 'table' AND name = 'rc_schema_version'`
    )
    .get() as TableExistsRow | undefined;

  return row !== undefined && row.cnt > 0;
}

/**
 * Apply the complete v1 schema: all tables, indexes, FTS virtual
 * table, and sync triggers. Runs inside a transaction.
 */
function applyFullSchema(db: BetterSqlite3.Database): void {
  const applyInTransaction = db.transaction(() => {
    // 1. Create all tables (includes rc_schema_version)
    for (const sql of CREATE_TABLES_SQL) {
      db.exec(sql);
    }

    // 2. Create indexes
    for (const sql of CREATE_INDEXES_SQL) {
      db.exec(sql);
    }

    // 3. Create FTS5 virtual table
    for (const sql of CREATE_FTS_SQL) {
      db.exec(sql);
    }

    // 4. Create FTS sync triggers
    for (const sql of CREATE_TRIGGERS_SQL) {
      db.exec(sql);
    }

    // 5. Record version 1
    db.prepare(
      `INSERT INTO rc_schema_version (version, applied_at) VALUES (?, datetime('now'))`
    ).run(SCHEMA_VERSION);
  });

  applyInTransaction();
}

/**
 * Apply a single incremental migration inside a transaction.
 */
function applyMigration(db: BetterSqlite3.Database, migration: Migration): void {
  const applyInTransaction = db.transaction(() => {
    if (migration.sql.length > 0) {
      db.exec(migration.sql);
    }

    db.prepare(
      `INSERT INTO rc_schema_version (version, applied_at) VALUES (?, datetime('now'))`
    ).run(migration.version);
  });

  applyInTransaction();
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Return the current schema version recorded in `rc_schema_version`.
 * Returns `0` if the table does not exist or is empty.
 */
export function getCurrentVersion(db: BetterSqlite3.Database): number {
  if (!schemaVersionTableExists(db)) {
    return 0;
  }

  const row = db
    .prepare(
      `SELECT version FROM rc_schema_version ORDER BY version DESC LIMIT 1`
    )
    .get() as SchemaVersionRow | undefined;

  return row?.version ?? 0;
}

/**
 * Run all pending migrations on the provided database connection.
 *
 * - If the database has never been initialized (no `rc_schema_version`
 *   table), apply the full v1 DDL and record version 1.
 * - Then apply any incremental migrations whose version exceeds the
 *   current recorded version.
 */
export function runMigrations(db: BetterSqlite3.Database): void {
  const currentVersion = getCurrentVersion(db);

  if (currentVersion === 0) {
    // Brand-new database — apply full initial schema
    applyFullSchema(db);
  }

  // Re-read version after potential full-schema apply
  const versionAfterInit = getCurrentVersion(db);

  // Apply incremental migrations
  for (const migration of MIGRATIONS) {
    if (migration.version > versionAfterInit) {
      applyMigration(db, migration);
    }
  }
}
