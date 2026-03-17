/**
 * Monitor Service — CRUD + gateway cron binding for rc_monitors
 *
 * Replaces the old rc_radar_config singleton + rc_cron_state preset system
 * with a universal N-monitor model. Each monitor is an independent
 * information source watcher backed by a gateway cron job.
 */

import type BetterSqlite3 from 'better-sqlite3';
type Database = BetterSqlite3.Database;
import { randomUUID } from 'node:crypto';

// ── Types ─────────────────────────────────────────────────────────────

export type SourceType =
  | 'arxiv'
  | 'semantic_scholar'
  | 'github'
  | 'rss'
  | 'webpage'
  | 'openalex'
  | 'twitter'
  | 'custom';

export interface Monitor {
  id: string;
  name: string;
  source_type: SourceType;
  target: string;
  filters: Record<string, unknown>;
  schedule: string;
  enabled: boolean;
  notify: boolean;
  agent_prompt: string;
  gateway_job_id: string | null;
  last_check_at: string | null;
  last_results: unknown[] | null;
  last_error: string | null;
  check_count: number;
  finding_count: number;
  created_at: string;
  updated_at: string;
}

export interface MonitorInput {
  name: string;
  source_type: SourceType;
  target?: string;
  filters?: Record<string, unknown>;
  schedule?: string;
  enabled?: boolean;
  notify?: boolean;
  agent_prompt?: string;
}

export interface MonitorPatch {
  name?: string;
  source_type?: SourceType;
  target?: string;
  filters?: Record<string, unknown>;
  schedule?: string;
  enabled?: boolean;
  notify?: boolean;
  agent_prompt?: string;
}

// ── DB row shape ──────────────────────────────────────────────────────

interface MonitorRow {
  id: string;
  name: string;
  source_type: string;
  target: string;
  filters: string;
  schedule: string;
  enabled: number;
  notify: number;
  agent_prompt: string;
  gateway_job_id: string | null;
  last_check_at: string | null;
  last_results: string | null;
  last_error: string | null;
  check_count: number;
  finding_count: number;
  created_at: string;
  updated_at: string;
}

// ── Seed monitors (templates) ─────────────────────────────────────────

interface SeedMonitor {
  id: string;
  name: string;
  source_type: SourceType;
  target: string;
  filters: Record<string, unknown>;
  schedule: string;
  enabled: boolean;
  notify: boolean;
  agent_prompt: string;
}

const SEED_MONITORS: SeedMonitor[] = [
  // ── Academic paper discovery ────────────────────────────────────
  {
    id: 'arxiv-daily',
    name: 'arXiv Daily Digest',
    source_type: 'arxiv',
    target: '',
    filters: { keywords: [], authors: [], categories: ['cs.AI'] },
    schedule: '0 7 * * *',
    enabled: false,
    notify: true,
    agent_prompt:
      'Scan arXiv for new papers matching this monitor\'s keywords and categories. ' +
      'Use monitor_scan with source_type="arxiv". ' +
      'Summarize the top 5 most relevant papers with one-line relevance notes. ' +
      'Cache results with monitor_report. ' +
      'Send a notification with send_notification summarizing count and highlights.',
  },
  {
    id: 'scholar-watch',
    name: 'Scholar Watch',
    source_type: 'semantic_scholar',
    target: '',
    filters: { authors: [], keywords: [] },
    schedule: '0 8 * * 1',
    enabled: false,
    notify: true,
    agent_prompt:
      'Check Semantic Scholar for new publications by tracked authors. ' +
      'Use monitor_scan with source_type="semantic_scholar". ' +
      'Compare against library to skip known papers. ' +
      'Report new findings with monitor_report and send_notification.',
  },
  {
    id: 'citation-alert',
    name: 'Citation Alert',
    source_type: 'semantic_scholar',
    target: '',
    filters: { track_citations_of: 'library' },
    schedule: '0 8 * * 1',
    enabled: false,
    notify: true,
    agent_prompt:
      'Check if any papers in the user\'s library have received new citations. ' +
      'Use library_citation_graph for each highly-rated paper. ' +
      'Compare citation counts with previous check (from last_results). ' +
      'Report any increase with the citing paper title and relevance. ' +
      'Cache updated counts with monitor_report and send_notification.',
  },

  // ── Code & tools ────────────────────────────────────────────────
  {
    id: 'github-releases',
    name: 'GitHub Release Tracker',
    source_type: 'github',
    target: '',
    filters: { events: ['release', 'tag'] },
    schedule: '0 9 * * *',
    enabled: false,
    notify: true,
    agent_prompt:
      'Check the target GitHub repository for new releases, tags, and significant commits. ' +
      'Fetch latest release notes and summarize what changed. ' +
      'Cache results with monitor_report and send_notification.',
  },
  {
    id: 'github-trending',
    name: 'GitHub Trending',
    source_type: 'github',
    target: '',
    filters: { scope: 'trending', language: '', since: 'daily' },
    schedule: '0 9 * * 1-5',
    enabled: false,
    notify: true,
    agent_prompt:
      'Check GitHub Trending repositories (https://github.com/trending). ' +
      'Filter by the configured language if set, otherwise check all. ' +
      'Identify repos relevant to the user\'s research interests. ' +
      'Summarize top 5 with star counts and descriptions. ' +
      'Cache results with monitor_report and send_notification.',
  },

  // ── Feeds & news ────────────────────────────────────────────────
  {
    id: 'rss-feed',
    name: 'RSS Feed Monitor',
    source_type: 'rss',
    target: '',
    filters: { keywords: [] },
    schedule: '0 8 * * *',
    enabled: false,
    notify: true,
    agent_prompt:
      'Fetch the RSS/Atom feed at the target URL. Parse new entries since last check. ' +
      'Filter by keywords if configured. Summarize the top entries. ' +
      'Cache results with monitor_report and send_notification.',
  },
  {
    id: 'tech-news-daily',
    name: 'AI/Tech News Daily',
    source_type: 'rss',
    target: 'https://huggingface.co/blog/feed.xml',
    filters: { keywords: [] },
    schedule: '0 8 * * *',
    enabled: false,
    notify: true,
    agent_prompt:
      'Fetch the Hugging Face blog RSS feed. Parse new entries since the last check. ' +
      'Summarize top entries with their key points. ' +
      'Highlight anything relevant to the user\'s research interests. ' +
      'Cache results with monitor_report and send_notification.',
  },

  // ── Web monitoring ──────────────────────────────────────────────
  {
    id: 'webpage-watch',
    name: 'Webpage Change Detector',
    source_type: 'webpage',
    target: '',
    filters: { selector: '', keywords: [] },
    schedule: '0 9 * * 1-5',
    enabled: false,
    notify: true,
    agent_prompt:
      'Fetch the target webpage. Compare content with previous check (from last_results). ' +
      'If content has meaningfully changed, extract and summarize the differences. ' +
      'Cache new content with monitor_report. Only send notification if meaningful changes found.',
  },
  {
    id: 'conference-deadlines',
    name: 'Conference Deadline Tracker',
    source_type: 'webpage',
    target: 'https://aideadlin.es/?sub=ML,NLP,CV,AI',
    filters: { keywords: [] },
    schedule: '0 9 * * 1',
    enabled: false,
    notify: true,
    agent_prompt:
      'Fetch the AI conference deadline tracker page. Extract upcoming deadlines within 60 days. ' +
      'Compare with previous check (from last_results) to identify newly added or approaching deadlines. ' +
      'For each deadline: conference name, submission date, notification date, location. ' +
      'Warn about any deadline within 14 days. ' +
      'Cache results with monitor_report. Send notification if new deadlines or approaching ones found.',
  },

  // ── Periodic self-reports ───────────────────────────────────────
  {
    id: 'weekly-progress',
    name: 'Weekly Progress Report',
    source_type: 'custom',
    target: '',
    filters: {},
    schedule: '0 17 * * 5',
    enabled: false,
    notify: true,
    agent_prompt:
      'Generate a weekly research progress report covering the past 7 days. Include: ' +
      '1) Papers added/read this week (use library_search). ' +
      '2) Tasks completed and in-progress (use task_list). ' +
      '3) Key findings or notes added. ' +
      '4) Suggested focus areas for next week. ' +
      'Save the report to workspace: workspace_save("outputs/reports/weekly-YYYY-MM-DD.md", ...). ' +
      'Send a brief notification with send_notification.',
  },
  {
    id: 'daily-task-reminder',
    name: 'Daily Task Reminder',
    source_type: 'custom',
    target: '',
    filters: {},
    schedule: '0 9 * * *',
    enabled: false,
    notify: true,
    agent_prompt:
      'Check for tasks due within 24 hours using task_list with deadline filter. ' +
      'Also check for overdue tasks. ' +
      'Send a notification with send_notification summarizing: ' +
      '- Number of overdue tasks (if any, list titles). ' +
      '- Tasks due today. ' +
      '- Top 3 priority tasks for the day. ' +
      'Keep the notification concise (under 200 chars for title).',
  },
];

// ── Helpers ───────────────────────────────────────────────────────────

const VALID_SOURCE_TYPES: readonly string[] = [
  'arxiv', 'semantic_scholar', 'github', 'rss', 'webpage', 'openalex', 'twitter', 'custom',
];

function now(): string {
  return new Date().toISOString();
}

function rowToMonitor(row: MonitorRow): Monitor {
  let filters: Record<string, unknown> = {};
  try { filters = JSON.parse(row.filters) as Record<string, unknown>; } catch { /* */ }

  let lastResults: unknown[] | null = null;
  try { if (row.last_results) lastResults = JSON.parse(row.last_results) as unknown[]; } catch { /* */ }

  return {
    id: row.id,
    name: row.name,
    source_type: row.source_type as SourceType,
    target: row.target,
    filters,
    schedule: row.schedule,
    enabled: row.enabled === 1,
    notify: row.notify === 1,
    agent_prompt: row.agent_prompt,
    gateway_job_id: row.gateway_job_id,
    last_check_at: row.last_check_at,
    last_results: lastResults,
    last_error: row.last_error,
    check_count: row.check_count,
    finding_count: row.finding_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function validateCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  return fields.length === 5;
}

function validateSourceType(type: string): type is SourceType {
  return VALID_SOURCE_TYPES.includes(type);
}

// ── Default agent prompt for a source type ────────────────────────────

function defaultAgentPrompt(sourceType: SourceType): string {
  switch (sourceType) {
    case 'arxiv':
      return 'Scan arXiv for new papers matching this monitor\'s keywords. Use monitor_scan. Summarize top 5 findings. Cache with monitor_report and send_notification.';
    case 'semantic_scholar':
      return 'Search Semantic Scholar for new publications matching this monitor\'s config. Use monitor_scan. Summarize findings. Cache with monitor_report and send_notification.';
    case 'github':
      return 'Check the target GitHub repository for new releases, issues, or commits. Summarize what changed. Cache with monitor_report and send_notification.';
    case 'rss':
      return 'Fetch the RSS feed at the target URL. Parse new entries since last check. Summarize top entries. Cache with monitor_report and send_notification.';
    case 'webpage':
      return 'Fetch the target webpage. Compare with previous check. Summarize any meaningful changes. Cache with monitor_report and send_notification only if changed.';
    case 'openalex':
      return 'Search OpenAlex for new works matching this monitor\'s config. Use monitor_scan. Summarize findings. Cache with monitor_report and send_notification.';
    case 'twitter':
      return 'Check the target Twitter/X account for new posts. Summarize noteworthy updates. Cache with monitor_report and send_notification.';
    case 'custom':
      return 'Execute the custom monitoring task as described. Report findings with monitor_report and send_notification.';
  }
}

// ── Service class ─────────────────────────────────────────────────────

export class MonitorService {
  constructor(private readonly db: Database) {}

  /**
   * Seed default monitors on first init (empty table only).
   * Called once during plugin registration.
   */
  seedDefaults(): void {
    const count = (this.db.prepare('SELECT COUNT(*) AS cnt FROM rc_monitors').get() as { cnt: number }).cnt;
    if (count > 0) return;

    const stmt = this.db.prepare(`
      INSERT INTO rc_monitors (id, name, source_type, target, filters, schedule, enabled, notify, agent_prompt, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `);

    const insertAll = this.db.transaction(() => {
      for (const seed of SEED_MONITORS) {
        stmt.run(
          seed.id,
          seed.name,
          seed.source_type,
          seed.target ?? '',
          JSON.stringify(seed.filters ?? {}),
          seed.schedule ?? '0 8 * * *',
          seed.enabled ? 1 : 0,
          seed.notify ? 1 : 0,
          seed.agent_prompt ?? defaultAgentPrompt(seed.source_type as SourceType),
        );
      }
    });

    insertAll();
  }

  // ── CRUD ──────────────────────────────────────────────────────────

  list(opts?: { enabled?: boolean; source_type?: string; limit?: number; offset?: number }): { items: Monitor[]; total: number } {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (opts?.enabled !== undefined) {
      clauses.push('enabled = ?');
      params.push(opts.enabled ? 1 : 0);
    }
    if (opts?.source_type) {
      clauses.push('source_type = ?');
      params.push(opts.source_type);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(opts?.limit ?? 100, 100);
    const offset = opts?.offset ?? 0;

    const total = (this.db.prepare(`SELECT COUNT(*) AS cnt FROM rc_monitors ${where}`).get(...params) as { cnt: number }).cnt;
    const rows = this.db.prepare(
      `SELECT * FROM rc_monitors ${where} ORDER BY enabled DESC, created_at ASC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as MonitorRow[];

    return { items: rows.map(rowToMonitor), total };
  }

  get(id: string): Monitor {
    const row = this.db.prepare('SELECT * FROM rc_monitors WHERE id = ?').get(id) as MonitorRow | undefined;
    if (!row) throw new Error(`Monitor not found: ${id}`);
    return rowToMonitor(row);
  }

  create(input: MonitorInput): Monitor {
    if (!input.name?.trim()) throw new Error('name is required');
    if (!validateSourceType(input.source_type)) throw new Error(`Invalid source_type: ${input.source_type}. Valid: ${VALID_SOURCE_TYPES.join(', ')}`);

    const schedule = input.schedule ?? '0 8 * * *';
    if (!validateCron(schedule)) throw new Error(`Invalid cron expression: ${schedule} (expected 5 fields)`);

    const id = randomUUID();
    const prompt = input.agent_prompt?.trim() || defaultAgentPrompt(input.source_type);

    this.db.prepare(`
      INSERT INTO rc_monitors (id, name, source_type, target, filters, schedule, enabled, notify, agent_prompt, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      id,
      input.name.trim(),
      input.source_type,
      input.target ?? '',
      JSON.stringify(input.filters ?? {}),
      schedule,
      (input.enabled ?? true) ? 1 : 0,
      (input.notify ?? true) ? 1 : 0,
      prompt,
    );

    return this.get(id);
  }

  update(id: string, patch: MonitorPatch): Monitor {
    const current = this.get(id); // throws if not found

    if (patch.source_type && !validateSourceType(patch.source_type)) {
      throw new Error(`Invalid source_type: ${patch.source_type}`);
    }
    if (patch.schedule && !validateCron(patch.schedule)) {
      throw new Error(`Invalid cron expression: ${patch.schedule} (expected 5 fields)`);
    }

    const sets: string[] = [];
    const params: unknown[] = [];

    if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name.trim()); }
    if (patch.source_type !== undefined) { sets.push('source_type = ?'); params.push(patch.source_type); }
    if (patch.target !== undefined) { sets.push('target = ?'); params.push(patch.target); }
    if (patch.filters !== undefined) { sets.push('filters = ?'); params.push(JSON.stringify(patch.filters)); }
    if (patch.schedule !== undefined) { sets.push('schedule = ?'); params.push(patch.schedule); }
    if (patch.enabled !== undefined) { sets.push('enabled = ?'); params.push(patch.enabled ? 1 : 0); }
    if (patch.notify !== undefined) { sets.push('notify = ?'); params.push(patch.notify ? 1 : 0); }
    if (patch.agent_prompt !== undefined) { sets.push('agent_prompt = ?'); params.push(patch.agent_prompt); }

    if (sets.length === 0) return current;

    sets.push('updated_at = datetime(\'now\')');
    params.push(id);

    this.db.prepare(`UPDATE rc_monitors SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.get(id);
  }

  delete(id: string): { ok: true; deleted: string; gateway_job_id: string | null } {
    const row = this.db.prepare('SELECT id, gateway_job_id FROM rc_monitors WHERE id = ?').get(id) as
      { id: string; gateway_job_id: string | null } | undefined;
    if (!row) throw new Error(`Monitor not found: ${id}`);

    this.db.prepare('DELETE FROM rc_monitors WHERE id = ?').run(id);
    return { ok: true, deleted: id, gateway_job_id: row.gateway_job_id };
  }

  toggle(id: string, enabled: boolean): Monitor {
    const monitor = this.get(id); // throws if not found
    this.db.prepare('UPDATE rc_monitors SET enabled = ?, updated_at = datetime(\'now\') WHERE id = ?').run(enabled ? 1 : 0, id);
    return this.get(id);
  }

  // ── Gateway job ID binding ──────────────────────────────────────

  setGatewayJobId(id: string, jobId: string | null): void {
    this.db.prepare('UPDATE rc_monitors SET gateway_job_id = ? WHERE id = ?').run(jobId, id);
  }

  // ── Report results (called by agent via monitor_report tool) ────

  report(id: string, results: unknown[], summary?: string): Monitor {
    const monitor = this.get(id); // throws if not found
    const findingCount = Array.isArray(results) ? results.length : 0;

    this.db.prepare(`
      UPDATE rc_monitors SET
        last_check_at = datetime('now'),
        last_results = ?,
        last_error = NULL,
        check_count = check_count + 1,
        finding_count = finding_count + ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(JSON.stringify(results), findingCount, id);

    return this.get(id);
  }

  reportError(id: string, error: string): void {
    this.db.prepare(`
      UPDATE rc_monitors SET
        last_check_at = datetime('now'),
        last_error = ?,
        check_count = check_count + 1,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(error, id);
  }

  // ── List enabled monitors (for reconciliation on startup) ───────

  listEnabled(): Monitor[] {
    const rows = this.db.prepare(
      'SELECT * FROM rc_monitors WHERE enabled = 1 ORDER BY created_at ASC',
    ).all() as MonitorRow[];
    return rows.map(rowToMonitor);
  }
}
