/**
 * Monitor Service — CRUD + gateway cron binding + memory for rc_monitors
 *
 * Universal N-monitor model with agent memory. Each monitor is an independent
 * information source watcher backed by a gateway cron job. The memory column
 * stores dedup fingerprints, run history, and adaptive notes.
 */

import type BetterSqlite3 from 'better-sqlite3';
type Database = BetterSqlite3.Database;
import { createHash, randomUUID } from 'node:crypto';
import {
  collectMonitorCandidates as collectCandidates,
  type MonitorCollectorOptions,
  type MonitorCollectorResult,
} from './collector.js';

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
    'Tool boundary: Use monitor_get_context, monitor_collect_candidates, monitor_report, monitor_note, and send_notification only. Do not call read, task_flow_stage, workspace_* or other task/workspace tools for scheduled monitor runs.\n' +
    '1. CONTEXT: Call monitor_get_context with this monitor\'s ID to load memory.\n' +
    '2. COLLECT: Call monitor_collect_candidates to collect source candidates.\n' +
    '3. ANALYZE: Filter and summarize the collected candidates; only use browser/search if collector errors or misses required context.\n' +
    '4. REPORT: Call monitor_report with final results array and the exact fingerprint values returned by monitor_collect_candidates for accepted candidates. Do not invent date-based or summary-based fingerprints.\n' +
    '5. OBSERVE: If anything notable happened (source errors, patterns), call monitor_note.\n' +
    '6. NOTIFY: If new findings > 0 and notify is enabled, call send_notification.\n\n';

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
        'Fallback only when collector fingerprints are unavailable: use doi:{value} or arxiv:{id} for each paper found.';
    case 'code':
      return protocol +
        'TASK: Check the target repository for new releases, tags, or significant updates.\n' +
        'Use collected candidates from the core collector layer. Summarize releases, tags, commits, or trending repositories from the candidate data.\n' +
        'Fallback only when collector fingerprints are unavailable: use gh:{repo}:release:{tag} or gh:{repo}:commit:{sha}.';
    case 'feed':
      return protocol +
        'TASK: Fetch the RSS/Atom feed at the target URL.\n' +
        'Parse entries, filter by configured keywords if any.\n' +
        'Fallback only when collector fingerprints are unavailable: use rss:{entry_url} or rss:guid:{guid} for each entry.';
    case 'web':
      return protocol +
        'TASK: Check the target webpage through the core collector layer.\n' +
        'Compare collected candidates or page summary with previous content from memory.\n' +
        'If meaningfully changed, extract and summarize the differences.\n' +
        'Fallback only when collector fingerprints are unavailable: use a stable canonical URL fingerprint, not the current date.';
    case 'social':
      return protocol +
        'TASK: Check the target social media account/hashtag for new posts.\n' +
        'Use collected candidates from the core collector layer. Extract noteworthy updates.\n' +
        'Fallback only when collector fingerprints are unavailable: use social:{platform}:{post_id}.';
    case 'device':
      return '你是外设定时查证代理。目标设备 ID: {target}。\n' +
        '1. 调用 periph_camera_snap({"device_id": "{target}", "purpose": "scheduled check"}) 抓取当前帧。\n' +
        '2. 若抓帧失败(missed/error):调用 periph_observe 记录 kind=\'check\'、verdict=\'missed\'、summary=失败原因,然后 monitor_report 上报空结果,结束。\n' +
        '3. 若抓帧成功:根据下方"查证要求"分析画面(若你无法直接看到图像,调用 image 工具读取 frame_path 获取画面描述后再分析)。\n' +
        '4. 调用 periph_observe 记录 kind=\'check\':一切正常 verdict=\'ok\';发现异常 verdict=\'alert\';无法判断 verdict=\'unverified\'。summary 用一句话中文写明结论,frame_path 传抓到的帧。\n' +
        '5. monitor_report 上报本轮结果(title=结论一句话)。\n' +
        '6. 仅当 verdict=\'alert\' 时调用 send_notification 通知用户,内容含设备名与异常描述。\n' +
        '查证要求: {check_prompt 或 "描述画面中正在发生什么,判断是否存在异常。"}';
    default:
      return protocol +
        'TASK: Execute the monitoring task through the core collector layer and analyze the collected candidates.\n' +
        'Use collector fingerprints for each distinct finding whenever available.';
  }
}

function isLegacyDefaultAgentPrompt(prompt: string): boolean {
  return prompt.includes('EXECUTION PROTOCOL (mandatory, follow every step):')
    && (
      (
        prompt.includes('2. EXECUTE: Perform the monitoring task described below.')
        && prompt.includes('3. REPORT: Call monitor_report with results array + fingerprints array.')
      )
      || (
        prompt.includes('1. READ: Call monitor_get_context with this monitor\'s ID to load memory.')
        && prompt.includes('2. COLLECT: Call monitor_collect_candidates to collect source candidates.')
        && !prompt.includes('Tool boundary:')
      )
      || (
        prompt.includes('Tool boundary: Use monitor_get_context, monitor_collect_candidates, monitor_report, monitor_note, and send_notification only.')
        && (
          prompt.includes('Use browser to visit the target URL. Extract release notes and changes.')
          || prompt.includes('TASK: Visit the target webpage using browser.')
          || prompt.includes('Use browser to visit the target. Extract noteworthy updates.')
          || prompt.includes('Use available tools (search, browser, fetch) as appropriate.')
          || prompt.includes('4. REPORT: Call monitor_report with final results array + fingerprints array.')
          || prompt.includes('Generate fingerprints: web:sha256:{content_hash}.')
        )
      )
    );
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

  /**
   * Upgrade monitors that still use the historical generated prompt.
   * User-authored prompts are left alone unless they match the old default
   * protocol signature exactly enough to be unsafe for collector-first runs.
   */
  repairLegacyDefaultPrompts(): number {
    const rows = this.db.prepare('SELECT id, source_type, filters, agent_prompt FROM rc_monitors').all() as Array<{
      id: string;
      source_type: string;
      filters: string;
      agent_prompt: string;
    }>;

    const stmt = this.db.prepare(`
      UPDATE rc_monitors
      SET agent_prompt = ?, updated_at = datetime('now')
      WHERE id = ?
    `);

    let changed = 0;
    const updateAll = this.db.transaction(() => {
      for (const row of rows) {
        if (!isLegacyDefaultAgentPrompt(row.agent_prompt || '')) continue;
        let filters: Record<string, unknown> = {};
        try { filters = JSON.parse(row.filters) as Record<string, unknown>; } catch { /* keep empty */ }
        stmt.run(defaultAgentPrompt(row.source_type, filters), row.id);
        changed += 1;
      }
    });

    updateAll();
    return changed;
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
    const limit = Math.min(opts?.limit ?? 500, 500);
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
    // Creating a monitor only persists its RC definition. The dashboard
    // registers the backing gateway cron job when the user enables it.
    // Defaulting to enabled here creates a false "running" state with no
    // gateway_job_id, so new monitors must start disabled.
    const enabled = input.enabled ?? false;

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
      enabled ? 1 : 0,
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

    const fingerprintGroups = buildFingerprintGroups(monitor, results, fingerprints);
    const uniqueFingerprints = [...new Set(fingerprintGroups.flat())];
    const seenSet = new Set(memory.seen);
    const runSeenSet = new Set(seenSet);
    let newCount = 0;
    for (const group of fingerprintGroups) {
      if (group.length === 0 || group.some((fp) => runSeenSet.has(fp))) continue;
      newCount += 1;
      for (const fp of group) runSeenSet.add(fp);
    }

    // Append all aliases for reported findings so future runs can dedupe even if
    // the model returns collector fingerprints or URL-derived fingerprints.
    for (const fp of uniqueFingerprints) {
      if (seenSet.has(fp)) continue;
      memory.seen.push(fp);
      seenSet.add(fp);
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

  async collectMonitorCandidates(id: string, opts?: MonitorCollectorOptions): Promise<MonitorCollectorResult> {
    const monitor = this.get(id);
    return collectCandidates(monitor, opts);
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

function buildFingerprintGroups(monitor: Monitor, results: unknown[], fingerprints: string[]): string[][] {
  const groups: string[][] = [];

  if (results.length === 0) {
    return fingerprints
      .map((fp) => (typeof fp === 'string' && fp.trim() ? [fp.trim()] : []))
      .filter((group) => group.length > 0);
  }

  for (let i = 0; i < results.length; i++) {
    const group = new Set<string>();
    const provided = fingerprints[i];
    if (typeof provided === 'string' && provided.trim()) group.add(provided.trim());

    const stable = stableFingerprintsForResult(monitor, results[i]);
    for (const fp of stable) group.add(fp);

    if (group.size > 0) groups.push([...group]);
  }

  if (fingerprints.length > results.length && groups.length > 0) {
    const last = new Set(groups[groups.length - 1]);
    for (const fp of fingerprints.slice(results.length)) {
      if (typeof fp === 'string' && fp.trim()) last.add(fp.trim());
    }
    groups[groups.length - 1] = [...last];
  }

  return groups;
}

function stableFingerprintsForResult(monitor: Monitor, result: unknown): string[] {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
  const row = result as Record<string, unknown>;
  const url = stringField(row, 'url') || stringField(row, 'link') || stringField(row, 'html_url');
  if (url) {
    const canonical = canonicalizeUrl(url);
    if (canonical) {
      const source = fingerprintSource(monitor.source_type);
      return [
        fingerprint(source, canonical),
        fingerprint('monitor', `${monitor.id}:url:${canonical}`),
      ];
    }
  }

  const id = stringField(row, 'id') || stringField(row, 'guid') || stringField(row, 'doi') || stringField(row, 'arxiv_id');
  if (id) return [fingerprint(fingerprintSource(monitor.source_type), id)];

  const title = stringField(row, 'title');
  if (title) return [fingerprint(fingerprintSource(monitor.source_type), `${monitor.id}:title:${title}`)];
  return [];
}

function fingerprintSource(sourceType: string): string {
  const type = sourceType.toLowerCase();
  if (type === 'feed' || type === 'rss' || type === 'atom') return 'rss';
  if (type === 'github' || type === 'code') return 'gh';
  if (type === 'api') return 'api';
  if (type === 'web' || type === 'webpage') return 'web';
  return type || 'monitor';
}

function stringField(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function canonicalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|sourceSSR$|spm$|from$|ref$|ref_src$|share_token$)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return value.trim();
  }
}

function fingerprint(prefix: string, value: string): string {
  return `${prefix}:${value || 'unknown'}:${hash(value).slice(0, 16)}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
