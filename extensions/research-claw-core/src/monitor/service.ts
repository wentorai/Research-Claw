/**
 * Monitor Service — CRUD + gateway cron binding + memory for rc_monitors
 *
 * Universal N-monitor model with agent memory. Each monitor is an independent
 * information source watcher backed by a gateway cron job. The memory column
 * stores dedup fingerprints, run history, and adaptive notes.
 */

import type BetterSqlite3 from 'better-sqlite3';
type Database = BetterSqlite3.Database;
import { randomUUID } from 'node:crypto';

// ── Types ─────────────────────────────────────────────────────────────

export interface MonitorMemory {
  v: 1;
  seen: string[];
  runs: MonitorRun[];
  notes: string;
}

export interface MonitorRun {
  at: string;
  found: number;
  new_count: number;
  sources: string[];
  error?: string;
}

export interface Monitor {
  id: string;
  name: string;
  source_type: string;
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
  memory: MonitorMemory;
  created_at: string;
  updated_at: string;
}

export interface MonitorInput {
  name: string;
  source_type: string;
  target?: string;
  filters?: Record<string, unknown>;
  schedule?: string;
  enabled?: boolean;
  notify?: boolean;
  agent_prompt?: string;
}

export interface MonitorPatch {
  name?: string;
  source_type?: string;
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
  memory: string;
  created_at: string;
  updated_at: string;
}

// ── Seed monitors (templates) ─────────────────────────────────────────

interface SeedMonitor {
  id: string;
  name: string;
  source_type: string;
  target: string;
  filters: Record<string, unknown>;
  schedule: string;
  enabled: boolean;
  notify: boolean;
  agent_prompt: string;
}

const SEED_MONITORS: SeedMonitor[] = [
  {
    id: 'academic-daily',
    name: 'Academic Paper Digest',
    source_type: 'academic',
    target: '',
    filters: { keywords: [], authors: [], journals: [], domain: '' },
    schedule: '0 7 * * *',
    enabled: false,
    notify: true,
    agent_prompt: '', // will use defaultAgentPrompt('academic', filters)
  },
  {
    id: 'code-releases',
    name: 'GitHub Release Tracker',
    source_type: 'code',
    target: '',
    filters: { events: ['release', 'tag'] },
    schedule: '0 9 * * *',
    enabled: false,
    notify: true,
    agent_prompt: '',
  },
  {
    id: 'code-trending',
    name: 'GitHub Trending',
    source_type: 'code',
    target: 'https://github.com/trending',
    filters: { language: '', since: 'daily' },
    schedule: '0 9 * * 1-5',
    enabled: false,
    notify: true,
    agent_prompt: '',
  },
  {
    id: 'feed-monitor',
    name: 'RSS Feed Monitor',
    source_type: 'feed',
    target: '',
    filters: { keywords: [] },
    schedule: '0 8 * * *',
    enabled: false,
    notify: true,
    agent_prompt: '',
  },
  {
    id: 'tech-news',
    name: 'AI/Tech News',
    source_type: 'feed',
    target: 'https://huggingface.co/blog/feed.xml',
    filters: { keywords: [] },
    schedule: '0 8 * * *',
    enabled: false,
    notify: true,
    agent_prompt: '',
  },
  {
    id: 'web-watch',
    name: 'Webpage Change Detector',
    source_type: 'web',
    target: '',
    filters: { selector: '', keywords: [] },
    schedule: '0 9 * * 1-5',
    enabled: false,
    notify: true,
    agent_prompt: '',
  },
  {
    id: 'conference-deadlines',
    name: 'Conference Deadline Tracker',
    source_type: 'web',
    target: 'https://aideadlin.es/?sub=ML,NLP,CV,AI',
    filters: { keywords: [] },
    schedule: '0 9 * * 1',
    enabled: false,
    notify: true,
    agent_prompt: '',
  },
  {
    id: 'weekly-report',
    name: 'Weekly Progress Report',
    source_type: 'report',
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
    id: 'daily-reminder',
    name: 'Daily Task Reminder',
    source_type: 'reminder',
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

const DEFAULT_MEMORY: MonitorMemory = { v: 1, seen: [], runs: [], notes: '' };

function now(): string {
  return new Date().toISOString();
}

function parseMemory(raw: string | null | undefined): MonitorMemory {
  if (!raw) return { ...DEFAULT_MEMORY, seen: [], runs: [] };
  try {
    const parsed = JSON.parse(raw) as MonitorMemory;
    if (parsed && parsed.v === 1 && Array.isArray(parsed.seen) && Array.isArray(parsed.runs)) {
      return parsed;
    }
  } catch { /* malformed */ }
  return { ...DEFAULT_MEMORY, seen: [], runs: [] };
}

function rowToMonitor(row: MonitorRow): Monitor {
  let filters: Record<string, unknown> = {};
  try { filters = JSON.parse(row.filters) as Record<string, unknown>; } catch { /* */ }

  let lastResults: unknown[] | null = null;
  try { if (row.last_results) lastResults = JSON.parse(row.last_results) as unknown[]; } catch { /* */ }

  return {
    id: row.id,
    name: row.name,
    source_type: row.source_type,
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
    memory: parseMemory(row.memory),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function validateCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  return fields.length === 5;
}

// ── Default agent prompt for a category ───────────────────────────────

function defaultAgentPrompt(category: string, filters: Record<string, unknown>): string {
  const protocol =
    'EXECUTION PROTOCOL (mandatory, follow every step):\n' +
    '1. READ: Call monitor_get_context with this monitor\'s ID to load memory.\n' +
    '2. EXECUTE: Perform the monitoring task described below.\n' +
    '3. REPORT: Call monitor_report with results array + fingerprints array.\n' +
    '4. OBSERVE: If anything notable happened (source errors, patterns), call monitor_note.\n' +
    '5. NOTIFY: If new findings > 0 and notify is enabled, call send_notification.\n\n';

  switch (category) {
    case 'academic':
      return protocol +
        'TASK: Search for new academic papers matching the configured filters.\n' +
        'Route by domain using SKILL.md Selection Logic:\n' +
        '- If journals specified \u2192 search_crossref(journal=...) + search_europe_pmc(JOURNAL:...)\n' +
        '- CS/AI \u2192 search_dblp + search_arxiv\n' +
        '- Biomedical \u2192 search_pubmed + search_europe_pmc\n' +
        '- Economics \u2192 search_crossref(journal=...)\n' +
        '- Physics \u2192 search_arxiv + search_inspire\n' +
        '- General \u2192 search_crossref\n' +
        'Generate fingerprints: doi:{value} or arxiv:{id} for each paper found.';
    case 'code':
      return protocol +
        'TASK: Check the target repository for new releases, tags, or significant updates.\n' +
        'Use browser to visit the target URL. Extract release notes and changes.\n' +
        'Generate fingerprints: gh:{repo}:release:{tag} or gh:{repo}:commit:{sha}.';
    case 'feed':
      return protocol +
        'TASK: Fetch the RSS/Atom feed at the target URL.\n' +
        'Parse entries, filter by configured keywords if any.\n' +
        'Generate fingerprints: rss:{entry_url} or rss:guid:{guid} for each entry.';
    case 'web':
      return protocol +
        'TASK: Visit the target webpage using browser.\n' +
        'Take a snapshot and compare with previous content (from memory).\n' +
        'If meaningfully changed, extract and summarize the differences.\n' +
        'Generate fingerprints: web:sha256:{content_hash}.';
    case 'social':
      return protocol +
        'TASK: Check the target social media account/hashtag for new posts.\n' +
        'Use browser to visit the target. Extract noteworthy updates.\n' +
        'Generate fingerprints: social:{platform}:{post_id}.';
    default:
      return protocol +
        'TASK: Execute the monitoring task. Use available tools (search, browser, fetch) as appropriate.\n' +
        'Generate a unique fingerprint for each distinct finding.';
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
        const prompt = seed.agent_prompt || defaultAgentPrompt(seed.source_type, seed.filters);
        stmt.run(
          seed.id,
          seed.name,
          seed.source_type,
          seed.target ?? '',
          JSON.stringify(seed.filters ?? {}),
          seed.schedule ?? '0 8 * * *',
          seed.enabled ? 1 : 0,
          seed.notify ? 1 : 0,
          prompt,
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
    if (!input.source_type?.trim()) throw new Error('source_type is required and must be a non-empty string');

    const schedule = input.schedule ?? '0 8 * * *';
    if (!validateCron(schedule)) throw new Error(`Invalid cron expression: ${schedule} (expected 5 fields)`);

    const id = randomUUID();
    const filters = input.filters ?? {};
    const prompt = input.agent_prompt?.trim() || defaultAgentPrompt(input.source_type, filters);

    this.db.prepare(`
      INSERT INTO rc_monitors (id, name, source_type, target, filters, schedule, enabled, notify, agent_prompt, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      id,
      input.name.trim(),
      input.source_type.trim(),
      input.target ?? '',
      JSON.stringify(filters),
      schedule,
      (input.enabled ?? true) ? 1 : 0,
      (input.notify ?? true) ? 1 : 0,
      prompt,
    );

    return this.get(id);
  }

  update(id: string, patch: MonitorPatch): Monitor {
    const current = this.get(id); // throws if not found

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

  // ── Report results with memory dedup ──────────────────────────────

  report(id: string, results: unknown[], fingerprints: string[], summary?: string): Monitor {
    const monitor = this.get(id); // throws if not found
    const memory = monitor.memory;
    const findingCount = Array.isArray(results) ? results.length : 0;

    // Compute new_count by filtering fingerprints against seen
    const seenSet = new Set(memory.seen);
    const newFingerprints = fingerprints.filter((fp) => !seenSet.has(fp));
    const newCount = newFingerprints.length;

    // Append new fingerprints to seen (FIFO cap 2000)
    for (const fp of newFingerprints) {
      memory.seen.push(fp);
    }
    while (memory.seen.length > 2000) {
      memory.seen.shift();
    }

    // Append a new MonitorRun to runs (cap 30)
    const run: MonitorRun = {
      at: now(),
      found: findingCount,
      new_count: newCount,
      sources: [...new Set(fingerprints.map((fp) => fp.split(':')[0]))],
    };
    memory.runs.push(run);
    while (memory.runs.length > 30) {
      memory.runs.shift();
    }

    // Update DB
    this.db.prepare(`
      UPDATE rc_monitors SET
        last_check_at = datetime('now'),
        last_results = ?,
        last_error = NULL,
        check_count = check_count + 1,
        finding_count = finding_count + ?,
        memory = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(JSON.stringify(results), newCount, JSON.stringify(memory), id);

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

  // ── Get context for agent execution ─────────────────────────────

  getContext(id: string): { config: Record<string, unknown>; memory: { notes: string; last_run: MonitorRun | null; seen_count: number }; agent_prompt: string } {
    const monitor = this.get(id);
    const mem = monitor.memory;

    return {
      config: {
        id: monitor.id,
        name: monitor.name,
        source_type: monitor.source_type,
        target: monitor.target,
        filters: monitor.filters,
        schedule: monitor.schedule,
        notify: monitor.notify,
      },
      memory: {
        notes: mem.notes,
        last_run: mem.runs.length > 0 ? mem.runs[mem.runs.length - 1] : null,
        seen_count: mem.seen.length,
      },
      agent_prompt: monitor.agent_prompt,
    };
  }

  // ── Update adaptive notes ────────────────────────────────────────

  updateNote(id: string, note: string): Monitor {
    if (note.length > 4096) throw new Error('Note must be <= 4096 characters');

    const monitor = this.get(id); // throws if not found
    const memory = monitor.memory;
    memory.notes = note;

    this.db.prepare(`
      UPDATE rc_monitors SET
        memory = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(JSON.stringify(memory), id);

    return this.get(id);
  }

  // ── List enabled monitors (for reconciliation on startup) ───────

  listEnabled(): Monitor[] {
    const rows = this.db.prepare(
      'SELECT * FROM rc_monitors WHERE enabled = 1 ORDER BY created_at ASC',
    ).all() as MonitorRow[];
    return rows.map(rowToMonitor);
  }
}
