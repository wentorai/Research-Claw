/**
 * Migration Integration Tests — v6 → v9 upgrade path
 *
 * Exercises the REAL migration code against a simulated v6 database
 * with injected production-like data. Validates:
 *   1. Data preservation across all 3 new migrations (v7, v8, v9)
 *   2. Idempotency (running migrations twice doesn't break)
 *   3. FTS5 rebuild doesn't lose paper data
 *   4. New-user full-schema path
 *   5. Corner cases: partial columns, empty tables, large datasets
 */

import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';

import { runMigrations, getCurrentVersion } from '../db/migrations.js';
import { SCHEMA_VERSION } from '../db/schema.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof BetterSqlite3;

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Build a v6 database from scratch — the EXACT state a real user would have
 * before this release. Uses the v1 DDL (without v7-v9 columns) + applies v2-v6.
 */
function createV6Database(): BetterSqlite3.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');

  // v1 base tables — rc_papers WITHOUT the 11 new columns
  db.exec(`
    CREATE TABLE rc_schema_version (
      version    INTEGER NOT NULL,
      applied_at TEXT    NOT NULL
    );
    CREATE TABLE rc_papers (
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
      metadata        TEXT DEFAULT '{}'
    );
    CREATE TABLE rc_tags (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE rc_paper_tags (
      paper_id TEXT NOT NULL REFERENCES rc_papers(id) ON DELETE CASCADE,
      tag_id   TEXT NOT NULL REFERENCES rc_tags(id)   ON DELETE CASCADE,
      PRIMARY KEY (paper_id, tag_id)
    );
    CREATE TABLE rc_collections (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
      color TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE rc_collection_papers (
      collection_id TEXT NOT NULL REFERENCES rc_collections(id) ON DELETE CASCADE,
      paper_id      TEXT NOT NULL REFERENCES rc_papers(id)      ON DELETE CASCADE,
      added_at TEXT NOT NULL, sort_order INTEGER DEFAULT 0,
      PRIMARY KEY (collection_id, paper_id)
    );
    CREATE TABLE rc_smart_groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, query_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE rc_reading_sessions (
      id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES rc_papers(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL, ended_at TEXT, duration_minutes INTEGER, notes TEXT, pages_read INTEGER
    );
    CREATE TABLE rc_citations (
      citing_paper_id TEXT NOT NULL REFERENCES rc_papers(id) ON DELETE CASCADE,
      cited_paper_id  TEXT NOT NULL REFERENCES rc_papers(id) ON DELETE CASCADE,
      context TEXT, section TEXT,
      PRIMARY KEY (citing_paper_id, cited_paper_id)
    );
    CREATE TABLE rc_paper_notes (
      id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES rc_papers(id) ON DELETE CASCADE,
      content TEXT NOT NULL, page INTEGER, highlight TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE rc_tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
      task_type TEXT NOT NULL CHECK(task_type IN ('human', 'agent', 'mixed')),
      status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo', 'in_progress', 'blocked', 'done', 'cancelled')),
      priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('urgent', 'high', 'medium', 'low')),
      deadline TEXT, completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      parent_task_id TEXT REFERENCES rc_tasks(id) ON DELETE SET NULL,
      related_paper_id TEXT REFERENCES rc_papers(id) ON DELETE SET NULL,
      agent_session_id TEXT, tags TEXT, notes TEXT
    );
    CREATE TABLE rc_activity_log (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES rc_tasks(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL, old_value TEXT, new_value TEXT,
      actor TEXT NOT NULL CHECK(actor IN ('human', 'agent')), created_at TEXT NOT NULL
    );
    CREATE TABLE rc_cron_state (
      preset_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
      config TEXT NOT NULL DEFAULT '{}', last_run_at TEXT, next_run_at TEXT, gateway_job_id TEXT
    );

    -- FTS5 without keywords column (v6 state)
    CREATE VIRTUAL TABLE rc_papers_fts USING fts5(
      title, authors, abstract, notes,
      content='rc_papers', content_rowid='rowid'
    );
    CREATE TRIGGER rc_papers_fts_insert AFTER INSERT ON rc_papers BEGIN
      INSERT INTO rc_papers_fts(rowid, title, authors, abstract, notes)
        VALUES (new.rowid, new.title, new.authors, new.abstract, new.notes);
    END;
    CREATE TRIGGER rc_papers_fts_update AFTER UPDATE ON rc_papers BEGIN
      INSERT INTO rc_papers_fts(rc_papers_fts, rowid, title, authors, abstract, notes)
        VALUES ('delete', old.rowid, old.title, old.authors, old.abstract, old.notes);
      INSERT INTO rc_papers_fts(rowid, title, authors, abstract, notes)
        VALUES (new.rowid, new.title, new.authors, new.abstract, new.notes);
    END;
    CREATE TRIGGER rc_papers_fts_delete BEFORE DELETE ON rc_papers BEGIN
      INSERT INTO rc_papers_fts(rc_papers_fts, rowid, title, authors, abstract, notes)
        VALUES ('delete', old.rowid, old.title, old.authors, old.abstract, old.notes);
    END;
  `);

  // Apply v2-v6 migrations manually (they're what the user already has)
  db.exec(`CREATE TABLE rc_radar_config (
    id TEXT PRIMARY KEY DEFAULT 'default', keywords TEXT NOT NULL DEFAULT '[]',
    authors TEXT NOT NULL DEFAULT '[]', journals TEXT NOT NULL DEFAULT '[]',
    sources TEXT NOT NULL DEFAULT '["arxiv","semantic_scholar"]',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  db.exec(`CREATE TABLE rc_agent_notifications (
    id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'system', title TEXT NOT NULL,
    body TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), read INTEGER NOT NULL DEFAULT 0
  );`);
  db.exec(`ALTER TABLE rc_tasks ADD COLUMN related_file_path TEXT;`);
  db.exec(`ALTER TABLE rc_cron_state ADD COLUMN schedule TEXT;`);
  db.exec(`ALTER TABLE rc_radar_config ADD COLUMN last_scan_at TEXT;`);
  db.exec(`ALTER TABLE rc_radar_config ADD COLUMN last_scan_results TEXT;`);

  // Record version 6
  db.prepare(`INSERT INTO rc_schema_version (version, applied_at) VALUES (?, datetime('now'))`).run(6);

  return db;
}

/** Insert realistic test papers into the database. */
function seedPapers(db: BetterSqlite3.Database, count: number): string[] {
  const ids: string[] = [];
  const stmt = db.prepare(`
    INSERT INTO rc_papers (id, title, authors, abstract, doi, venue, year, added_at, updated_at, read_status, rating, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?, ?)
  `);

  const papers = [
    { title: 'Attention Is All You Need', authors: '["Vaswani","Shazeer","Parmar"]', abstract: 'The dominant sequence transduction models...', doi: '10.5555/3295222.3295349', venue: 'NeurIPS', year: 2017, status: 'reviewed' as const, rating: 5, notes: 'Foundational transformer paper' },
    { title: 'BERT: Pre-training of Deep Bidirectional Transformers', authors: '["Devlin","Chang","Lee","Toutanova"]', abstract: 'We introduce a new language representation model...', doi: '10.18653/v1/N19-1423', venue: 'NAACL', year: 2019, status: 'read' as const, rating: 4, notes: 'Key pre-training innovation' },
    { title: 'ImageNet Large Scale Visual Recognition Challenge', authors: '["Russakovsky","Deng","Su"]', abstract: 'The ImageNet Large Scale Visual Recognition Challenge...', doi: '10.1007/s11263-015-0816-y', venue: 'IJCV', year: 2015, status: 'unread' as const, rating: null, notes: null },
    { title: 'Deep Residual Learning for Image Recognition', authors: '["He","Zhang","Ren","Sun"]', abstract: 'Deeper neural networks are more difficult to train...', doi: '10.1109/CVPR.2016.90', venue: 'CVPR', year: 2016, status: 'reading' as const, rating: 3, notes: 'ResNet — skip connections' },
    { title: 'Generative Adversarial Nets', authors: '["Goodfellow","Pouget-Abadie","Mirza"]', abstract: 'We propose a new framework for estimating generative models...', doi: '10.5555/2969033.2969125', venue: 'NeurIPS', year: 2014, status: 'reviewed' as const, rating: 5, notes: 'GAN原始论文, 开创了生成模型新范式' },
  ];

  for (let i = 0; i < count; i++) {
    const p = papers[i % papers.length];
    const id = `paper-${String(i + 1).padStart(3, '0')}`;
    const doi = i < papers.length ? p.doi : `10.test/${id}`;
    stmt.run(id, p.title, p.authors, p.abstract, doi, p.venue, p.year, p.status, p.rating, p.notes);
    ids.push(id);
  }
  return ids;
}

/** Seed tags and link to papers. */
function seedTags(db: BetterSqlite3.Database, paperIds: string[]): void {
  db.exec(`INSERT INTO rc_tags (id, name, color, created_at) VALUES ('t1', 'machine-learning', '#3B82F6', datetime('now'));`);
  db.exec(`INSERT INTO rc_tags (id, name, color, created_at) VALUES ('t2', 'computer-vision', '#22C55E', datetime('now'));`);
  db.exec(`INSERT INTO rc_tags (id, name, color, created_at) VALUES ('t3', 'nlp', '#F59E0B', datetime('now'));`);
  for (const pid of paperIds.slice(0, 3)) {
    db.exec(`INSERT INTO rc_paper_tags (paper_id, tag_id) VALUES ('${pid}', 't1');`);
  }
  db.exec(`INSERT INTO rc_paper_tags (paper_id, tag_id) VALUES ('${paperIds[0]}', 't3');`);
}

/** Seed tasks linked to papers. */
function seedTasks(db: BetterSqlite3.Database, paperIds: string[]): void {
  db.exec(`INSERT INTO rc_tasks (id, title, task_type, status, priority, created_at, updated_at, related_paper_id, related_file_path, tags)
    VALUES ('task-001', 'Read Vaswani et al.', 'human', 'in_progress', 'high', datetime('now'), datetime('now'), '${paperIds[0]}', 'sources/papers/attention.pdf', '["reading","literature-review"]');`);
  db.exec(`INSERT INTO rc_tasks (id, title, task_type, status, priority, created_at, updated_at, tags)
    VALUES ('task-002', 'Run baseline experiments', 'agent', 'todo', 'medium', datetime('now'), datetime('now'), '["experiment"]');`);
  db.exec(`INSERT INTO rc_tasks (id, title, task_type, status, priority, deadline, created_at, updated_at)
    VALUES ('task-003', 'Submit paper draft', 'human', 'todo', 'urgent', '2026-04-01T23:59:00Z', datetime('now'), datetime('now'));`);
}

/** Seed citations between papers. */
function seedCitations(db: BetterSqlite3.Database, paperIds: string[]): void {
  if (paperIds.length >= 3) {
    db.exec(`INSERT INTO rc_citations (citing_paper_id, cited_paper_id, context, section) VALUES ('${paperIds[1]}', '${paperIds[0]}', 'builds upon the transformer architecture', 'Related Work');`);
    db.exec(`INSERT INTO rc_citations (citing_paper_id, cited_paper_id, context) VALUES ('${paperIds[3]}', '${paperIds[2]}', 'evaluated on ImageNet benchmark');`);
  }
}

/** Seed radar config + cron state (v6 data). */
function seedRadarAndCron(db: BetterSqlite3.Database): void {
  db.exec(`INSERT INTO rc_radar_config (id, keywords, authors, updated_at) VALUES ('default', '["transformer","attention"]', '["Vaswani"]', datetime('now'));`);
  db.exec(`INSERT INTO rc_cron_state (preset_id, enabled, config, schedule) VALUES ('arxiv_daily_scan', 1, '{}', '0 7 * * *');`);
  db.exec(`INSERT INTO rc_cron_state (preset_id, enabled, config, schedule) VALUES ('deadline_reminders_daily', 1, '{}', '0 9 * * *');`);
}

/** Get column names for a table. */
function getColumns(db: BetterSqlite3.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}

/** Get all table names. */
function getTables(db: BetterSqlite3.Database): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'rc_%' ORDER BY name`).all() as Array<{ name: string }>).map((r) => r.name);
}

// ── Tests ───────────────────────────────────────────────────────────

describe('Migration v6 → v9: existing user upgrade', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = createV6Database();
  });
  afterEach(() => {
    db.close();
  });

  it('starts at version 6', () => {
    expect(getCurrentVersion(db)).toBe(6);
  });

  it('rc_papers has 19 columns (v6 state, no academic fields)', () => {
    const cols = getColumns(db, 'rc_papers');
    expect(cols).not.toContain('keywords');
    expect(cols).not.toContain('language');
    expect(cols).not.toContain('paper_type');
    expect(cols.length).toBe(19);
  });

  describe('with seeded production data', () => {
    let paperIds: string[];

    beforeEach(() => {
      paperIds = seedPapers(db, 5);
      seedTags(db, paperIds);
      seedTasks(db, paperIds);
      seedCitations(db, paperIds);
      seedRadarAndCron(db);
    });

    it('has 5 papers, 3 tags, 3 tasks, 2 citations before migration', () => {
      expect((db.prepare('SELECT COUNT(*) AS c FROM rc_papers').get() as { c: number }).c).toBe(5);
      expect((db.prepare('SELECT COUNT(*) AS c FROM rc_tags').get() as { c: number }).c).toBe(3);
      expect((db.prepare('SELECT COUNT(*) AS c FROM rc_tasks').get() as { c: number }).c).toBe(3);
      expect((db.prepare('SELECT COUNT(*) AS c FROM rc_citations').get() as { c: number }).c).toBe(2);
      expect((db.prepare('SELECT COUNT(*) AS c FROM rc_cron_state').get() as { c: number }).c).toBe(2);
    });

    it('migrates from v6 to v9 without data loss', () => {
      runMigrations(db);

      expect(getCurrentVersion(db)).toBe(9);
      expect((db.prepare('SELECT COUNT(*) AS c FROM rc_papers').get() as { c: number }).c).toBe(5);
      expect((db.prepare('SELECT COUNT(*) AS c FROM rc_tags').get() as { c: number }).c).toBe(3);
      expect((db.prepare('SELECT COUNT(*) AS c FROM rc_tasks').get() as { c: number }).c).toBe(3);
      expect((db.prepare('SELECT COUNT(*) AS c FROM rc_citations').get() as { c: number }).c).toBe(2);
      expect((db.prepare('SELECT COUNT(*) AS c FROM rc_cron_state').get() as { c: number }).c).toBe(2);
    });

    it('preserves all paper field values after migration', () => {
      runMigrations(db);

      const paper = db.prepare('SELECT * FROM rc_papers WHERE id = ?').get('paper-001') as Record<string, unknown>;
      expect(paper.title).toBe('Attention Is All You Need');
      expect(paper.authors).toBe('["Vaswani","Shazeer","Parmar"]');
      expect(paper.doi).toBe('10.5555/3295222.3295349');
      expect(paper.read_status).toBe('reviewed');
      expect(paper.rating).toBe(5);
      expect(paper.notes).toBe('Foundational transformer paper');
      // New columns should be NULL/default
      expect(paper.keywords).toBe('[]');
      expect(paper.language).toBeNull();
      expect(paper.paper_type).toBeNull();
      expect(paper.volume).toBeNull();
      expect(paper.citation_count).toBeNull();
    });

    it('preserves Chinese characters in notes after migration', () => {
      runMigrations(db);

      const paper = db.prepare('SELECT notes FROM rc_papers WHERE id = ?').get('paper-005') as { notes: string };
      expect(paper.notes).toBe('GAN原始论文, 开创了生成模型新范式');
    });

    it('preserves task → paper foreign key relationships', () => {
      runMigrations(db);

      const task = db.prepare('SELECT related_paper_id, related_file_path FROM rc_tasks WHERE id = ?').get('task-001') as Record<string, unknown>;
      expect(task.related_paper_id).toBe('paper-001');
      expect(task.related_file_path).toBe('sources/papers/attention.pdf');
    });

    it('preserves citation relationships', () => {
      runMigrations(db);

      const cites = db.prepare('SELECT * FROM rc_citations ORDER BY citing_paper_id').all() as Array<Record<string, unknown>>;
      expect(cites).toHaveLength(2);
      expect(cites[0].citing_paper_id).toBe('paper-002');
      expect(cites[0].cited_paper_id).toBe('paper-001');
      expect(cites[0].context).toBe('builds upon the transformer architecture');
    });

    it('preserves tag → paper associations', () => {
      runMigrations(db);

      const assocs = db.prepare('SELECT COUNT(*) AS c FROM rc_paper_tags').get() as { c: number };
      expect(assocs.c).toBe(4); // 3 papers with t1 + 1 paper with t3
    });

    it('preserves radar config', () => {
      runMigrations(db);

      const config = db.prepare('SELECT * FROM rc_radar_config WHERE id = ?').get('default') as Record<string, unknown>;
      expect(config.keywords).toBe('["transformer","attention"]');
      expect(config.authors).toBe('["Vaswani"]');
    });

    it('creates rc_heartbeat_log table (v7)', () => {
      runMigrations(db);

      const tables = getTables(db);
      expect(tables).toContain('rc_heartbeat_log');
      const cols = getColumns(db, 'rc_heartbeat_log');
      expect(cols).toContain('task_id');
      expect(cols).toContain('current_tier');
      expect(cols).toContain('suppressed');
    });

    it('creates rc_monitors table with indexes (v8)', () => {
      runMigrations(db);

      const tables = getTables(db);
      expect(tables).toContain('rc_monitors');
      const cols = getColumns(db, 'rc_monitors');
      expect(cols).toContain('source_type');
      expect(cols).toContain('agent_prompt');
      expect(cols).toContain('finding_count');

      // Verify indexes exist
      const indexes = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='rc_monitors'`).all() as Array<{ name: string }>).map((r) => r.name);
      expect(indexes).toContain('idx_rc_monitors_enabled');
      expect(indexes).toContain('idx_rc_monitors_source_type');
    });

    it('adds all 11 academic columns to rc_papers (v9)', () => {
      runMigrations(db);

      const cols = getColumns(db, 'rc_papers');
      const newCols = ['keywords', 'language', 'paper_type', 'volume', 'issue', 'pages', 'publisher', 'issn', 'isbn', 'discipline', 'citation_count'];
      for (const col of newCols) {
        expect(cols).toContain(col);
      }
      expect(cols.length).toBe(30); // 19 original + 11 new
    });

    it('FTS5 search works after rebuild and includes keywords', () => {
      runMigrations(db);

      // Update a paper with keywords
      db.prepare('UPDATE rc_papers SET keywords = ? WHERE id = ?').run('["transformer","self-attention","NLP"]', 'paper-001');

      // FTS search by title (existing data)
      const byTitle = db.prepare(`SELECT id FROM rc_papers WHERE rowid IN (SELECT rowid FROM rc_papers_fts WHERE rc_papers_fts MATCH 'attention')`).all() as Array<{ id: string }>;
      expect(byTitle.length).toBeGreaterThanOrEqual(1);
      expect(byTitle.map((r) => r.id)).toContain('paper-001');

      // FTS search by abstract
      const byAbstract = db.prepare(`SELECT id FROM rc_papers WHERE rowid IN (SELECT rowid FROM rc_papers_fts WHERE rc_papers_fts MATCH 'generative')`).all() as Array<{ id: string }>;
      expect(byAbstract.map((r) => r.id)).toContain('paper-005');

      // FTS search by keywords (new column) — quote hyphenated terms for FTS5
      const byKeywords = db.prepare(`SELECT id FROM rc_papers WHERE rowid IN (SELECT rowid FROM rc_papers_fts WHERE rc_papers_fts MATCH '"self-attention"')`).all() as Array<{ id: string }>;
      expect(byKeywords.map((r) => r.id)).toContain('paper-001');
    });

    it('new paper inserts with academic fields work after migration', () => {
      runMigrations(db);

      db.prepare(`INSERT INTO rc_papers (id, title, authors, added_at, updated_at, keywords, language, paper_type, volume, issue, pages, publisher, discipline)
        VALUES ('paper-new', 'Test Paper', '["Author"]', datetime('now'), datetime('now'), '["test"]', 'en', 'journal_article', '42', '3', '100-110', 'Springer', 'computer_science')`).run();

      const paper = db.prepare('SELECT * FROM rc_papers WHERE id = ?').get('paper-new') as Record<string, unknown>;
      expect(paper.keywords).toBe('["test"]');
      expect(paper.language).toBe('en');
      expect(paper.paper_type).toBe('journal_article');
      expect(paper.volume).toBe('42');
      expect(paper.publisher).toBe('Springer');
    });
  });
});

describe('Migration idempotency', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = createV6Database();
    seedPapers(db, 5);
  });
  afterEach(() => {
    db.close();
  });

  it('running runMigrations() twice is safe', () => {
    runMigrations(db);
    expect(getCurrentVersion(db)).toBe(9);

    // Second run should be a no-op
    runMigrations(db);
    expect(getCurrentVersion(db)).toBe(9);
    expect((db.prepare('SELECT COUNT(*) AS c FROM rc_papers').get() as { c: number }).c).toBe(5);
  });

  it('running runMigrations() three times is safe', () => {
    runMigrations(db);
    runMigrations(db);
    runMigrations(db);
    expect(getCurrentVersion(db)).toBe(9);
    expect((db.prepare('SELECT COUNT(*) AS c FROM rc_papers').get() as { c: number }).c).toBe(5);
  });

  it('v9 fn migration survives when columns already exist (simulated partial retry)', () => {
    // Manually add some columns (simulating partial migration)
    db.exec(`ALTER TABLE rc_papers ADD COLUMN keywords TEXT DEFAULT '[]';`);
    db.exec(`ALTER TABLE rc_papers ADD COLUMN language TEXT;`);
    // Leave the rest missing — v9 should add only the missing ones

    runMigrations(db);
    expect(getCurrentVersion(db)).toBe(9);

    const cols = getColumns(db, 'rc_papers');
    expect(cols).toContain('keywords');
    expect(cols).toContain('language');
    expect(cols).toContain('paper_type');
    expect(cols).toContain('isbn');
    expect(cols).toContain('citation_count');
  });
});

describe('New user: fresh database', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
  });
  afterEach(() => {
    db.close();
  });

  it('applies full schema at SCHEMA_VERSION (v9) on empty database', () => {
    expect(getCurrentVersion(db)).toBe(0);

    runMigrations(db);
    expect(getCurrentVersion(db)).toBe(SCHEMA_VERSION);
  });

  it('has all tables after fresh install', () => {
    runMigrations(db);

    const tables = getTables(db);
    expect(tables).toContain('rc_papers');
    expect(tables).toContain('rc_tags');
    expect(tables).toContain('rc_tasks');
    expect(tables).toContain('rc_heartbeat_log');
    expect(tables).toContain('rc_monitors');
    expect(tables).toContain('rc_cron_state');
    expect(tables).toContain('rc_schema_version');
  });

  it('rc_papers has all 30 columns on fresh install', () => {
    runMigrations(db);

    const cols = getColumns(db, 'rc_papers');
    expect(cols.length).toBe(30);
    expect(cols).toContain('keywords');
    expect(cols).toContain('citation_count');
  });

  it('FTS5 works on fresh install with keywords column', () => {
    runMigrations(db);

    db.prepare(`INSERT INTO rc_papers (id, title, authors, added_at, updated_at, keywords)
      VALUES ('p1', 'Test Paper', '["Author"]', datetime('now'), datetime('now'), '["deep-learning","NLP"]')`).run();

    const results = db.prepare(`SELECT id FROM rc_papers WHERE rowid IN (SELECT rowid FROM rc_papers_fts WHERE rc_papers_fts MATCH '"deep-learning"')`).all() as Array<{ id: string }>;
    expect(results.map((r) => r.id)).toContain('p1');
  });

  it('double runMigrations on fresh DB is safe', () => {
    runMigrations(db);
    runMigrations(db);
    expect(getCurrentVersion(db)).toBe(SCHEMA_VERSION);
  });
});

describe('Corner cases', () => {
  it('empty rc_papers table migrates cleanly', () => {
    const db = createV6Database();
    // No papers seeded — empty table
    runMigrations(db);

    expect(getCurrentVersion(db)).toBe(9);
    expect(getColumns(db, 'rc_papers').length).toBe(30);
    // FTS rebuild on empty table should not error
    const ftsCount = (db.prepare('SELECT COUNT(*) AS c FROM rc_papers_fts').get() as { c: number }).c;
    expect(ftsCount).toBe(0);
    db.close();
  });

  it('large dataset (100 papers) preserves all rows through migration', () => {
    const db = createV6Database();
    seedPapers(db, 100);
    runMigrations(db);

    expect((db.prepare('SELECT COUNT(*) AS c FROM rc_papers').get() as { c: number }).c).toBe(100);
    // FTS should index all 100
    const ftsAll = db.prepare(`SELECT COUNT(*) AS c FROM rc_papers WHERE rowid IN (SELECT rowid FROM rc_papers_fts WHERE rc_papers_fts MATCH 'models OR framework OR neural OR challenge OR difficult')`).all();
    expect((ftsAll[0] as { c: number }).c).toBeGreaterThan(0);
    db.close();
  });

  it('papers with NULL abstracts and notes survive FTS rebuild', () => {
    const db = createV6Database();
    db.prepare(`INSERT INTO rc_papers (id, title, authors, added_at, updated_at) VALUES ('null-paper', 'No Abstract Paper', '["Author"]', datetime('now'), datetime('now'))`).run();

    runMigrations(db);

    const paper = db.prepare('SELECT * FROM rc_papers WHERE id = ?').get('null-paper') as Record<string, unknown>;
    expect(paper.title).toBe('No Abstract Paper');
    expect(paper.abstract).toBeNull();
    expect(paper.notes).toBeNull();
    expect(paper.keywords).toBe('[]'); // default
    db.close();
  });

  it('version gaps: v3 database can migrate to v9', () => {
    // Simulate a v3 user (skipped v4-v6 — shouldn't happen, but test robustness)
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    // Minimal v3 schema
    db.exec(`
      CREATE TABLE rc_schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE rc_papers (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, authors TEXT NOT NULL DEFAULT '[]',
        abstract TEXT, doi TEXT UNIQUE, url TEXT, arxiv_id TEXT, pdf_path TEXT,
        source TEXT, source_id TEXT, venue TEXT, year INTEGER,
        added_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        read_status TEXT NOT NULL DEFAULT 'unread' CHECK(read_status IN ('unread','reading','read','reviewed')),
        rating INTEGER, notes TEXT, bibtex_key TEXT, metadata TEXT DEFAULT '{}'
      );
      CREATE TABLE rc_tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT, created_at TEXT NOT NULL);
      CREATE TABLE rc_paper_tags (paper_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY(paper_id, tag_id));
      CREATE TABLE rc_collections (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, color TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE rc_collection_papers (collection_id TEXT NOT NULL, paper_id TEXT NOT NULL, added_at TEXT NOT NULL, sort_order INTEGER DEFAULT 0, PRIMARY KEY(collection_id, paper_id));
      CREATE TABLE rc_smart_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, query_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE rc_reading_sessions (id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, duration_minutes INTEGER, notes TEXT, pages_read INTEGER);
      CREATE TABLE rc_citations (citing_paper_id TEXT NOT NULL, cited_paper_id TEXT NOT NULL, context TEXT, section TEXT, PRIMARY KEY(citing_paper_id, cited_paper_id));
      CREATE TABLE rc_paper_notes (id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, content TEXT NOT NULL, page INTEGER, highlight TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE rc_tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, task_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'medium', deadline TEXT, completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, parent_task_id TEXT, related_paper_id TEXT, agent_session_id TEXT, tags TEXT, notes TEXT);
      CREATE TABLE rc_activity_log (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, event_type TEXT NOT NULL, old_value TEXT, new_value TEXT, actor TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE rc_radar_config (id TEXT PRIMARY KEY DEFAULT 'default', keywords TEXT NOT NULL DEFAULT '[]', authors TEXT NOT NULL DEFAULT '[]', journals TEXT NOT NULL DEFAULT '[]', sources TEXT NOT NULL DEFAULT '["arxiv","semantic_scholar"]', updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE rc_agent_notifications (id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'system', title TEXT NOT NULL, body TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), read INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE rc_cron_state (preset_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL DEFAULT '{}', last_run_at TEXT, next_run_at TEXT, gateway_job_id TEXT);
      CREATE VIRTUAL TABLE rc_papers_fts USING fts5(title, authors, abstract, notes, content='rc_papers', content_rowid='rowid');
    `);
    db.prepare(`INSERT INTO rc_schema_version (version, applied_at) VALUES (?, datetime('now'))`).run(3);

    // v4 adds related_file_path, v5 adds schedule, v6 adds scan cache — all should apply
    runMigrations(db);

    expect(getCurrentVersion(db)).toBe(9);
    expect(getColumns(db, 'rc_tasks')).toContain('related_file_path');
    expect(getColumns(db, 'rc_cron_state')).toContain('schedule');
    expect(getColumns(db, 'rc_papers')).toContain('keywords');
    expect(getTables(db)).toContain('rc_heartbeat_log');
    expect(getTables(db)).toContain('rc_monitors');
    db.close();
  });
});
