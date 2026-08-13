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

export interface MonitorServiceOptions {
  /** Defaults true for ordinary and pre-policy callers. */
  peripheralsEnabled?: boolean;
}

/** Expected policy rejection; the RPC bridge preserves this domain code. */
export class PeripheralFeatureUnavailableError extends Error {
  readonly errorCode = 'FEATURE_UNAVAILABLE';

  constructor() {
    super('Peripheral monitoring is unavailable under the active product policy');
    this.name = 'PeripheralFeatureUnavailableError';
  }
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

function isDeviceSourceType(sourceType: string | null | undefined): boolean {
  return sourceType?.trim().toLowerCase() === 'device';
}

/**
 * SQLite's one-argument TRIM() removes U+0020 only, while the runtime boundary
 * above intentionally follows JavaScript trim semantics. Register the same
 * predicate as a deterministic connection-local SQL function so historical
 * rows containing HT/LF/NBSP cannot escape disabled list/repair queries.
 */
const SQL_IS_DEVICE_SOURCE_TYPE = 'rc_monitor_is_device_source_type';

function registerSourceTypeSqlPredicate(db: Database): void {
  db.function(
    SQL_IS_DEVICE_SOURCE_TYPE,
    { deterministic: true },
    (value: unknown) => (typeof value === 'string' && isDeviceSourceType(value) ? 1 : 0),
  );
}

// ── Default agent prompt for a category ───────────────────────────────

/**
 * @param deviceKind - rc_periph_devices.kind for source_type='device' monitors
 *                     (F4: audio-recorder gets the transcript-digest template;
 *                     camera and unknown/missing devices get the vision template).
 */
function defaultAgentPrompt(
  category: string,
  filters: Record<string, unknown>,
  deviceKind?: string,
): string {
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
      // F4: audio-recorder (Plaud) — 取转写→汇总→落笔记→通知,不抓帧不走 collector。
      if (deviceKind === 'audio-recorder') {
        // monitor_report 的真实 schema 是 (monitor_id, results[], fingerprints[]),
        // 没有 title 参数(monitor/tools.ts)。日报=交付物,始终产出正文推送。
        // fingerprints 用录音稳定标识去重,避免每天重复处理旧录音。
        return '你是录音笔定时汇总代理。目标设备 ID: {target}。本监控 ID: {monitor_id}。\n' +
          '1. 调用 monitor_get_context({"monitor_id": "{monitor_id}"}) 读取 memory.seen(已处理录音的 fingerprint),用于跳过旧录音。\n' +
          '2. 调用 plaud__list_files 获取最近录音列表。对每个文件取稳定 fingerprint(优先文件 id/唯一标识,其次 文件名+起始时间)。仅保留 fingerprint 不在 memory.seen 中的新录音。若无新录音:periph_observe 记录 kind=\'check\'、verdict=\'ok\'、summary=\'无新录音\'、monitor_id=\'{monitor_id}\',然后 monitor_report({"monitor_id":"{monitor_id}","results":[],"fingerprints":[]}) 结束。\n' +
          '3. 对每条新录音调用 plaud__get_transcript 获取转写。若某条工具返回错误,记录并跳过该条,不要中断整轮。\n' +
          '4. 汇总转写要点(主题、关键结论、待办),调用 workspace_save 保存到 outputs/plaud/daily-YYYY-MM-DD.md(YYYY-MM-DD 用当天日期;当天文件已存在则读取后追加,不要覆盖历史)。\n' +
          '5. 调用 periph_observe 记录 kind=\'check\'、verdict=\'ok\'、summary=一句话中文汇总、monitor_id=\'{monitor_id}\'。\n' +
          '6. 调用 monitor_report({"monitor_id":"{monitor_id}","results":[每条新录音一项{"title":录音主题}],"fingerprints":[每条新录音的稳定 fingerprint]}) 上报;fingerprints 用于去重,确保同一录音不被重复处理。\n' +
          '7. 调用 send_notification 通知用户日报已生成,内容含设备名与要点摘要。\n' +
          '不要调用 periph_camera_snap(该设备不是摄像头),不要调用 monitor_collect_candidates。\n' +
          '汇总要求: 提取每段录音的主题、关键结论与待办事项。';
      }
      // 第 8 步的静音语义用 NO_REPLY,不用"空正文"。这不是风格选择:
      // OpenClaw 对两者的处理完全不同。normalizeSilentReplyText
      // (run-delivery.runtime-B0hfxpBW.js:29-54)把 NO_REPLY 识别成"刻意静音",
      // 投递腿直接走 finishSilentReplyDelivery(:444),run 记录 status=ok;
      // 而真正的空回复会先被 embedded agent 的空响应检测拦下(retry 一次
      // visible-answer continuation,即每轮多烧一次模型调用),仍为空则判
      // incomplete turn,整轮 status=error、summary 变成
      // "⚠️ Agent couldn't generate a response. Please try again."。
      // 后果是正常轮次全部进 error 历史 —— 用户看到的是一台每 30 分钟报错一次的监控。
      // 两条路径在真 gateway 上实测过(scripts/f7-delivery-routes.sh 的 R2/R3):
      //   R2 空正文  → status=error deliveryStatus=not-delivered summary="⚠️ Agent couldn't…"
      //   R3 NO_REPLY → status=ok    deliveryStatus=not-delivered summary=""
      // 两者都不推渠道(IRC 旁听端零消息),但只有 R3 的运行历史是干净的。
      return '你是外设定时查证代理。目标设备 ID: {target}。本监控 ID: {monitor_id}。\n' +
        '0. 调用 periph_list 检查 camera_bridge.online。online=false 时:调用 periph_observe 记录 kind=\'check\'、verdict=\'missed\'、summary=\'摄像头桥离线,Dashboard 未打开\'、monitor_id=\'{monitor_id}\',然后 monitor_report({"monitor_id":"{monitor_id}","results":[],"fingerprints":[]}) 上报空结果,结束,**不要**指示用户操作。online=true 才继续。\n' +
        '1. 调用 periph_camera_snap({"device_id":"{target}","purpose":"scheduled check","monitor_id":"{monitor_id}"}) 抓取当前帧。\n' +
        '2. 若抓帧失败(missed/error):调用 periph_observe 记录 kind=\'check\'、verdict=\'missed\'、summary=失败原因、monitor_id=\'{monitor_id}\',然后 monitor_report({"monitor_id":"{monitor_id}","results":[],"fingerprints":[]}) 上报空结果,结束。\n' +
        '3. 若抓帧成功:根据下方"查证要求"分析画面(若你无法直接看到图像,调用 image 工具读取 frame_path 获取画面描述后再分析)。\n' +
        '4. 调用 periph_observe 记录 kind=\'check\':一切正常 verdict=\'ok\';发现异常 verdict=\'alert\';无法判断 verdict=\'unverified\'。summary 用一句话中文写明结论,frame_path 传抓到的帧,monitor_id=\'{monitor_id}\'。\n' +
        '5. 调用 monitor_report({"monitor_id":"{monitor_id}","results":[{"title":结论一句话,"verdict":本轮verdict}],"fingerprints":[本次抓帧的 frame_path,保证每轮唯一]});monitor_report 的真实参数只有 monitor_id/results/fingerprints/summary,没有 title 顶层参数,title 放在 results 项内。\n' +
        '6. 仅当 verdict=\'alert\' 时调用 send_notification 通知用户,内容含设备名与异常描述。\n' +
        '7. 若本轮 verdict=\'unverified\':调用 monitor_get_context 读取 memory.notes;若 notes 已含 vision-unverified-notified 则跳过提醒;若 notes 显示上一轮结论也是 unverified,调用 send_notification 发送一次性提醒告知用户视觉查证未生效(可能未配置图像模型 imageModel),并用 monitor_note 在 notes 中追加 vision-unverified-notified;否则仅用 monitor_note 记录本轮 unverified。\n' +
        '8. 最终回复(本轮最后一条消息的正文)决定是否推送到通知渠道。**仅当本轮 verdict=\'alert\' 时**,输出一句简短中文异常说明作为最终回复;其余情况(ok/unverified/missed)最终回复**必须且只能是 NO_REPLY**(不带引号、不加任何其他字符,也不要输出空白),不要输出任何总结、确认或客套话。这样正常轮不会打扰用户,异常轮才推送(铃铛提醒已由上面的 send_notification 步骤单独处理)。\n' +
        '查证要求: {check_prompt 或 "描述画面中正在发生什么,判断是否存在异常。"}';
    default:
      return protocol +
        'TASK: Execute the monitoring task through the core collector layer and analyze the collected candidates.\n' +
        'Use collector fingerprints for each distinct finding whenever available.';
  }
}

/**
 * Detect the historical device-monitor template (审计#4 / F7 迁移半).
 *
 * The v1 device template (commit b9deba9) predates three fixes now baked into
 * defaultAgentPrompt('device', …):
 *   - no {monitor_id} threading (observations couldn't be traced to a monitor);
 *   - a wrong monitor_report schema — "monitor_report 上报本轮结果(title=…)" —
 *     but the real tool takes (monitor_id, results[], fingerprints[]) with title
 *     living *inside* a results item (monitor/tools.ts), never a top-level arg;
 *   - no F7-b step 8 (empty final reply unless verdict=alert).
 *
 * We key on stable substrings that are unique to a superseded camera template and
 * ABSENT from the current one, so custom user prompts and the already-migrated
 * template both correctly return false. Every clause requires the header
 * "你是外设定时查证代理" so a user-authored prompt for some other device is never
 * touched.
 *
 * v1 (commit b9deba9) — the broken schema line "monitor_report 上报本轮结果(title="
 *   (the real tool takes results[]; the current template emits
 *   monitor_report({"monitor_id":…}) instead).
 *
 * v2 — step 8 told the agent to leave the final reply EMPTY on ok/unverified/missed
 *   ("必须留空"). Proven wrong on a real gateway: an empty final reply is not
 *   OpenClaw's silence mechanism, it is an incomplete turn — the run ends
 *   status=error with summary "⚠️ Agent couldn't generate a response. Please try
 *   again." after burning a retry, so a healthy camera monitor logs an error on
 *   every normal round. The current template says NO_REPLY, which
 *   normalizeSilentReplyText treats as a deliberate silent reply
 *   (run-delivery.runtime-B0hfxpBW.js:29-54) → status=ok, nothing delivered.
 *   Evidence: scripts/f7-delivery-routes.sh routes R2 (empty) vs R3 (NO_REPLY).
 */
function isLegacyDeviceAgentPrompt(prompt: string): boolean {
  if (!prompt.includes('你是外设定时查证代理')) return false;
  return (
    prompt.includes('monitor_report 上报本轮结果(title=') ||
    prompt.includes('最终回复**必须留空**')
  );
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
  readonly peripheralsEnabled: boolean;

  constructor(
    private readonly db: Database,
    opts: MonitorServiceOptions = {},
  ) {
    this.peripheralsEnabled = opts.peripheralsEnabled ?? true;
    registerSourceTypeSqlPredicate(db);
  }

  private assertSourceTypeAvailable(sourceType: string | null | undefined): void {
    if (!this.peripheralsEnabled && isDeviceSourceType(sourceType)) {
      throw new PeripheralFeatureUnavailableError();
    }
  }

  /**
   * Preserve the historical no-op behavior of write-only helpers for an
   * unknown id, while still blocking a stale device cron/job from mutating a
   * retained row. Full get() is intentionally not used here because it throws
   * for an unknown id and would make disabled policy change ordinary semantics.
   */
  private assertExistingMonitorAvailable(id: string): void {
    if (this.peripheralsEnabled) return;
    const row = this.db.prepare('SELECT source_type FROM rc_monitors WHERE id = ?').get(id) as
      { source_type: string } | undefined;
    if (row) this.assertSourceTypeAvailable(row.source_type);
  }

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
    const rows = this.db.prepare(
      `SELECT id, source_type, target, filters, agent_prompt FROM rc_monitors${
        this.peripheralsEnabled ? '' : ` WHERE ${SQL_IS_DEVICE_SOURCE_TYPE}(source_type) = 0`
      }`,
    ).all() as Array<{
      id: string;
      source_type: string;
      target: string;
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
        const prompt = row.agent_prompt || '';
        let filters: Record<string, unknown> = {};
        try { filters = JSON.parse(row.filters) as Record<string, unknown>; } catch { /* keep empty */ }

        // Device monitors use a separate template family; regenerate with the
        // device's kind (audio-recorder → plaud digest, else camera vision).
        // Only rewrites the historical default — custom prompts and the current
        // template both fail isLegacyDeviceAgentPrompt(), so they're left alone.
        if (isLegacyDeviceAgentPrompt(prompt)) {
          const kind = this.periphDeviceKind(row.target) ?? 'camera';
          stmt.run(defaultAgentPrompt('device', filters, kind), row.id);
          changed += 1;
          continue;
        }

        if (!isLegacyDefaultAgentPrompt(prompt)) continue;
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

    if (!this.peripheralsEnabled) {
      clauses.push(`${SQL_IS_DEVICE_SOURCE_TYPE}(source_type) = 0`);
    }

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
    this.assertSourceTypeAvailable(row.source_type);
    return rowToMonitor(row);
  }

  create(input: MonitorInput): Monitor {
    if (!input.name?.trim()) throw new Error('name is required');
    if (!input.source_type?.trim()) throw new Error('source_type is required and must be a non-empty string');
    const sourceType = input.source_type.trim();
    this.assertSourceTypeAvailable(sourceType);

    const schedule = input.schedule ?? '0 8 * * *';
    if (!validateCron(schedule)) throw new Error(`Invalid cron expression: ${schedule} (expected 5 fields)`);

    const id = randomUUID();
    const filters = input.filters ?? {};
    // F4: device 监控的默认模板按设备 kind 分支 — 建立时按 target 查 periph 设备。
    const deviceKind =
      isDeviceSourceType(sourceType) ? this.periphDeviceKind(input.target) : undefined;
    const prompt =
      input.agent_prompt?.trim() || defaultAgentPrompt(sourceType, filters, deviceKind);
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
      sourceType,
      input.target ?? '',
      JSON.stringify(filters),
      schedule,
      enabled ? 1 : 0,
      (input.notify ?? true) ? 1 : 0,
      prompt,
    );

    return this.get(id);
  }

  /**
   * Resolve a device monitor target to its rc_periph_devices.kind.
   * Returns undefined when the target is empty/unknown or the table is
   * missing (pre-v16 DB) — callers then fall back to the camera template.
   */
  private periphDeviceKind(target?: string): string | undefined {
    if (!target?.trim()) return undefined;
    try {
      const row = this.db.prepare('SELECT kind FROM rc_periph_devices WHERE id = ?').get(target.trim()) as
        { kind: string } | undefined;
      return row?.kind;
    } catch { return undefined; }
  }

  update(id: string, patch: MonitorPatch): Monitor {
    const current = this.get(id); // throws if not found

    this.assertSourceTypeAvailable(patch.source_type);

    if (patch.schedule && !validateCron(patch.schedule)) {
      throw new Error(`Invalid cron expression: ${patch.schedule} (expected 5 fields)`);
    }

    const sets: string[] = [];
    const params: unknown[] = [];

    if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name.trim()); }
    if (patch.source_type !== undefined) { sets.push('source_type = ?'); params.push(patch.source_type.trim()); }
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
    const row = this.db.prepare(
      'SELECT id, source_type, gateway_job_id FROM rc_monitors WHERE id = ?',
    ).get(id) as { id: string; source_type: string; gateway_job_id: string | null } | undefined;
    if (!row) throw new Error(`Monitor not found: ${id}`);
    this.assertSourceTypeAvailable(row.source_type);

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
    // T04 owns pre-start suspension. Runtime code never mutates a hidden row.
    this.assertExistingMonitorAvailable(id);
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
    // Guard before UPDATE so a stale cron/run cannot mutate historical rows.
    this.assertExistingMonitorAvailable(id);
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
      `SELECT * FROM rc_monitors WHERE enabled = 1${
        this.peripheralsEnabled ? '' : ` AND ${SQL_IS_DEVICE_SOURCE_TYPE}(source_type) = 0`
      } ORDER BY created_at ASC`,
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
