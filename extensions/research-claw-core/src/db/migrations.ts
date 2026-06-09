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
  /** Optional programmatic migration (takes precedence over sql when present). */
  fn?: (db: BetterSqlite3.Database) => void;
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
  sources    TEXT NOT NULL DEFAULT '["arxiv"]',
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
    name: 'add_heartbeat_log',
    sql: `CREATE TABLE IF NOT EXISTS rc_heartbeat_log (
  task_id       TEXT PRIMARY KEY REFERENCES rc_tasks(id) ON DELETE CASCADE,
  current_tier  TEXT NOT NULL DEFAULT 'silent',
  last_notified TEXT,
  notify_count  INTEGER NOT NULL DEFAULT 0,
  escalated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  suppressed    INTEGER NOT NULL DEFAULT 0
);`,
  },
  {
    version: 8,
    name: 'add_monitors',
    sql: [
      `CREATE TABLE IF NOT EXISTS rc_monitors (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  source_type     TEXT NOT NULL,
  target          TEXT NOT NULL DEFAULT '',
  filters         TEXT NOT NULL DEFAULT '{}',
  schedule        TEXT NOT NULL DEFAULT '0 8 * * *',
  enabled         INTEGER NOT NULL DEFAULT 1,
  notify          INTEGER NOT NULL DEFAULT 1,
  agent_prompt    TEXT NOT NULL DEFAULT '',
  gateway_job_id  TEXT,
  last_check_at   TEXT,
  last_results    TEXT,
  last_error      TEXT,
  check_count     INTEGER NOT NULL DEFAULT 0,
  finding_count   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);`,
      `CREATE INDEX IF NOT EXISTS idx_rc_monitors_enabled     ON rc_monitors(enabled);`,
      `CREATE INDEX IF NOT EXISTS idx_rc_monitors_source_type ON rc_monitors(source_type);`,
    ].join('\n'),
  },
  {
    version: 9,
    name: 'add_paper_academic_fields',
    sql: '',
    // Programmatic migration: ALTER TABLE ADD COLUMN is not idempotent in SQLite,
    // so we check column existence before each ALTER to survive partial retries.
    fn: (db) => {
      const existing = new Set(
        (db.pragma('table_info(rc_papers)') as Array<{ name: string }>).map((c) => c.name),
      );
      const columns: Array<[string, string]> = [
        ['keywords', "TEXT DEFAULT '[]'"],
        ['language', 'TEXT'],
        ['paper_type', 'TEXT'],
        ['volume', 'TEXT'],
        ['issue', 'TEXT'],
        ['pages', 'TEXT'],
        ['publisher', 'TEXT'],
        ['issn', 'TEXT'],
        ['isbn', 'TEXT'],
        ['discipline', 'TEXT'],
        ['citation_count', 'INTEGER'],
      ];
      for (const [name, type] of columns) {
        if (!existing.has(name)) {
          db.exec(`ALTER TABLE rc_papers ADD COLUMN ${name} ${type};`);
        }
      }
      // Indexes + FTS rebuild (all idempotent via IF NOT EXISTS / DROP IF EXISTS)
      db.exec([
        `CREATE INDEX IF NOT EXISTS idx_rc_papers_language ON rc_papers(language);`,
        `CREATE INDEX IF NOT EXISTS idx_rc_papers_paper_type ON rc_papers(paper_type);`,
        `CREATE INDEX IF NOT EXISTS idx_rc_papers_discipline ON rc_papers(discipline);`,
        `CREATE INDEX IF NOT EXISTS idx_rc_papers_isbn ON rc_papers(isbn);`,
        `DROP TABLE IF EXISTS rc_papers_fts;`,
        `CREATE VIRTUAL TABLE rc_papers_fts USING fts5(title, authors, abstract, notes, keywords, content='rc_papers', content_rowid='rowid');`,
        `DROP TRIGGER IF EXISTS rc_papers_fts_insert;`,
        `CREATE TRIGGER rc_papers_fts_insert AFTER INSERT ON rc_papers BEGIN INSERT INTO rc_papers_fts(rowid, title, authors, abstract, notes, keywords) VALUES (new.rowid, new.title, new.authors, new.abstract, new.notes, new.keywords); END;`,
        `DROP TRIGGER IF EXISTS rc_papers_fts_update;`,
        `CREATE TRIGGER rc_papers_fts_update AFTER UPDATE ON rc_papers BEGIN INSERT INTO rc_papers_fts(rc_papers_fts, rowid, title, authors, abstract, notes, keywords) VALUES ('delete', old.rowid, old.title, old.authors, old.abstract, old.notes, old.keywords); INSERT INTO rc_papers_fts(rowid, title, authors, abstract, notes, keywords) VALUES (new.rowid, new.title, new.authors, new.abstract, new.notes, new.keywords); END;`,
        `DROP TRIGGER IF EXISTS rc_papers_fts_delete;`,
        `CREATE TRIGGER rc_papers_fts_delete BEFORE DELETE ON rc_papers BEGIN INSERT INTO rc_papers_fts(rc_papers_fts, rowid, title, authors, abstract, notes, keywords) VALUES ('delete', old.rowid, old.title, old.authors, old.abstract, old.notes, old.keywords); END;`,
        `INSERT INTO rc_papers_fts(rc_papers_fts) VALUES('rebuild');`,
      ].join('\n'));
    },
  },
  {
    version: 10,
    name: 'add_monitor_memory',
    sql: `ALTER TABLE rc_monitors ADD COLUMN memory TEXT NOT NULL DEFAULT '{"v":1,"seen":[],"runs":[],"notes":""}';`,
  },
  {
    version: 11,
    name: 'add_memory_tables',
    sql: [
      `CREATE TABLE IF NOT EXISTS rc_memories (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL CHECK(type IN ('user', 'feedback', 'project', 'reference', 'agent')),
  name            TEXT NOT NULL,
  description     TEXT,
  content         TEXT NOT NULL,
  metadata        TEXT DEFAULT '{}',
  related_paper_id TEXT REFERENCES rc_papers(id) ON DELETE SET NULL,
  related_task_id  TEXT REFERENCES rc_tasks(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  accessed_at     TEXT,
  access_count    INTEGER DEFAULT 0,
  is_active       INTEGER DEFAULT 1,
  is_private      INTEGER DEFAULT 0
);`,
      `CREATE TABLE IF NOT EXISTS rc_memory_tags (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  color     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`,
      `CREATE TABLE IF NOT EXISTS rc_memory_tag_links (
  memory_id TEXT NOT NULL REFERENCES rc_memories(id) ON DELETE CASCADE,
  tag_id    TEXT NOT NULL REFERENCES rc_memory_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, tag_id)
);`,
      `CREATE TABLE IF NOT EXISTS rc_memory_links (
  id              TEXT PRIMARY KEY,
  from_memory_id  TEXT NOT NULL REFERENCES rc_memories(id) ON DELETE CASCADE,
  to_memory_id    TEXT NOT NULL REFERENCES rc_memories(id) ON DELETE CASCADE,
  context         TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(from_memory_id, to_memory_id)
);`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS rc_memories_fts USING fts5(
  name,
  description,
  content,
  content='rc_memories',
  content_rowid='rowid'
);`,
      `CREATE INDEX IF NOT EXISTS idx_rc_memories_type           ON rc_memories(type);`,
      `CREATE INDEX IF NOT EXISTS idx_rc_memories_active         ON rc_memories(is_active);`,
      `CREATE INDEX IF NOT EXISTS idx_rc_memories_private        ON rc_memories(is_private);`,
      `CREATE INDEX IF NOT EXISTS idx_rc_memories_paper          ON rc_memories(related_paper_id);`,
      `CREATE INDEX IF NOT EXISTS idx_rc_memories_task           ON rc_memories(related_task_id);`,
      `CREATE INDEX IF NOT EXISTS idx_rc_memories_accessed       ON rc_memories(accessed_at);`,
      `CREATE INDEX IF NOT EXISTS idx_rc_memories_access_count   ON rc_memories(access_count);`,
      `CREATE INDEX IF NOT EXISTS idx_rc_memory_tag_links_memory ON rc_memory_tag_links(memory_id);`,
      `CREATE INDEX IF NOT EXISTS idx_rc_memory_tag_links_tag    ON rc_memory_tag_links(tag_id);`,
      `CREATE INDEX IF NOT EXISTS idx_rc_memory_links_from       ON rc_memory_links(from_memory_id);`,
      `CREATE INDEX IF NOT EXISTS idx_rc_memory_links_to         ON rc_memory_links(to_memory_id);`,
      `CREATE TRIGGER IF NOT EXISTS rc_memories_fts_insert AFTER INSERT ON rc_memories BEGIN INSERT INTO rc_memories_fts(rowid, name, description, content) VALUES (new.rowid, new.name, new.description, new.content); END;`,
      `CREATE TRIGGER IF NOT EXISTS rc_memories_fts_update AFTER UPDATE ON rc_memories BEGIN INSERT INTO rc_memories_fts(rc_memories_fts, rowid, name, description, content) VALUES ('delete', old.rowid, old.name, old.description, old.content); INSERT INTO rc_memories_fts(rowid, name, description, content) VALUES (new.rowid, new.name, new.description, new.content); END;`,
      `CREATE TRIGGER IF NOT EXISTS rc_memories_fts_delete BEFORE DELETE ON rc_memories BEGIN INSERT INTO rc_memories_fts(rc_memories_fts, rowid, name, description, content) VALUES ('delete', old.rowid, old.name, old.description, old.content); END;`,
    ].join('\n'),
  },
  {
    version: 12,
    name: 'add_session_monitoring',
    sql: [
      `CREATE TABLE IF NOT EXISTS rc_sessions (
  id                  TEXT PRIMARY KEY,
  started_at          TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at            TEXT,
  events_count        INTEGER NOT NULL DEFAULT 0,
  memories_extracted  INTEGER NOT NULL DEFAULT 0,
  metadata            TEXT DEFAULT '{}'
);`,
      `CREATE TABLE IF NOT EXISTS rc_session_events (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES rc_sessions(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL CHECK(event_type IN ('session_start', 'user_prompt', 'tool_use', 'assistant_response', 'session_end')),
  timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
  data        TEXT NOT NULL DEFAULT '{}'
);`,
      `CREATE INDEX IF NOT EXISTS idx_rc_sessions_started       ON rc_sessions(started_at);`,
      `CREATE INDEX IF NOT EXISTS idx_rc_sessions_ended         ON rc_sessions(ended_at);`,
      `CREATE INDEX IF NOT EXISTS idx_rc_session_events_session  ON rc_session_events(session_id);`,
      `CREATE INDEX IF NOT EXISTS idx_rc_session_events_type     ON rc_session_events(event_type);`,
      `CREATE INDEX IF NOT EXISTS idx_rc_session_events_timestamp ON rc_session_events(timestamp);`,
    ].join('\n'),
  },
  {
    version: 13,
    name: 'add_paper_reviews',
    sql: [
      `CREATE TABLE IF NOT EXISTS rc_paper_reviews (
  id              TEXT PRIMARY KEY,
  file_path       TEXT NOT NULL,
  paper_id        TEXT REFERENCES rc_papers(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK(status IN ('draft', 'in_progress', 'completed')),
  overall_score   INTEGER CHECK(overall_score IS NULL OR (overall_score BETWEEN 1 AND 10)),
  summary         TEXT,
  strengths       TEXT,
  weaknesses      TEXT,
  suggestions     TEXT,
  report_markdown TEXT,
  rubric          TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);`,
      `CREATE INDEX IF NOT EXISTS idx_rc_paper_reviews_file    ON rc_paper_reviews(file_path);`,
      `CREATE INDEX IF NOT EXISTS idx_rc_paper_reviews_updated ON rc_paper_reviews(updated_at);`,
      `CREATE INDEX IF NOT EXISTS idx_rc_paper_reviews_status  ON rc_paper_reviews(status);`,
    ].join('\n'),
  },
  {
    version: 14,
    name: 'paper_reviews_failed_status',
    sql: '',
    fn: (db) => {
      db.exec(`
        CREATE TABLE rc_paper_reviews_v14 (
          id              TEXT PRIMARY KEY,
          file_path       TEXT NOT NULL,
          paper_id        TEXT REFERENCES rc_papers(id) ON DELETE SET NULL,
          title           TEXT NOT NULL,
          status          TEXT NOT NULL DEFAULT 'draft'
                            CHECK(status IN ('draft', 'in_progress', 'completed', 'failed')),
          overall_score   INTEGER CHECK(overall_score IS NULL OR (overall_score BETWEEN 1 AND 10)),
          summary         TEXT,
          strengths       TEXT,
          weaknesses      TEXT,
          suggestions     TEXT,
          report_markdown TEXT,
          rubric          TEXT,
          failure_reason  TEXT,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL
        );
        INSERT INTO rc_paper_reviews_v14 (
          id, file_path, paper_id, title, status, overall_score,
          summary, strengths, weaknesses, suggestions, report_markdown, rubric,
          failure_reason, created_at, updated_at
        )
        SELECT
          id, file_path, paper_id, title, status, overall_score,
          summary, strengths, weaknesses, suggestions, report_markdown, rubric,
          NULL, created_at, updated_at
        FROM rc_paper_reviews;
        DROP TABLE rc_paper_reviews;
        ALTER TABLE rc_paper_reviews_v14 RENAME TO rc_paper_reviews;
        CREATE INDEX IF NOT EXISTS idx_rc_paper_reviews_file    ON rc_paper_reviews(file_path);
        CREATE INDEX IF NOT EXISTS idx_rc_paper_reviews_updated ON rc_paper_reviews(updated_at);
        CREATE INDEX IF NOT EXISTS idx_rc_paper_reviews_status  ON rc_paper_reviews(status);
      `);
    },
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
    if (migration.fn) {
      migration.fn(db);
    } else if (migration.sql.length > 0) {
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
