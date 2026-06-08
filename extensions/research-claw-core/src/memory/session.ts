/**
 * Session Monitoring Service
 *
 * Captures chat sessions and events for automatic memory extraction.
 * Inspired by claude-mem's lifecycle hooks approach.
 */

import type Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryService } from './service.js';
import type {
  Session,
  SessionEvent,
  SessionEventType,
  UserPromptEvent,
  ToolUseEvent,
  AssistantResponseEvent,
  MemoryExtractionConfig,
  MemoryType,
} from './types.js';

const DEFAULT_EXTRACTION_CONFIG: MemoryExtractionConfig = {
  extract_after_turns: 3,
  min_confidence: 0.6,
  max_memories_per_session: 5,
  auto_extract_enabled: true,
};

const MEMORY_MD_BEGIN = '<!-- rc:memory-auto-start -->';
const MEMORY_MD_END = '<!-- rc:memory-auto-end -->';

export interface MemoryExtractionDiagnostics {
  auto_extract_enabled: boolean;
  queued_sessions: number;
  draining: boolean;
  current_session_id: string | null;
  total_runs: number;
  total_extracted: number;
  last_extraction_at: string | null;
  last_extraction_session_id: string | null;
  last_extraction_count: number;
  last_extraction_status: 'idle' | 'success' | 'noop' | 'failed';
  last_extraction_error: string | null;
  last_model: { provider: string; model: string; api: string } | null;
  memory_md_path: string | null;
  memory_md_last_synced_at: string | null;
}

export interface SessionServiceOptions extends Partial<MemoryExtractionConfig> {
  workspaceRoot?: string;
  configPath?: string;
}

export class SessionMonitoringService {
  private db: Database.Database;
  private memoryService: MemoryService;
  private currentSessionId: string | null = null;
  private currentTurnCount: number = 0;
  private config: MemoryExtractionConfig;
  private extractionQueue: string[] = [];
  private queuedSessions = new Set<string>();
  private draining = false;

  private workspaceRoot: string | null;
  private explicitConfigPath: string | null;

  private totalRuns = 0;
  private totalExtracted = 0;
  private lastExtractionAt: string | null = null;
  private lastExtractionSessionId: string | null = null;
  private lastExtractionCount = 0;
  private lastExtractionStatus: 'idle' | 'success' | 'noop' | 'failed' = 'idle';
  private lastExtractionError: string | null = null;
  private lastModelInfo: { provider: string; model: string; api: string } | null = null;
  private memoryMdLastSyncedAt: string | null = null;

  constructor(db: Database.Database, options: SessionServiceOptions = {}) {
    this.db = db;
    this.memoryService = new MemoryService(db);
    const { workspaceRoot, configPath, ...config } = options;
    this.config = { ...DEFAULT_EXTRACTION_CONFIG, ...config };
    this.workspaceRoot = workspaceRoot ?? null;
    this.explicitConfigPath = configPath ?? null;
  }

  setWorkspaceRoot(root: string | null): void {
    this.workspaceRoot = root;
  }

  setConfigPath(p: string | null): void {
    this.explicitConfigPath = p;
  }

  getExtractionDiagnostics(): MemoryExtractionDiagnostics {
    return {
      auto_extract_enabled: this.config.auto_extract_enabled !== false,
      queued_sessions: this.extractionQueue.length,
      draining: this.draining,
      current_session_id: this.currentSessionId,
      total_runs: this.totalRuns,
      total_extracted: this.totalExtracted,
      last_extraction_at: this.lastExtractionAt,
      last_extraction_session_id: this.lastExtractionSessionId,
      last_extraction_count: this.lastExtractionCount,
      last_extraction_status: this.lastExtractionStatus,
      last_extraction_error: this.lastExtractionError,
      last_model: this.lastModelInfo,
      memory_md_path: this.workspaceRoot ? path.join(this.workspaceRoot, 'MEMORY.md') : null,
      memory_md_last_synced_at: this.memoryMdLastSyncedAt,
    };
  }

  async triggerExtractionNow(sessionId?: string | null): Promise<{ status: string; sessionId: string | null; extracted: number }> {
    const target = sessionId ?? this.currentSessionId;
    if (!target) {
      return { status: 'no_session', sessionId: null, extracted: 0 };
    }
    await this.extractMemories(target);
    return {
      status: this.lastExtractionStatus,
      sessionId: this.lastExtractionSessionId,
      extracted: this.lastExtractionCount,
    };
  }

  // ── Session Management ───────────────────────────────────────────────────

  /**
   * Start a new session.
   * Called when a user starts a new conversation.
   */
  startSession(metadata: Record<string, unknown> = {}): Session {
    const id = randomUUID();
    const startedAt = new Date().toISOString();

    this.db.prepare(
      `INSERT INTO rc_sessions (id, started_at, events_count, memories_extracted, metadata)
       VALUES (?, ?, 0, 0, ?)`,
    ).run(id, startedAt, JSON.stringify(metadata));

    this.currentSessionId = id;
    this.currentTurnCount = 0;

    // Record session start event
    this.recordEvent(id, 'session_start', { metadata });

    return this.getSession(id)!;
  }

  /**
   * End the current session.
   * Called when a conversation ends.
   */
  endSession(): Session | null {
    if (!this.currentSessionId) {
      return null;
    }

    const sessionId = this.currentSessionId;
    const endedAt = new Date().toISOString();

    this.db.prepare(
      'UPDATE rc_sessions SET ended_at = ? WHERE id = ?',
    ).run(endedAt, sessionId);

    // Record session end event
    this.recordEvent(sessionId, 'session_end', { ended_at: endedAt });

    // Trigger final memory extraction
    if (this.config.auto_extract_enabled) {
      void this.extractMemories(sessionId);
    }

    const session = this.getSession(sessionId);
    this.currentSessionId = null;
    this.currentTurnCount = 0;

    return session;
  }

  /**
   * Get a session by ID.
   */
  getSession(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM rc_sessions WHERE id = ?').get(id) as
      | { id: string; started_at: string; ended_at: string | null; events_count: number; memories_extracted: number }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      started_at: row.started_at,
      ended_at: row.ended_at,
      events_count: row.events_count,
      memories_extracted: row.memories_extracted,
    };
  }

  /**
   * Get the current active session.
   */
  getCurrentSession(): Session | null {
    if (!this.currentSessionId) {
      return null;
    }
    return this.getSession(this.currentSessionId);
  }

  /**
   * List recent sessions.
   */
  listSessions(limit: number = 50, offset: number = 0): Session[] {
    const rows = this.db.prepare(
      `SELECT * FROM rc_sessions ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    ).all(limit, offset) as Array<{
      id: string;
      started_at: string;
      ended_at: string | null;
      events_count: number;
      memories_extracted: number;
    }>;

    return rows.map(row => ({
      id: row.id,
      started_at: row.started_at,
      ended_at: row.ended_at,
      events_count: row.events_count,
      memories_extracted: row.memories_extracted,
    }));
  }

  // ── Event Recording ───────────────────────────────────────────────────────

  /**
   * Record a user prompt.
   * Called when the user sends a message.
   */
  recordUserPrompt(content: string): SessionEvent | null {
    if (!this.currentSessionId) {
      return null;
    }

    const eventData: UserPromptEvent = { content };
    return this.recordEvent(this.currentSessionId, 'user_prompt', eventData);
  }

  /**
   * Record a tool use.
   * Called when the agent uses a tool.
   */
  recordToolUse(toolName: string, parameters: Record<string, unknown>, result: unknown, durationMs?: number): SessionEvent | null {
    if (!this.currentSessionId) {
      return null;
    }

    const eventData: ToolUseEvent = {
      tool_name: toolName,
      parameters,
      result,
      duration_ms: durationMs,
    };

    return this.recordEvent(this.currentSessionId, 'tool_use', eventData);
  }

  /**
   * Record an assistant response.
   * Called when the agent responds to the user.
   */
  recordAssistantResponse(content: string, toolCalls?: Array<{ name: string; input: Record<string, unknown> }>): SessionEvent | null {
    if (!this.currentSessionId) {
      return null;
    }

    const eventData: AssistantResponseEvent = {
      content,
      tool_calls: toolCalls,
    };

    this.currentTurnCount++;

    // Check if we should extract memories after this turn
    if (this.config.auto_extract_enabled && this.currentTurnCount >= this.config.extract_after_turns!) {
      void this.extractMemories(this.currentSessionId);
      this.currentTurnCount = 0;
    }

    return this.recordEvent(this.currentSessionId, 'assistant_response', eventData);
  }

  /**
   * Record a generic event.
   */
  private recordEvent(sessionId: string, eventType: SessionEventType, data: unknown): SessionEvent {
    const id = randomUUID();
    const timestamp = new Date().toISOString();

    this.db.prepare(
      `INSERT INTO rc_session_events (id, session_id, event_type, timestamp, data)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, sessionId, eventType, timestamp, JSON.stringify(data));

    // Update session event count
    this.db.prepare(
      'UPDATE rc_sessions SET events_count = events_count + 1 WHERE id = ?',
    ).run(sessionId);

    return {
      id,
      session_id: sessionId,
      event_type: eventType,
      timestamp,
      data: data as Record<string, unknown>,
    };
  }

  /**
   * Get events for a session.
   */
  getSessionEvents(sessionId: string, eventType?: SessionEventType): SessionEvent[] {
    let sql = 'SELECT * FROM rc_session_events WHERE session_id = ?';
    const params: unknown[] = [sessionId];

    if (eventType) {
      sql += ' AND event_type = ?';
      params.push(eventType);
    }

    sql += ' ORDER BY timestamp ASC';

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      session_id: string;
      event_type: string;
      timestamp: string;
      data: string;
    }>;

    return rows.map(row => ({
      id: row.id,
      session_id: row.session_id,
      event_type: row.event_type as SessionEventType,
      timestamp: row.timestamp,
      data: JSON.parse(row.data) as Record<string, unknown>,
    }));
  }

  // ── Memory Extraction ────────────────────────────────────────────────────

  private stripPrivateAndSecrets(text: string): string {
    return text
      .replace(/<private>[\s\S]*?<\/private>/gi, '[private omitted]')
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g, 'Bearer [REDACTED]')
      .replace(/\bsk-[A-Za-z0-9._~+/=-]{12,}/g, 'sk-[REDACTED]')
      .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s,;]+/gi, '$1=[REDACTED]')
      .trim();
  }

  private summarize(text: string, maxLength: number): string {
    const compact = text.replace(/\s+/g, ' ').trim();
    return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}...`;
  }

  private normalizeKey(text: string): string {
    return text
      .toLowerCase()
      .replace(/<private>[\s\S]*?<\/private>/gi, '')
      .replace(/\bsk-[A-Za-z0-9._~+/=-]{12,}/g, 'sk-redacted')
      .replace(/\s+/g, ' ')
      .replace(/[^\p{L}\p{N}\s:/._-]/gu, '')
      .trim()
      .slice(0, 180);
  }

  private inferMemoryType(text: string): MemoryType {
    if (text === 'user' || text === 'feedback' || text === 'project' || text === 'reference') return text;
    if (/(偏好|习惯|以后都|以后请|我希望|我喜欢|我不喜欢|prefer|preference|always|never)/i.test(text)) return 'user';
    if (/(不对|错误|失败|不满意|应该|不要再|修复|bug|报错|failed|wrong|fix)/i.test(text)) return 'feedback';
    if (/(https?:\/\/|doi:|arxiv|zotero|endnote|bibtex|文献|论文|reference|citation)/i.test(text)) return 'reference';
    return 'project';
  }

  private loadCurrentModelConfig(): {
    provider: string;
    model: string;
    api: string;
    baseUrl: string;
    apiKey: string;
  } | null {
    const configPath =
      this.explicitConfigPath ||
      process.env.OPENCLAW_CONFIG_PATH ||
      path.join(process.cwd(), 'config', 'openclaw.json');
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      const defaults = (cfg.agents as Record<string, unknown> | undefined)?.defaults as Record<string, unknown> | undefined;
      const modelRefObj = defaults?.model as { primary?: string } | undefined;
      const primary = typeof modelRefObj?.primary === 'string' ? modelRefObj.primary : '';
      const slash = primary.indexOf('/');
      if (slash <= 0) return null;
      const provider = primary.slice(0, slash);
      const model = primary.slice(slash + 1);
      const providers = (cfg.models as Record<string, unknown> | undefined)?.providers as Record<string, Record<string, unknown>> | undefined;
      const entry = providers?.[provider];
      if (!entry) return null;
      const modelEntry = Array.isArray(entry.models)
        ? entry.models.find((item) => {
            if (!item || typeof item !== 'object') return false;
            const rec = item as Record<string, unknown>;
            return rec.id === model || rec.name === model || rec.model === model;
          }) as Record<string, unknown> | undefined
        : undefined;
      const baseUrl = (
        typeof modelEntry?.baseUrl === 'string'
          ? modelEntry.baseUrl
          : typeof entry.baseUrl === 'string'
            ? entry.baseUrl
            : ''
      ).replace(/\/+$/, '');
      return {
        provider,
        model,
        api: typeof modelEntry?.api === 'string'
          ? modelEntry.api
          : typeof entry.api === 'string'
            ? entry.api
            : 'openai-completions',
        baseUrl,
        apiKey: typeof modelEntry?.apiKey === 'string'
          ? modelEntry.apiKey
          : typeof entry.apiKey === 'string'
            ? entry.apiKey
            : '',
      };
    } catch {
      return null;
    }
  }

  /** Public wrapper for diagnostics: returns the resolved primary model (no apiKey leaked). */
  getActiveModelInfo(): { provider: string; model: string; api: string; baseUrl: string; has_api_key: boolean } | null {
    const cfg = this.loadCurrentModelConfig();
    if (!cfg) return null;
    return {
      provider: cfg.provider,
      model: cfg.model,
      api: cfg.api,
      baseUrl: cfg.baseUrl,
      has_api_key: Boolean(cfg.apiKey),
    };
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async completeMemorySummary(prompt: string): Promise<string> {
    const modelCfg = this.loadCurrentModelConfig();
    if (!modelCfg?.baseUrl) throw new Error('No configured model for memory extraction');
    this.lastModelInfo = { provider: modelCfg.provider, model: modelCfg.model, api: modelCfg.api };

    if (modelCfg.api === 'anthropic-messages') {
      const baseUrl = modelCfg.baseUrl.replace(/\/v1\/?$/, '');
      const res = await this.fetchWithTimeout(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...(modelCfg.apiKey ? { 'x-api-key': modelCfg.apiKey } : {}),
        },
        body: JSON.stringify({
          model: modelCfg.model,
          max_tokens: 1200,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }],
        }),
      }, 30_000);
      if (!res.ok) throw new Error(`memory extraction model failed: HTTP ${res.status}`);
      const json = await res.json() as { content?: Array<{ text?: string }> };
      return (json.content ?? []).map((part) => part.text ?? '').join('\n').trim();
    }

    if (modelCfg.api === 'openai-completions') {
      const endpoint = modelCfg.baseUrl.endsWith('/chat/completions')
        ? modelCfg.baseUrl
        : `${modelCfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
      const res = await this.fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(modelCfg.apiKey ? { authorization: `Bearer ${modelCfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: modelCfg.model,
          temperature: 0,
          max_tokens: 1200,
          messages: [{ role: 'user', content: prompt }],
        }),
      }, 30_000);
      if (!res.ok) throw new Error(`memory extraction model failed: HTTP ${res.status}`);
      const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      return json.choices?.[0]?.message?.content?.trim() ?? '';
    }
    throw new Error(`Unsupported memory extraction API: ${modelCfg.api}`);
  }

  private extractJsonArray(text: string): unknown[] {
    const trimmed = text.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    const candidate = fenced || trimmed;
    try {
      const parsed = JSON.parse(candidate);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      const start = candidate.indexOf('[');
      const end = candidate.lastIndexOf(']');
      if (start >= 0 && end > start) {
        try {
          const parsed = JSON.parse(candidate.slice(start, end + 1));
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      }
      return [];
    }
  }

  private async drainExtractionQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.extractionQueue.length > 0) {
        const sessionId = this.extractionQueue.shift();
        if (!sessionId) continue;
        this.queuedSessions.delete(sessionId);
        try {
          await this.extractMemoriesNow(sessionId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.lastExtractionStatus = 'failed';
          this.lastExtractionError = message;
          this.lastExtractionAt = new Date().toISOString();
          this.lastExtractionSessionId = sessionId;
          this.lastExtractionCount = 0;
          console.warn(`[SessionMonitoring] AI memory extraction failed for ${sessionId}: ${message}`);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Extract memories from a session using configured LLM, asynchronously.
   */
  private async extractMemories(sessionId: string): Promise<void> {
    if (this.queuedSessions.has(sessionId)) return;
    this.queuedSessions.add(sessionId);
    this.extractionQueue.push(sessionId);
    await this.drainExtractionQueue();
  }

  private async extractMemoriesNow(sessionId: string): Promise<void> {
    this.totalRuns++;
    const events = this.getSessionEvents(sessionId);
    if (events.length === 0) {
      this.lastExtractionStatus = 'noop';
      this.lastExtractionError = null;
      this.lastExtractionAt = new Date().toISOString();
      this.lastExtractionSessionId = sessionId;
      this.lastExtractionCount = 0;
      return;
    }

    const summary = this.buildSessionSummary(events).slice(-11000);
    const prompt = [
      '你是 Research-Claw 记忆提取器。请从以下会话摘要中提取可长期复用的记忆。',
      '仅输出 JSON 数组，不要 markdown，不要解释。最多 5 条。',
      '每条格式：{"type":"user|feedback|project|reference","name":"短标题","description":"一句说明","content":"具体可复用事实","confidence":0.0-1.0,"tags":["..."],"dedupe_key":"稳定去重键"}',
      '忽略寒暄、重复确认、短时上下文与任何敏感信息。',
      '',
      '<session_summary>',
      this.stripPrivateAndSecrets(summary),
      '</session_summary>',
    ].join('\n');

    const output = await this.completeMemorySummary(prompt);
    const items = this.extractJsonArray(output);
    const minConfidence = this.config.min_confidence ?? 0.6;
    const maxMemories = this.config.max_memories_per_session ?? 5;
    let extracted = 0;

    for (const item of items.slice(0, maxMemories)) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const contentRaw = typeof rec.content === 'string' ? this.stripPrivateAndSecrets(rec.content) : '';
      if (!contentRaw || contentRaw.length < 8) continue;
      const confidence = typeof rec.confidence === 'number' && Number.isFinite(rec.confidence)
        ? Math.max(0, Math.min(1, rec.confidence))
        : 0.7;
      if (confidence < minConfidence) continue;
      const type = typeof rec.type === 'string'
        ? this.inferMemoryType(rec.type)
        : this.inferMemoryType(contentRaw);
      const name = typeof rec.name === 'string' && rec.name.trim()
        ? this.summarize(this.stripPrivateAndSecrets(rec.name), 80)
        : this.summarize(contentRaw, 48);
      const description = typeof rec.description === 'string' ? this.stripPrivateAndSecrets(rec.description) : null;
      const tags = Array.isArray(rec.tags)
        ? rec.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0).slice(0, 8)
        : [];
      const dedupeKeySeed = typeof rec.dedupe_key === 'string' && rec.dedupe_key.trim()
        ? rec.dedupe_key
        : `${sessionId}:${type}:${name}:${contentRaw}`;
      this.memoryService.upsertMemory({
        type,
        name,
        description,
        content: this.summarize(contentRaw, type === 'reference' ? 1000 : 1200),
        dedupe_key: `${type}:llm:${this.normalizeKey(dedupeKeySeed)}`,
        tags: ['auto-captured', 'llm-summary', ...tags],
        metadata: {
          source: 'session_monitoring_extract',
          session_id: sessionId,
          extractor_rule: 'llm_semantic_summary',
          confidence,
          extracted_at: new Date().toISOString(),
        },
      });
      extracted++;
    }

    if (extracted > 0) {
      this.db.prepare(
        'UPDATE rc_sessions SET memories_extracted = memories_extracted + ? WHERE id = ?',
      ).run(extracted, sessionId);
      this.totalExtracted += extracted;
    }

    this.lastExtractionAt = new Date().toISOString();
    this.lastExtractionSessionId = sessionId;
    this.lastExtractionCount = extracted;
    this.lastExtractionError = null;
    this.lastExtractionStatus = extracted > 0 ? 'success' : 'noop';

    try {
      this.syncMemoryMarkdown();
    } catch (err) {
      console.warn(`[SessionMonitoring] MEMORY.md sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Incrementally sync the top-N most-recent active memories into MEMORY.md.
   *
   * Only the section between MEMORY_MD_BEGIN/MEMORY_MD_END markers is rewritten;
   * any user-authored content above/below stays intact. If the file does not
   * exist yet, it is created with just the managed section so users can append
   * their own notes around it.
   */
  syncMemoryMarkdown(): { path: string; bytes: number } | null {
    if (!this.workspaceRoot) return null;
    const memoryMdPath = path.join(this.workspaceRoot, 'MEMORY.md');

    const memories = this.memoryService.listMemories({ is_active: true }, 30);
    const grouped: Record<MemoryType, typeof memories> = {
      user: [],
      feedback: [],
      project: [],
      reference: [],
      agent: [],
    };
    for (const m of memories) {
      if (grouped[m.type]) grouped[m.type].push(m);
    }

    const sectionLines: string[] = [];
    sectionLines.push(MEMORY_MD_BEGIN);
    sectionLines.push('');
    sectionLines.push('## 自动记忆（由 Research-Claw 自动维护）');
    sectionLines.push('');
    sectionLines.push(`> 最近更新：${new Date().toISOString()}　来源：会话 LLM 语义提取`);
    sectionLines.push('> 该区块由系统覆盖写入，请勿在标记之间手动编辑。');
    sectionLines.push('');

    const labels: Record<MemoryType, string> = {
      user: '用户偏好',
      feedback: '用户反馈',
      project: '项目进展',
      reference: '资料引用',
      agent: '智能体记录',
    };

    let total = 0;
    for (const type of ['user', 'feedback', 'project', 'reference'] as MemoryType[]) {
      const items = grouped[type].slice(0, 8);
      if (items.length === 0) continue;
      sectionLines.push(`### ${labels[type]} (${items.length})`);
      for (const item of items) {
        total++;
        const summary = this.summarize(item.content.replace(/\n+/g, ' '), 200);
        const tagText = item.tags && item.tags.length > 0
          ? `  \n  标签：${item.tags.map((t) => t.name).join(', ')}`
          : '';
        sectionLines.push(`- **${item.name}** — ${summary}${tagText}`);
      }
      sectionLines.push('');
    }
    if (total === 0) {
      sectionLines.push('_当前没有自动提取的记忆。_');
      sectionLines.push('');
    }
    sectionLines.push(MEMORY_MD_END);

    const newSection = sectionLines.join('\n');

    let existing = '';
    try {
      existing = fs.readFileSync(memoryMdPath, 'utf8');
    } catch {
      existing = '';
    }

    let next: string;
    if (existing.includes(MEMORY_MD_BEGIN) && existing.includes(MEMORY_MD_END)) {
      const before = existing.split(MEMORY_MD_BEGIN)[0];
      const afterParts = existing.split(MEMORY_MD_END);
      const after = afterParts.length > 1 ? afterParts.slice(1).join(MEMORY_MD_END) : '';
      next = `${before}${newSection}${after}`;
    } else if (existing.trim().length === 0) {
      next = `# Research-Claw 项目记忆\n\n该文件由 Research-Claw 自动维护：标记之间为系统写入区，外部内容保留为用户笔记。\n\n${newSection}\n`;
    } else {
      next = `${existing.trimEnd()}\n\n${newSection}\n`;
    }

    fs.mkdirSync(path.dirname(memoryMdPath), { recursive: true });
    fs.writeFileSync(memoryMdPath, next, 'utf8');
    this.memoryMdLastSyncedAt = new Date().toISOString();
    return { path: memoryMdPath, bytes: Buffer.byteLength(next, 'utf8') };
  }

  /**
   * Build a summary of a session for analysis.
   */
  private buildSessionSummary(events: SessionEvent[]): string {
    const lines: string[] = [];

    for (const event of events) {
      switch (event.event_type) {
        case 'user_prompt': {
          const data = event.data as unknown as UserPromptEvent;
          lines.push(`User: ${data.content}`);
          break;
        }
        case 'assistant_response': {
          const data = event.data as unknown as AssistantResponseEvent;
          lines.push(`Assistant: ${data.content.substring(0, 200)}...`);
          break;
        }
        case 'tool_use': {
          const data = event.data as unknown as ToolUseEvent;
          lines.push(`Tool: ${data.tool_name}`);
          break;
        }
        default:
          break;
      }
    }

    return lines.join('\n');
  }

  // ── Configuration ───────────────────────────────────────────────────────

  /**
   * Update the extraction configuration.
   */
  updateConfig(config: Partial<MemoryExtractionConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get the current configuration.
   */
  getConfig(): MemoryExtractionConfig {
    return { ...this.config };
  }
}
