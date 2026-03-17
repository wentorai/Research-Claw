/**
 * Research-Claw Core — SQLite Schema DDL
 *
 * 12 tables + FTS5 virtual table + triggers + indexes.
 * All table names prefixed with `rc_` to avoid collision with OpenClaw internals.
 *
 * Tables:
 *   1. rc_schema_version  — Migration version tracking
 *   2. rc_papers           — Paper metadata
 *   3. rc_tags             — Tag definitions
 *   4. rc_paper_tags       — Paper–tag junction
 *   5. rc_collections      — Named paper collections
 *   6. rc_collection_papers — Collection–paper junction
 *   7. rc_smart_groups     — Dynamic filter groups (saved queries)
 *   8. rc_reading_sessions — Reading time tracking
 *   9. rc_citations        — Inter-paper citation links
 *  10. rc_paper_notes      — Annotation notes on papers
 *  11. rc_tasks            — Task items (deadline-sorted)
 *  12. rc_activity_log     — Event tracking / audit log
 *
 * FTS5: rc_papers_fts (title, authors, abstract, notes, keywords)
 */

// ── Current schema version ──────────────────────────────────────────
export const SCHEMA_VERSION = 7;

// ── CREATE TABLE statements ─────────────────────────────────────────

const RC_SCHEMA_VERSION = `
CREATE TABLE IF NOT EXISTS rc_schema_version (
  version    INTEGER NOT NULL,
  applied_at TEXT    NOT NULL
);`;

const RC_PAPERS = `
CREATE TABLE IF NOT EXISTS rc_papers (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  authors         TEXT NOT NULL DEFAULT '[]',
  abstract        TEXT,
  doi             TEXT UNIQUE,
  url             TEXT,
  arxiv_id        TEXT,
  pdf_path        TEXT,
  source          TEXT,
  source_id       TEXT,
  venue           TEXT,
  year            INTEGER,
  added_at        TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  read_status     TEXT NOT NULL DEFAULT 'unread'
                    CHECK(read_status IN ('unread', 'reading', 'read', 'reviewed')),
  rating          INTEGER CHECK(rating IS NULL OR (rating BETWEEN 1 AND 5)),
  notes           TEXT,
  bibtex_key      TEXT,
  metadata        TEXT DEFAULT '{}',
  keywords        TEXT DEFAULT '[]',
  language        TEXT,
  paper_type      TEXT CHECK(paper_type IS NULL OR paper_type IN (
                    'journal_article', 'conference_paper', 'preprint', 'thesis',
                    'book', 'book_chapter', 'report', 'patent', 'dataset', 'other')),
  volume          TEXT,
  issue           TEXT,
  pages           TEXT,
  publisher       TEXT,
  issn            TEXT,
  isbn            TEXT,
  discipline      TEXT,
  citation_count  INTEGER
);`;

const RC_TAGS = `
CREATE TABLE IF NOT EXISTS rc_tags (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT,
  created_at TEXT NOT NULL
);`;

const RC_PAPER_TAGS = `
CREATE TABLE IF NOT EXISTS rc_paper_tags (
  paper_id TEXT NOT NULL REFERENCES rc_papers(id) ON DELETE CASCADE,
  tag_id   TEXT NOT NULL REFERENCES rc_tags(id)   ON DELETE CASCADE,
  PRIMARY KEY (paper_id, tag_id)
);`;

const RC_COLLECTIONS = `
CREATE TABLE IF NOT EXISTS rc_collections (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  color       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);`;

const RC_COLLECTION_PAPERS = `
CREATE TABLE IF NOT EXISTS rc_collection_papers (
  collection_id TEXT NOT NULL REFERENCES rc_collections(id) ON DELETE CASCADE,
  paper_id      TEXT NOT NULL REFERENCES rc_papers(id)      ON DELETE CASCADE,
  added_at      TEXT    NOT NULL,
  sort_order    INTEGER DEFAULT 0,
  PRIMARY KEY (collection_id, paper_id)
);`;

const RC_SMART_GROUPS = `
CREATE TABLE IF NOT EXISTS rc_smart_groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  query_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;

const RC_READING_SESSIONS = `
CREATE TABLE IF NOT EXISTS rc_reading_sessions (
  id               TEXT PRIMARY KEY,
  paper_id         TEXT    NOT NULL REFERENCES rc_papers(id) ON DELETE CASCADE,
  started_at       TEXT    NOT NULL,
  ended_at         TEXT,
  duration_minutes INTEGER,
  notes            TEXT,
  pages_read       INTEGER
);`;

const RC_CITATIONS = `
CREATE TABLE IF NOT EXISTS rc_citations (
  citing_paper_id TEXT NOT NULL REFERENCES rc_papers(id) ON DELETE CASCADE,
  cited_paper_id  TEXT NOT NULL REFERENCES rc_papers(id) ON DELETE CASCADE,
  context         TEXT,
  section         TEXT,
  PRIMARY KEY (citing_paper_id, cited_paper_id)
);`;

const RC_PAPER_NOTES = `
CREATE TABLE IF NOT EXISTS rc_paper_notes (
  id         TEXT PRIMARY KEY,
  paper_id   TEXT NOT NULL REFERENCES rc_papers(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  page       INTEGER,
  highlight  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`;

const RC_TASKS = `
CREATE TABLE IF NOT EXISTS rc_tasks (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  description      TEXT,
  task_type        TEXT NOT NULL CHECK(task_type IN ('human', 'agent', 'mixed')),
  status           TEXT NOT NULL DEFAULT 'todo'
                        CHECK(status IN ('todo', 'in_progress', 'blocked', 'done', 'cancelled')),
  priority         TEXT NOT NULL DEFAULT 'medium'
                        CHECK(priority IN ('urgent', 'high', 'medium', 'low')),
  deadline         TEXT,
  completed_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  parent_task_id   TEXT REFERENCES rc_tasks(id)  ON DELETE SET NULL,
  related_paper_id TEXT REFERENCES rc_papers(id) ON DELETE SET NULL,
  related_file_path TEXT,
  agent_session_id TEXT,
  tags             TEXT,
  notes            TEXT
);`;
// Note: related_file_path added in v4 migration for existing DBs.
// New installs get it from this DDL directly.

const RC_ACTIVITY_LOG = `
CREATE TABLE IF NOT EXISTS rc_activity_log (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES rc_tasks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  actor      TEXT NOT NULL CHECK(actor IN ('human', 'agent')),
  created_at TEXT NOT NULL
);`;

const RC_RADAR_CONFIG = `
CREATE TABLE IF NOT EXISTS rc_radar_config (
  id                TEXT PRIMARY KEY DEFAULT 'default',
  keywords          TEXT NOT NULL DEFAULT '[]',
  authors           TEXT NOT NULL DEFAULT '[]',
  journals          TEXT NOT NULL DEFAULT '[]',
  sources           TEXT NOT NULL DEFAULT '["arxiv","semantic_scholar"]',
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  last_scan_at      TEXT,
  last_scan_results TEXT
);`;

const RC_AGENT_NOTIFICATIONS = `
CREATE TABLE IF NOT EXISTS rc_agent_notifications (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL DEFAULT 'system',
  title      TEXT NOT NULL,
  body       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read       INTEGER NOT NULL DEFAULT 0
);`;

const RC_CRON_STATE = `
CREATE TABLE IF NOT EXISTS rc_cron_state (
  preset_id      TEXT PRIMARY KEY,
  enabled        INTEGER NOT NULL DEFAULT 0,
  config         TEXT NOT NULL DEFAULT '{}',
  last_run_at    TEXT,
  next_run_at    TEXT,
  gateway_job_id TEXT,
  schedule       TEXT
);`;

// ── Aggregate table creation list ───────────────────────────────────

export const CREATE_TABLES_SQL: readonly string[] = [
  RC_SCHEMA_VERSION,
  RC_PAPERS,
  RC_TAGS,
  RC_PAPER_TAGS,
  RC_COLLECTIONS,
  RC_COLLECTION_PAPERS,
  RC_SMART_GROUPS,
  RC_READING_SESSIONS,
  RC_CITATIONS,
  RC_PAPER_NOTES,
  RC_TASKS,
  RC_ACTIVITY_LOG,
  RC_RADAR_CONFIG,
  RC_AGENT_NOTIFICATIONS,
  RC_CRON_STATE,
];

// ── Indexes ─────────────────────────────────────────────────────────

export const CREATE_INDEXES_SQL: readonly string[] = [
  // rc_papers indexes
  `CREATE INDEX IF NOT EXISTS idx_rc_papers_doi          ON rc_papers(doi);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_papers_arxiv_id     ON rc_papers(arxiv_id);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_papers_year         ON rc_papers(year);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_papers_read_status  ON rc_papers(read_status);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_papers_added_at     ON rc_papers(added_at);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_papers_source       ON rc_papers(source);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_papers_bibtex_key   ON rc_papers(bibtex_key);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_papers_language     ON rc_papers(language);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_papers_paper_type   ON rc_papers(paper_type);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_papers_discipline   ON rc_papers(discipline);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_papers_isbn         ON rc_papers(isbn);`,

  // rc_reading_sessions indexes
  `CREATE INDEX IF NOT EXISTS idx_rc_reading_sessions_paper   ON rc_reading_sessions(paper_id);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_reading_sessions_started ON rc_reading_sessions(started_at);`,

  // rc_citations indexes
  `CREATE INDEX IF NOT EXISTS idx_rc_citations_citing ON rc_citations(citing_paper_id);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_citations_cited  ON rc_citations(cited_paper_id);`,

  // rc_paper_tags indexes
  `CREATE INDEX IF NOT EXISTS idx_rc_paper_tags_tag ON rc_paper_tags(tag_id);`,

  // rc_collection_papers indexes
  `CREATE INDEX IF NOT EXISTS idx_rc_collection_papers_collection ON rc_collection_papers(collection_id);`,

  // rc_paper_notes indexes
  `CREATE INDEX IF NOT EXISTS idx_rc_paper_notes_paper ON rc_paper_notes(paper_id);`,

  // rc_tasks indexes
  `CREATE INDEX IF NOT EXISTS idx_rc_tasks_status           ON rc_tasks(status);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_tasks_priority         ON rc_tasks(priority);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_tasks_deadline         ON rc_tasks(deadline);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_tasks_task_type        ON rc_tasks(task_type);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_tasks_parent_task_id   ON rc_tasks(parent_task_id);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_tasks_related_paper_id ON rc_tasks(related_paper_id);`,
  // Partial index: active tasks by deadline (excludes done/cancelled)
  `CREATE INDEX IF NOT EXISTS idx_rc_tasks_active_deadline
    ON rc_tasks(status, deadline)
    WHERE status NOT IN ('done', 'cancelled');`,

  // rc_activity_log indexes
  `CREATE INDEX IF NOT EXISTS idx_rc_activity_log_task_id    ON rc_activity_log(task_id);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_activity_log_created_at ON rc_activity_log(created_at);`,
];

// ── FTS5 virtual table ──────────────────────────────────────────────

export const CREATE_FTS_SQL: readonly string[] = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS rc_papers_fts USING fts5(
  title,
  authors,
  abstract,
  notes,
  keywords,
  content='rc_papers',
  content_rowid='rowid'
);`,
];

// ── FTS5 sync triggers ──────────────────────────────────────────────
//
// Three triggers keep the FTS index in sync with the rc_papers table:
//   - rc_papers_fts_insert: mirrors new rows into FTS
//   - rc_papers_fts_delete: removes old row data from FTS before delete
//   - rc_papers_fts_update: delete old + insert new on update

export const CREATE_TRIGGERS_SQL: readonly string[] = [
  `CREATE TRIGGER IF NOT EXISTS rc_papers_fts_insert
  AFTER INSERT ON rc_papers
BEGIN
  INSERT INTO rc_papers_fts(rowid, title, authors, abstract, notes, keywords)
    VALUES (new.rowid, new.title, new.authors, new.abstract, new.notes, new.keywords);
END;`,

  `CREATE TRIGGER IF NOT EXISTS rc_papers_fts_update
  AFTER UPDATE ON rc_papers
BEGIN
  INSERT INTO rc_papers_fts(rc_papers_fts, rowid, title, authors, abstract, notes, keywords)
    VALUES ('delete', old.rowid, old.title, old.authors, old.abstract, old.notes, old.keywords);
  INSERT INTO rc_papers_fts(rowid, title, authors, abstract, notes, keywords)
    VALUES (new.rowid, new.title, new.authors, new.abstract, new.notes, new.keywords);
END;`,

  `CREATE TRIGGER IF NOT EXISTS rc_papers_fts_delete
  BEFORE DELETE ON rc_papers
BEGIN
  INSERT INTO rc_papers_fts(rc_papers_fts, rowid, title, authors, abstract, notes, keywords)
    VALUES ('delete', old.rowid, old.title, old.authors, old.abstract, old.notes, old.keywords);
END;`,
];
