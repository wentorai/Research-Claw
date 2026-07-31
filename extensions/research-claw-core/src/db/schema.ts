/**
 * Research-Claw Core — SQLite Schema DDL
 *
 * 34 tables + FTS5 virtual table + triggers + indexes.
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
 *  13. rc_heartbeat_log    — Adaptive deadline escalation tracking
 *  14. rc_agent_notifications — Agent-generated user notifications
 *  15. rc_jobs             — Long-running background jobs
 *  16. rc_job_steps        — Job step tracking
 *  17. rc_cron_state       — Cron preset enable/disable state
 *  18. rc_monitors         — Recurring content monitors
 *  19. rc_memories         — User/agent memory store
 *  20. rc_memory_tags      — Memory tag definitions
 *  21. rc_memory_tag_links — Memory–tag junction
 *  22. rc_memory_links     — Memory–memory associations
 *  23. rc_sessions         — Conversation sessions
 *  24. rc_session_events   — Per-session event log
 *  25. rc_paper_reviews    — AI paper review results
 *  26. rc_periph_devices   — External peripheral devices (camera/audio/lab/embodied)
 *  27. rc_periph_observations — Peripheral observation records (snapshot/check/note)
 *  28. rc_prompt_presets    — User-managed reusable chat commands
 *  29. rc_execution_tools   — Per-run tool invocation trace
 *  30. rc_execution_skills  — Per-run verified Skill activation trace
 *  31. rc_execution_replies — Privacy-safe reply hash → run binding
 *  32. rc_execution_skill_events — Candidate/selected/loaded/executed lifecycle trace
 *  33. rc_execution_presentation_runs — Per-session/run presentation revision
 *  34. rc_execution_presentation_records — Immutable bounded card facts
 *
 * FTS5: rc_papers_fts (title, authors, abstract, notes, keywords)
 */

// ── Current schema version ──────────────────────────────────────────
export const SCHEMA_VERSION = 23;

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

const RC_AGENT_NOTIFICATIONS = `
CREATE TABLE IF NOT EXISTS rc_agent_notifications (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL DEFAULT 'system',
  title      TEXT NOT NULL,
  body       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read       INTEGER NOT NULL DEFAULT 0
);`;

const RC_HEARTBEAT_LOG = `
CREATE TABLE IF NOT EXISTS rc_heartbeat_log (
  task_id       TEXT PRIMARY KEY REFERENCES rc_tasks(id) ON DELETE CASCADE,
  current_tier  TEXT NOT NULL DEFAULT 'silent',
  last_notified TEXT,
  notify_count  INTEGER NOT NULL DEFAULT 0,
  escalated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  suppressed    INTEGER NOT NULL DEFAULT 0
);`;

const RC_JOBS = `
CREATE TABLE IF NOT EXISTS rc_jobs (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL,
  title          TEXT NOT NULL,
  session_key    TEXT,
  status         TEXT NOT NULL DEFAULT 'queued'
                   CHECK(status IN ('queued', 'running', 'completed', 'partial', 'failed', 'stalled', 'cancelled')),
  progress       INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  current_step   TEXT,
  input_json     TEXT NOT NULL DEFAULT '{}',
  result_json    TEXT,
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  error          TEXT,
  heartbeat_at   TEXT,
  started_at     TEXT,
  completed_at   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);`;

const RC_JOB_STEPS = `
CREATE TABLE IF NOT EXISTS rc_job_steps (
  job_id          TEXT NOT NULL REFERENCES rc_jobs(id) ON DELETE CASCADE,
  step_key        TEXT NOT NULL,
  label           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  attempt         INTEGER NOT NULL DEFAULT 0,
  progress        INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  error           TEXT,
  started_at      TEXT,
  completed_at    TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (job_id, step_key)
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

const RC_MONITORS = `
CREATE TABLE IF NOT EXISTS rc_monitors (
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
  memory          TEXT NOT NULL DEFAULT '{"v":1,"seen":[],"runs":[],"notes":""}',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);`;

const RC_MEMORIES = `
CREATE TABLE IF NOT EXISTS rc_memories (
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
);`;

const RC_MEMORY_TAGS = `
CREATE TABLE IF NOT EXISTS rc_memory_tags (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  color     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`;

const RC_MEMORY_TAG_LINKS = `
CREATE TABLE IF NOT EXISTS rc_memory_tag_links (
  memory_id TEXT NOT NULL REFERENCES rc_memories(id) ON DELETE CASCADE,
  tag_id    TEXT NOT NULL REFERENCES rc_memory_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, tag_id)
);`;

const RC_MEMORY_LINKS = `
CREATE TABLE IF NOT EXISTS rc_memory_links (
  id              TEXT PRIMARY KEY,
  from_memory_id  TEXT NOT NULL REFERENCES rc_memories(id) ON DELETE CASCADE,
  to_memory_id    TEXT NOT NULL REFERENCES rc_memories(id) ON DELETE CASCADE,
  context         TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(from_memory_id, to_memory_id)
);`;

const RC_SESSIONS = `
CREATE TABLE IF NOT EXISTS rc_sessions (
  id                  TEXT PRIMARY KEY,
  started_at          TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at            TEXT,
  events_count        INTEGER NOT NULL DEFAULT 0,
  memories_extracted  INTEGER NOT NULL DEFAULT 0,
  metadata            TEXT DEFAULT '{}'
);`;

// Final shape after v13 (add) + v14 (failed status + failure_reason).
// applyFullSchema records SCHEMA_VERSION directly, so fresh installs never run
// incremental migrations — this DDL must stay in sync with migrations.ts.
const RC_PAPER_REVIEWS = `
CREATE TABLE IF NOT EXISTS rc_paper_reviews (
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
);`;

const RC_SESSION_EVENTS = `
CREATE TABLE IF NOT EXISTS rc_session_events (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES rc_sessions(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL CHECK(event_type IN ('session_start', 'user_prompt', 'tool_use', 'assistant_response', 'session_end')),
  timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
  data        TEXT NOT NULL DEFAULT '{}'
);`;

export const CREATE_RC_PERIPH_DEVICES_SQL = `
CREATE TABLE IF NOT EXISTS rc_periph_devices (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK(kind IN ('camera','audio-recorder','lab-instrument','embodied')),
  driver        TEXT NOT NULL CHECK(driver IN ('browser-camera','mcp-plaud','rtsp','local-camera','oc-node')),
  enabled       INTEGER NOT NULL DEFAULT 1,
  config        TEXT NOT NULL DEFAULT '{}',
  check_prompt  TEXT NOT NULL DEFAULT '',
  last_seen_at  TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);`;

export const CREATE_RC_PERIPH_OBSERVATIONS_SQL = `
CREATE TABLE IF NOT EXISTS rc_periph_observations (
  id           TEXT PRIMARY KEY,
  device_id    TEXT NOT NULL REFERENCES rc_periph_devices(id) ON DELETE CASCADE,
  monitor_id   TEXT,
  kind         TEXT NOT NULL CHECK(kind IN ('snapshot','check','note')),
  verdict      TEXT NOT NULL DEFAULT 'info' CHECK(verdict IN ('ok','alert','info','unverified','missed','error')),
  summary      TEXT NOT NULL DEFAULT '',
  frame_path   TEXT,
  result_json  TEXT NOT NULL DEFAULT '{}',
  captured_at  TEXT NOT NULL DEFAULT (datetime('now'))
);`;

export const CREATE_RC_PROMPT_PRESETS_SQL = `
CREATE TABLE IF NOT EXISTS rc_prompt_presets (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  content      TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT '',
  favorite     INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0, 1)),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  use_count    INTEGER NOT NULL DEFAULT 0 CHECK(use_count >= 0),
  last_used_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);`;

export const CREATE_RC_EXECUTION_TOOLS_SQL = `
CREATE TABLE IF NOT EXISTS rc_execution_tools (
  id           TEXT PRIMARY KEY,
  session_key  TEXT NOT NULL,
  run_id       TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'invoked'
                 CHECK(status IN ('invoked', 'completed', 'error')),
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  duration_ms  INTEGER,
  error        TEXT,
  UNIQUE(run_id, tool_call_id)
);`;

export const CREATE_RC_EXECUTION_SKILLS_SQL = `
CREATE TABLE IF NOT EXISTS rc_execution_skills (
  id           TEXT PRIMARY KEY,
  session_key  TEXT NOT NULL,
  run_id       TEXT NOT NULL,
  skill_key    TEXT NOT NULL,
  skill_name   TEXT NOT NULL,
  skill_source TEXT NOT NULL DEFAULT 'research-plugins',
  activation   TEXT NOT NULL DEFAULT 'read' CHECK(activation IN ('read', 'command')),
  tool_call_id TEXT,
  first_used_at INTEGER NOT NULL,
  UNIQUE(run_id, skill_key)
);`;

export const CREATE_RC_EXECUTION_REPLIES_SQL = `
CREATE TABLE IF NOT EXISTS rc_execution_replies (
  run_id          TEXT PRIMARY KEY,
  session_key     TEXT NOT NULL,
  reply_hash      TEXT NOT NULL,
  reply_timestamp INTEGER NOT NULL,
  recorded_at     INTEGER NOT NULL
);`;

export const CREATE_RC_EXECUTION_SKILL_EVENTS_SQL = `
CREATE TABLE IF NOT EXISTS rc_execution_skill_events (
  id            TEXT PRIMARY KEY,
  session_key   TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  skill_key     TEXT NOT NULL,
  skill_name    TEXT NOT NULL,
  skill_source  TEXT NOT NULL,
  lifecycle     TEXT NOT NULL
                  CHECK(lifecycle IN ('candidate', 'selected', 'loaded', 'executed')),
  activation    TEXT CHECK(activation IS NULL OR activation IN ('read', 'command')),
  tool_call_id  TEXT,
  observed_at   INTEGER NOT NULL,
  UNIQUE(run_id, skill_key, lifecycle)
);`;

export const CREATE_RC_EXECUTION_PRESENTATION_RUNS_SQL = `
CREATE TABLE IF NOT EXISTS rc_execution_presentation_runs (
  session_key      TEXT NOT NULL,
  run_id           TEXT NOT NULL,
  records_revision INTEGER NOT NULL DEFAULT 0 CHECK(records_revision >= 0),
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY(session_key, run_id)
);`;

export const CREATE_RC_EXECUTION_PRESENTATION_RECORDS_SQL = `
CREATE TABLE IF NOT EXISTS rc_execution_presentation_records (
  id            TEXT PRIMARY KEY,
  session_key   TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  tool_call_id  TEXT NOT NULL,
  tool_name     TEXT NOT NULL,
  source        TEXT NOT NULL CHECK(source IN ('full', 'persisted')),
  completeness  TEXT NOT NULL CHECK(completeness IN ('partial', 'complete')),
  record_kind   TEXT NOT NULL CHECK(record_kind IN ('file', 'paper_batch')),
  payload_json  TEXT NOT NULL,
  payload_hash  TEXT NOT NULL,
  revision      INTEGER NOT NULL CHECK(revision > 0),
  observed_at   INTEGER NOT NULL,
  FOREIGN KEY(session_key, run_id)
    REFERENCES rc_execution_presentation_runs(session_key, run_id)
    ON DELETE CASCADE,
  UNIQUE(session_key, run_id, tool_call_id, source, payload_hash)
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
  RC_AGENT_NOTIFICATIONS,
  RC_HEARTBEAT_LOG,
  RC_JOBS,
  RC_JOB_STEPS,
  RC_CRON_STATE,
  RC_MONITORS,
  RC_MEMORIES,
  RC_MEMORY_TAGS,
  RC_MEMORY_TAG_LINKS,
  RC_MEMORY_LINKS,
  RC_SESSIONS,
  RC_SESSION_EVENTS,
  RC_PAPER_REVIEWS,
  CREATE_RC_PERIPH_DEVICES_SQL,
  CREATE_RC_PERIPH_OBSERVATIONS_SQL,
  CREATE_RC_PROMPT_PRESETS_SQL,
  CREATE_RC_EXECUTION_TOOLS_SQL,
  CREATE_RC_EXECUTION_SKILLS_SQL,
  CREATE_RC_EXECUTION_REPLIES_SQL,
  CREATE_RC_EXECUTION_SKILL_EVENTS_SQL,
  CREATE_RC_EXECUTION_PRESENTATION_RUNS_SQL,
  CREATE_RC_EXECUTION_PRESENTATION_RECORDS_SQL,
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

  // rc_monitors indexes
  `CREATE INDEX IF NOT EXISTS idx_rc_monitors_enabled     ON rc_monitors(enabled);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_monitors_source_type ON rc_monitors(source_type);`,

  // rc_memories indexes
  `CREATE INDEX IF NOT EXISTS idx_rc_memories_type           ON rc_memories(type);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_memories_active         ON rc_memories(is_active);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_memories_private        ON rc_memories(is_private);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_memories_paper          ON rc_memories(related_paper_id);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_memories_task           ON rc_memories(related_task_id);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_memories_accessed       ON rc_memories(accessed_at);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_memories_access_count   ON rc_memories(access_count);`,

  // rc_memory_tag_links indexes
  `CREATE INDEX IF NOT EXISTS idx_rc_memory_tag_links_memory ON rc_memory_tag_links(memory_id);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_memory_tag_links_tag    ON rc_memory_tag_links(tag_id);`,

  // rc_memory_links indexes
  `CREATE INDEX IF NOT EXISTS idx_rc_memory_links_from       ON rc_memory_links(from_memory_id);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_memory_links_to         ON rc_memory_links(to_memory_id);`,

  // rc_sessions indexes
  `CREATE INDEX IF NOT EXISTS idx_rc_sessions_started       ON rc_sessions(started_at);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_sessions_ended         ON rc_sessions(ended_at);`,

  // rc_session_events indexes
  `CREATE INDEX IF NOT EXISTS idx_rc_session_events_session  ON rc_session_events(session_id);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_session_events_type     ON rc_session_events(event_type);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_session_events_timestamp ON rc_session_events(timestamp);`,

  // rc_paper_reviews indexes
  `CREATE INDEX IF NOT EXISTS idx_rc_paper_reviews_file    ON rc_paper_reviews(file_path);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_paper_reviews_updated ON rc_paper_reviews(updated_at);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_paper_reviews_status  ON rc_paper_reviews(status);`,

  // rc_jobs indexes
  `CREATE INDEX IF NOT EXISTS idx_rc_jobs_status              ON rc_jobs(status);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_jobs_session             ON rc_jobs(session_key);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_jobs_updated             ON rc_jobs(updated_at);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_job_steps_status         ON rc_job_steps(status);`,

  // rc_periph_observations indexes
  `CREATE INDEX IF NOT EXISTS idx_rc_periph_observations_device   ON rc_periph_observations(device_id);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_periph_observations_captured ON rc_periph_observations(captured_at);`,

  // rc_prompt_presets indexes
  `CREATE INDEX IF NOT EXISTS idx_rc_prompt_presets_order
    ON rc_prompt_presets(favorite DESC, sort_order ASC);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_execution_tools_run ON rc_execution_tools(run_id);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_execution_tools_session ON rc_execution_tools(session_key);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_execution_skills_run ON rc_execution_skills(run_id);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_execution_replies_session
    ON rc_execution_replies(session_key, reply_timestamp);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_execution_skill_events_run
    ON rc_execution_skill_events(run_id, lifecycle, observed_at);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_execution_presentation_records_run
    ON rc_execution_presentation_records(session_key, run_id, revision);`,
  `CREATE INDEX IF NOT EXISTS idx_rc_execution_presentation_records_tool
    ON rc_execution_presentation_records(session_key, tool_call_id, observed_at);`,
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
  `CREATE VIRTUAL TABLE IF NOT EXISTS rc_memories_fts USING fts5(
  name,
  description,
  content,
  content='rc_memories',
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

  `CREATE TRIGGER IF NOT EXISTS rc_memories_fts_insert
  AFTER INSERT ON rc_memories
BEGIN
  INSERT INTO rc_memories_fts(rowid, name, description, content)
    VALUES (new.rowid, new.name, new.description, new.content);
END;`,

  `CREATE TRIGGER IF NOT EXISTS rc_memories_fts_update
  AFTER UPDATE ON rc_memories
BEGIN
  INSERT INTO rc_memories_fts(rc_memories_fts, rowid, name, description, content)
    VALUES ('delete', old.rowid, old.name, old.description, old.content);
  INSERT INTO rc_memories_fts(rowid, name, description, content)
    VALUES (new.rowid, new.name, new.description, new.content);
END;`,

  `CREATE TRIGGER IF NOT EXISTS rc_memories_fts_delete
  BEFORE DELETE ON rc_memories
BEGIN
  INSERT INTO rc_memories_fts(rc_memories_fts, rowid, name, description, content)
    VALUES ('delete', old.rowid, old.name, old.description, old.content);
END;`,
];
