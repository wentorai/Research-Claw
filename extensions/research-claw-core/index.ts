/**
 * Research-Claw Core Plugin — Entry Point
 *
 * Registers all tools, RPC methods, hooks, services, and HTTP routes
 * for the literature library, task system, and workspace tracking.
 *
 * Registration totals:
 *   - 40 agent tools (17 literature + 10 task + 7 workspace + 5 monitor + 1 skill_search)
 *   - 92 WS RPC methods + 2 HTTP routes = 94 interface methods
 *     (rc.lit.* + rc.task.* + rc.cron.* + rc.notifications.* + rc.heartbeat.* + rc.ws.* + rc.monitor.* + rc.ppt.* + rc.oauth.* + rc.model.* + rc.app.* + rc.session.* = 92 WS; POST /rc/upload + GET /rc/download = 2 HTTP)
 *   - 10 hooks (before_prompt_build, session_start, session_end, before_tool_call, agent_end, after_tool_call ×3, gateway_start, agent:bootstrap)
 *   - 1 service (research-claw-db lifecycle)
 *   - 1 session monitoring service (automatic memory extraction)
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { createDatabaseManager, type DatabaseManager } from './src/db/connection.js';
import { runMigrations } from './src/db/migrations.js';
import { LiteratureService } from './src/literature/service.js';
import { createLiteratureTools } from './src/literature/tools.js';
import { registerLiteratureRpc } from './src/literature/rpc.js';
import { TaskService } from './src/tasks/service.js';
import { createTaskTools } from './src/tasks/tools.js';
import { registerTaskRpc } from './src/tasks/rpc.js';
import { HeartbeatService } from './src/tasks/heartbeat.js';
import { WorkspaceService, type WorkspaceConfig } from './src/workspace/service.js';
import { createWorkspaceTools } from './src/workspace/tools.js';
import { registerWorkspaceRpc } from './src/workspace/rpc.js';
import { MonitorService } from './src/monitor/service.js';
import { registerMonitorRpc } from './src/monitor/rpc.js';
import { createMonitorTools } from './src/monitor/tools.js';
import { PptService } from './src/ppt/service.js';
import { registerPptRpc } from './src/ppt/rpc.js';
import { createPptTools } from './src/ppt/tools.js';
import type { RegisterMethod } from './src/types.js';
import { initSkillIndex, searchSkills, readSkillContent, getSkillCatalogSummary } from './src/skills/search.js';
import { checkUpdates, applyUpdate, findGitRoot, isUpdateRunning } from './src/app-updates.js';
import {
  oauthInitiate,
  oauthComplete,
  oauthStatus,
  apiKeyStatus,
  apiKeyStatuses,
  setApiKeyProfile,
  clearApiKeyProfile,
} from './src/oauth/service.js';
import { MemoryService, SessionMonitoringService, registerMemoryRpcMethods, registerSessionRpcMethods, type MemoryType } from './src/memory/index.js';
import { ClaudeMemSyncService } from './src/memory/claude-mem-sync.js';
import { hydrateDashboardSystemPromptFromConfigPath } from './src/dashboard/config.js';
import { formatDashboardSystemPromptBlock } from './src/dashboard/prompt-append.js';
import { TASK_FLOW_AGENT_GUIDANCE } from './src/tasks/task-flow-prompt.js';
import { registerDashboardRpc } from './src/dashboard/rpc.js';
import { PaperReviewService } from './src/paper-review/service.js';
import { registerPaperReviewRpc } from './src/paper-review/rpc.js';
import { resolveWorkspaceRoot } from './src/workspace/resolve-root.js';
import { registerProviderRpc } from './src/provider/rpc.js';

// ── Plugin config shape ────────────────────────────────────────────────

interface PluginConfig {
  dbPath?: string;
  autoTrackGit?: boolean;
  defaultCitationStyle?: string;
  heartbeatDeadlineWarningHours?: number;
  pptRoot?: string;
  workspace?: {
    root?: string;
    commitDebounceMs?: number;
    maxGitFileSize?: number;
    maxUploadSize?: number;
    gitAuthorName?: string;
    gitAuthorEmail?: string;
  };
}

/** Experimental memory module — enable with RC_ENABLE_MEMORY=1 (off in Docker by default). */
const MEMORY_MODULE_ENABLED = process.env.RC_ENABLE_MEMORY === '1';

// ── Minimal plugin API types (locally defined, contract-compatible) ────

interface PluginLogger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

interface PluginApi {
  id: string;
  name: string;
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  runtime: {
    config: {
      current: () => Record<string, unknown>;
      mutateConfigFile: (params: {
        afterWrite: { mode: 'auto' };
        mutate: (draft: Record<string, unknown>) => void;
      }) => Promise<{
        path: string;
        persistedHash: string | null;
        afterWrite?: unknown;
        followUp?: unknown;
      }>;
    };
  };
  resolvePath: (input: string) => string;
  registerTool: (tool: unknown) => void;
  registerGatewayMethod: (method: string, handler: unknown) => void;
  registerHttpRoute: (params: {
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void> | boolean | void;
    auth: 'gateway' | 'plugin';
    match?: 'exact' | 'prefix';
  }) => void;
  registerService: (service: {
    id: string;
    start: (ctx: { stateDir: string; logger: PluginLogger }) => void | Promise<void>;
    stop?: (ctx: { stateDir: string; logger: PluginLogger }) => void | Promise<void>;
  }) => void;
  on: (hookName: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }) => void;
  registerHook?: (
    events: string | string[],
    handler: (event: { type: string; action: string; context: Record<string, unknown> }) => void | Promise<void>,
    opts?: { name?: string; description?: string },
  ) => void;
}

interface PluginDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  contracts?: {
    tools?: string[];
  };
  register?: (api: PluginApi) => void | Promise<void>;
}

// ── Module-level state (survives multiple register() calls per boot) ──────
// OC calls register() multiple times per gateway boot (full + discovery
// registration modes). jiti loads .ts directly so module scope persists
// across calls. All stateful resources (DB, services, workspace) must be
// initialized once and reused — creating duplicates wastes file handles
// and causes git lock races.
let _initialized = false;
let _registrationDone = false;
let _dbManager: DatabaseManager | null = null;
let _litService: InstanceType<typeof LiteratureService> | null = null;
let _taskService: InstanceType<typeof TaskService> | null = null;
let _heartbeatService: InstanceType<typeof HeartbeatService> | null = null;
let _monitorService: InstanceType<typeof MonitorService> | null = null;
let _wsService: InstanceType<typeof WorkspaceService> | null = null;
let _wsConfig: WorkspaceConfig | null = null;
let _wsInitPromise: Promise<void> | null = null;
let _pptService: InstanceType<typeof PptService> | null = null;
let _sessionService: InstanceType<typeof SessionMonitoringService> | null = null;
let _memoryService: InstanceType<typeof MemoryService> | null = null;
let _claudeMemSyncService: ClaudeMemSyncService | null = null;
let _reviewService: PaperReviewService | null = null;

// ── Tool call probe state ─────────────────────────────────────────────
// Caches Ollama tool-calling probe results per model string (30-min TTL).
// _lastProbeResult is read by before_prompt_build to inject agent warnings.
const PROBE_TTL_MS = 30 * 60 * 1000;
let _toolCallProbeCache = new Map<string, { supported: boolean; model: string; provider: string; testedAt: number }>();
let _lastProbeResult: { supported: boolean; model: string } | null = null;
const _memoryRecordedMessageCounts = new Map<string, number>();

// ── Error resilience: context injection + degradation hints ──────────
// Track tool failures within a session. When the same tool fails
// repeatedly, inject a hint into the result telling the model to
// try an alternative approach. This prevents the "hitting the same
// wall" pattern that frustrates users.

interface ToolErrorEntry {
  tool: string;
  error: string;
  ts: number;
}

const _toolErrorLog: ToolErrorEntry[] = [];
const ERROR_LOG_MAX = 50; // cap memory usage

type AutoMemoryCandidate = {
  type: MemoryType;
  name: string;
  description: string;
  content: string;
  dedupe_key: string;
  tags: string[];
  metadata: Record<string, unknown>;
  confidence: number;
};

type MemorySummaryLogger = Pick<PluginLogger, 'info' | 'warn' | 'error'>;

type LlmMemoryJob = {
  memoryService: InstanceType<typeof MemoryService>;
  configPath: string;
  logger: MemorySummaryLogger;
  userTexts: string[];
  assistantTexts: string[];
  metadata: Record<string, unknown>;
};

type HookLogSource = 'all' | 'claude-mem' | 'research-claw-core';
type HookLogItem = { ts: string; source: 'claude-mem' | 'research-claw-core'; line: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractMessageText(message: unknown): string {
  if (!isRecord(message)) return '';
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!isRecord(part)) return '';
        const text = part.text ?? part.content;
        return typeof text === 'string' ? text : '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

function summarizeForMemory(text: string, maxLength = 700): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1)}...`;
}

function compactUnknown(value: unknown, maxLength = 1200): unknown {
  if (typeof value === 'string') return summarizeForMemory(value, maxLength);
  try {
    const text = JSON.stringify(value);
    return summarizeForMemory(text, maxLength);
  } catch {
    return String(value);
  }
}

function stripPrivateAndSecrets(text: string): string {
  return text
    .replace(/<private>[\s\S]*?<\/private>/gi, '[private omitted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9._~+/=-]{12,}/g, 'sk-[REDACTED]')
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s,;]+/gi, '$1=[REDACTED]')
    .trim();
}

function normalizeKey(text: string, maxLength = 140): string {
  return text
    .toLowerCase()
    .replace(/<private>[\s\S]*?<\/private>/gi, '')
    .replace(/\bsk-[A-Za-z0-9._~+/=-]{12,}/g, 'sk-redacted')
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s:/._-]/gu, '')
    .trim()
    .slice(0, maxLength);
}

function inferMemoryType(text: string): MemoryType {
  const lower = text.toLowerCase();
  if (/(偏好|习惯|以后都|以后请|我希望|我喜欢|我不喜欢|prefer|preference|always|never)/i.test(text)) {
    return 'user';
  }
  if (/(不对|错误|失败|不满意|应该|不要再|修复|bug|报错|failed|wrong|fix)/i.test(text)) {
    return 'feedback';
  }
  if (/(https?:\/\/|doi:|arxiv|zotero|endnote|bibtex|文献|论文|reference|citation)/i.test(text)) {
    return 'reference';
  }
  return lower.includes('project') || /(项目|课题|研究|实验|数据|任务|进度|开题|基金)/.test(text)
    ? 'project'
    : 'project';
}

function memoryTitleFor(type: MemoryType, text: string): string {
  const prefix: Record<MemoryType, string> = {
    user: '用户偏好',
    feedback: '用户反馈',
    project: '项目进展',
    reference: '资料引用',
    agent: '智能体记录',
  };
  return `${prefix[type]}：${summarizeForMemory(text, 44)}`;
}

function looksLowValueMemory(text: string): boolean {
  const compact = text.replace(/\s+/g, '').trim();
  if (compact.length < 8) return true;
  return /^(继续|好的|可以|确认|谢谢|ok|yes|no|嗯|好)$/i.test(compact);
}

function pushMemoryCandidate(
  memories: AutoMemoryCandidate[],
  candidate: {
    type: MemoryType;
    text: string;
    description: string;
    dedupeSeed?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
    confidence: number;
  },
) {
  const text = stripPrivateAndSecrets(candidate.text);
  if (looksLowValueMemory(text)) return;
  memories.push({
    type: candidate.type,
    name: memoryTitleFor(candidate.type, text),
    description: candidate.description,
    content: summarizeForMemory(text, candidate.type === 'reference' ? 1000 : 900),
    dedupe_key: `${candidate.type}:${normalizeKey(candidate.dedupeSeed ?? text)}`,
    tags: ['auto-captured', 'compressed', ...(candidate.tags ?? [])],
    metadata: {
      ...(candidate.metadata ?? {}),
      confidence: candidate.confidence,
    },
    confidence: candidate.confidence,
  });
}

function buildAutoMemories(params: {
  userTexts: string[];
  assistantTexts: string[];
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  channelId?: string;
  durationMs?: number;
}): AutoMemoryCandidate[] {
  const lastUserRaw = params.userTexts.at(-1) ?? '';
  const lastAssistantRaw = params.assistantTexts.at(-1) ?? '';
  const lastUser = stripPrivateAndSecrets(lastUserRaw);
  const lastAssistant = stripPrivateAndSecrets(lastAssistantRaw);
  const combined = [lastUser, lastAssistant].filter(Boolean).join('\n\n');
  if (!combined.trim() || combined === '[private omitted]') return [];

  const baseMetadata = {
    source: 'agent_end_hook',
    session_key: params.sessionKey,
    session_id: params.sessionId,
    agent_id: params.agentId,
    channel_id: params.channelId,
    duration_ms: params.durationMs,
    captured_at: new Date().toISOString(),
    compression: 'structured-heuristic-v2',
  };

  const memories: AutoMemoryCandidate[] = [];

  const allUserText = stripPrivateAndSecrets(params.userTexts.join('\n'));
  const allAssistantText = stripPrivateAndSecrets(params.assistantTexts.join('\n'));

  for (const raw of params.userTexts) {
    const text = stripPrivateAndSecrets(raw);
    if (/(偏好|习惯|以后都|以后请|我希望|我喜欢|我不喜欢|默认|每次|prefer|preference|always|never)/i.test(text)) {
      pushMemoryCandidate(memories, {
        type: 'user',
        text,
        description: '用户明确表达的长期偏好或使用习惯。',
        tags: ['user-preference'],
        metadata: { ...baseMetadata, extractor_rule: 'explicit_user_preference' },
        confidence: 0.88,
      });
    }

    if (/(不对|错了|错误|失败|不满意|不要再|以后不要|应该|修复|bug|报错|failed|wrong|fix)/i.test(text)) {
      pushMemoryCandidate(memories, {
        type: 'feedback',
        text,
        description: '用户对系统行为、工具选择或回答质量的反馈。',
        tags: ['feedback'],
        metadata: { ...baseMetadata, extractor_rule: 'explicit_feedback' },
        confidence: 0.84,
      });
    }
  }

  const projectSeed = [
    lastUser ? `用户目标：${summarizeForMemory(lastUser, 420)}` : '',
    lastAssistant ? `处理结果：${summarizeForMemory(lastAssistant, 620)}` : '',
  ].filter(Boolean).join('\n\n');
  const projectConfidence =
    /(项目|课题|研究|实验|数据|任务|进度|论文|文献|开题|基金|zotero|rc|research-claw)/i.test(projectSeed)
      ? 0.76
      : 0.58;
  if (projectConfidence >= 0.65) {
    pushMemoryCandidate(memories, {
      type: 'project',
      text: projectSeed,
      description: '本轮会话中形成的项目状态、任务进展或技术结论。',
      dedupeSeed: lastUser || projectSeed,
      tags: ['project-context'],
      metadata: { ...baseMetadata, extractor_rule: 'project_turn_summary' },
      confidence: projectConfidence,
    });
  }

  const urls = Array.from(combined.matchAll(/https?:\/\/[^\s)]+/g)).map((m) => m[0]).slice(0, 3);
  for (const url of urls) {
    pushMemoryCandidate(memories, {
      type: 'reference',
      text: url,
      description: '会话中提到的外部资源链接。',
      dedupeSeed: `url:${url}`,
      tags: ['reference'],
      metadata: { ...baseMetadata, url, extractor_rule: 'url_reference' },
      confidence: 0.92,
    });
  }

  const seen = new Set<string>();
  return memories
    .filter((memory) => memory.confidence >= 0.65)
    .filter((memory) => {
      if (seen.has(memory.dedupe_key)) return false;
      seen.add(memory.dedupe_key);
      return true;
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);
}

function extractJsonArray(text: string): unknown[] {
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

function coerceLlmMemories(raw: unknown[], baseMetadata: Record<string, unknown>): AutoMemoryCandidate[] {
  const validTypes = new Set<MemoryType>(['user', 'feedback', 'project', 'reference']);
  const memories: AutoMemoryCandidate[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const type = typeof item.type === 'string' && validTypes.has(item.type as MemoryType)
      ? item.type as MemoryType
      : 'project';
    const content = stripPrivateAndSecrets(typeof item.content === 'string' ? item.content : '');
    if (looksLowValueMemory(content)) continue;
    const confidence = typeof item.confidence === 'number' && Number.isFinite(item.confidence)
      ? Math.max(0, Math.min(1, item.confidence))
      : 0.7;
    if (confidence < 0.65) continue;

    const nameText = typeof item.name === 'string' && item.name.trim()
      ? stripPrivateAndSecrets(item.name)
      : memoryTitleFor(type, content);
    const tags = Array.isArray(item.tags)
      ? item.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0).slice(0, 8)
      : [];
    const dedupeSeed = typeof item.dedupe_key === 'string' && item.dedupe_key.trim()
      ? item.dedupe_key
      : `${type}:${nameText}:${content}`;

    memories.push({
      type,
      name: summarizeForMemory(nameText, 80),
      description: typeof item.description === 'string' && item.description.trim()
        ? stripPrivateAndSecrets(item.description)
        : '由 LLM 从会话中语义压缩生成。',
      content: summarizeForMemory(content, type === 'reference' ? 1000 : 1200),
      dedupe_key: `${type}:llm:${normalizeKey(dedupeSeed, 180)}`,
      tags: ['auto-captured', 'llm-summary', ...tags],
      metadata: {
        ...baseMetadata,
        confidence,
        compression: 'llm-summary-v1',
        extractor_rule: 'llm_semantic_summary',
      },
      confidence,
    });
  }
  return memories.slice(0, 5);
}

function loadCurrentModelConfig(configPath: string): {
  provider: string;
  model: string;
  api: string;
  baseUrl: string;
  apiKey: string;
} | null {
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
          if (!isRecord(item)) return false;
          return item.id === model || item.name === model || item.model === model;
        }) as Record<string, unknown> | undefined
      : undefined;
    return {
      provider,
      model,
      api: typeof modelEntry?.api === 'string'
        ? modelEntry.api
        : typeof entry.api === 'string'
          ? entry.api
          : 'openai-completions',
      baseUrl: (typeof modelEntry?.baseUrl === 'string' ? modelEntry.baseUrl : typeof entry.baseUrl === 'string' ? entry.baseUrl : '').replace(/\/+$/, ''),
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

function buildMemorySummaryPrompt(userTexts: string[], assistantTexts: string[]): string {
  const user = stripPrivateAndSecrets(userTexts.join('\n\n')).slice(-5000);
  const assistant = stripPrivateAndSecrets(assistantTexts.join('\n\n')).slice(-7000);
  return [
    '你是 Research-Claw 的长期记忆提取器。请从下面这轮会话中提取对未来科研协作有长期价值的记忆。',
    '只输出 JSON 数组，不要 markdown，不要解释。',
    '每条格式：{"type":"user|feedback|project|reference","name":"短标题","description":"一句说明","content":"可长期复用的具体事实/偏好/结论","confidence":0.0-1.0,"tags":["..."],"dedupe_key":"稳定去重键"}',
    '只保留明确、有用、可复用的信息。忽略寒暄、短确认、临时状态和敏感内容。最多 5 条。',
    '',
    '<user_messages>',
    user,
    '</user_messages>',
    '',
    '<assistant_messages>',
    assistant,
    '</assistant_messages>',
  ].join('\n');
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function completeMemorySummaryWithConfiguredModel(configPath: string, prompt: string): Promise<string> {
  const modelCfg = loadCurrentModelConfig(configPath);
  if (!modelCfg?.baseUrl) throw new Error('No configured model found for memory summary');

  if (modelCfg.api === 'anthropic-messages') {
    const baseUrl = modelCfg.baseUrl.replace(/\/v1\/?$/, '');
    const res = await fetchWithTimeout(`${baseUrl}/v1/messages`, {
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
    if (!res.ok) throw new Error(`memory summary model failed: HTTP ${res.status}`);
    const json = await res.json() as { content?: Array<{ text?: string; type?: string }> };
    return (json.content ?? []).map((part) => part.text ?? '').join('\n').trim();
  }

  if (modelCfg.api === 'openai-completions') {
    const endpoint = modelCfg.baseUrl.endsWith('/chat/completions')
      ? modelCfg.baseUrl
      : `${modelCfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const res = await fetchWithTimeout(endpoint, {
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
    if (!res.ok) throw new Error(`memory summary model failed: HTTP ${res.status}`);
    const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content?.trim() ?? '';
  }

  throw new Error(`Unsupported memory summary API: ${modelCfg.api}`);
}

async function runLlmMemorySummaryJob(job: LlmMemoryJob): Promise<void> {
  const prompt = buildMemorySummaryPrompt(job.userTexts, job.assistantTexts);
  const output = await completeMemorySummaryWithConfiguredModel(job.configPath, prompt);
  const raw = extractJsonArray(output);
  const memories = coerceLlmMemories(raw, job.metadata);
  if (memories.length === 0) {
    job.logger.info('[MemorySummary] LLM summary returned no durable memories');
    return;
  }
  for (const memory of memories) {
    job.memoryService.upsertMemory({
      type: memory.type,
      name: memory.name,
      description: memory.description,
      content: memory.content,
      metadata: memory.metadata,
      dedupe_key: memory.dedupe_key,
      tags: memory.tags,
    });
  }
  job.logger.info(`[MemorySummary] LLM summary stored ${memories.length} memory item(s)`);
}

class MemorySummaryQueue {
  private jobs: LlmMemoryJob[] = [];
  private running = false;

  enqueue(job: LlmMemoryJob): void {
    this.jobs.push(job);
    if (this.jobs.length > 20) this.jobs.splice(0, this.jobs.length - 20);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length > 0) {
        const job = this.jobs.shift();
        if (!job) continue;
        try {
          await runLlmMemorySummaryJob(job);
        } catch (err) {
          job.logger.warn(`[MemorySummary] LLM summary failed; heuristic memory kept: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

const _memorySummaryQueue = new MemorySummaryQueue();

function collectHookLogItems(source: HookLogSource, limit: number): HookLogItem[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(10, Math.min(1000, Math.floor(limit))) : 120;
  const logPaths = [
    path.join(os.homedir(), '.openclaw', 'logs', 'gateway.log'),
    path.join(os.homedir(), '.openclaw', 'logs', 'gateway.err.log'),
  ];
  const lines: string[] = [];
  for (const p of logPaths) {
    if (!fs.existsSync(p)) continue;
    try {
      const content = fs.readFileSync(p, 'utf8');
      const parts = content.split('\n').filter(Boolean);
      lines.push(...parts.slice(-2200));
    } catch {
      // Best-effort: skip unreadable log path.
    }
  }

  const wantsClaude = source === 'all' || source === 'claude-mem';
  const wantsRcCore = source === 'all' || source === 'research-claw-core';
  const matches: HookLogItem[] = [];
  for (const line of lines) {
    if (wantsClaude && line.includes('[claude-mem]')) {
      const ts = line.slice(0, 29).trim();
      matches.push({ ts, source: 'claude-mem', line });
    } else if (
      wantsRcCore &&
      (
        line.includes('[SessionMonitoring]') ||
        line.includes('[MemorySummary]') ||
        line.includes('Research-Claw Core initializing') ||
        line.includes('Research-Claw Core registered')
      )
    ) {
      const ts = line.slice(0, 29).trim();
      matches.push({ ts, source: 'research-claw-core', line });
    }
  }
  return matches.slice(-safeLimit);
}

function interpretHookLogForMemory(line: string, source: 'claude-mem' | 'research-claw-core'): {
  title: string;
  description: string;
  severity: 'info' | 'warn' | 'error';
} {
  const msg = line.replace(/^\d{4}-\d{2}-\d{2}T[^\s]+\s*/, '').replace(/\[[^\]]+\]\s*/g, '').trim();
  const lower = msg.toLowerCase();
  if (lower.includes('failed') || lower.includes('error:')) {
    return { title: '插件执行失败', description: msg || '插件执行出现错误。', severity: 'error' };
  }
  if (lower.includes('timeout') || lower.includes('closed before connect')) {
    return { title: '连接异常事件', description: msg || '连接链路出现异常或超时。', severity: 'warn' };
  }
  if (lower.includes('persist') || lower.includes('sync') || lower.includes('injected') || lower.includes('inject')) {
    return { title: '记忆链路事件', description: msg || '记忆链路发生一次持久化或注入。', severity: 'info' };
  }
  return {
    title: source === 'claude-mem' ? 'Claude-mem 观察事件' : 'Research-Claw Core 事件',
    description: msg || line,
    severity: 'info',
  };
}

function syncHookLogsIntoMemories(params: {
  memoryService: InstanceType<typeof MemoryService>;
  source: HookLogSource;
  limit: number;
  logger: MemorySummaryLogger;
}): { synced: number; source: HookLogSource; scanned: number } {
  const items = collectHookLogItems(params.source, params.limit);
  let synced = 0;
  for (const item of items) {
    const interpreted = interpretHookLogForMemory(item.line, item.source);
    const digest = createHash('sha256').update(`${item.source}|${item.ts}|${item.line}`).digest('hex').slice(0, 24);
    const name = `[${item.source}] ${interpreted.title}`.slice(0, 120);
    const memoryType: MemoryType = interpreted.severity === 'error' ? 'feedback' : 'project';
    params.memoryService.upsertMemory({
      type: memoryType,
      name,
      description: interpreted.description.slice(0, 200),
      content: item.line,
      dedupe_key: `${memoryType}:hook-log:${digest}`,
      tags: ['auto-captured', 'hook-log', 'agent-log', item.source, interpreted.severity],
      metadata: {
        source: 'hook_log_bridge',
        hook_source: item.source,
        hook_ts: item.ts || null,
        severity: interpreted.severity,
        extractor_rule: 'hook_log_bridge_v1',
        captured_at: new Date().toISOString(),
      },
      is_private: false,
    });
    synced++;
  }
  params.logger.info(`[HookLogBridge] Synced ${synced}/${items.length} hook logs into memory view`);
  return { synced, source: params.source, scanned: items.length };
}

// Degradation hints: when tool X fails, suggest tool Y
// ── Tool call dedup state (module-level for cross-hook visibility) ────
let _lastToolSig: string | null = null;
let _lastToolCount = 0;

const DEGRADATION_HINTS: Record<string, string> = {
  'search_arxiv': 'Try search_crossref or search_openalex instead.',
  'search_crossref': 'Try search_openalex or search_europe_pmc instead.',
  'search_openalex': 'Try search_crossref or search_europe_pmc instead.',
  'search_pubmed': 'Try search_europe_pmc or search_crossref instead.',
  'search_europe_pmc': 'Try search_pubmed or search_crossref instead.',
  'search_dblp': 'Try search_arxiv or search_crossref instead.',
  'search_biorxiv': 'Try search_pubmed or search_europe_pmc instead.',
  'search_inspire': 'Try search_arxiv instead.',
  'search_hal': 'Try search_openaire or search_crossref instead.',
  'search_zenodo': 'Try search_datacite instead.',
  'search_datacite': 'Try search_zenodo instead.',
  'library_zotero_import': 'Try library_import_bibtex or library_import_ris as a manual fallback.',
  'library_zotero_detect': 'Zotero may not be installed or accessible. Try BibTeX/RIS import instead.',
  'library_endnote_detect': 'EndNote may not be installed. Try BibTeX/RIS import instead.',
  'library_endnote_import': 'Try library_import_bibtex or library_import_ris instead.',
  'browser': 'Browser may be unavailable. Try web_fetch for the URL, or use an API tool from Layer 1.',
  'workspace_export': 'Export may have failed. Try workspace_save as markdown first, then convert manually.',
  'ppt_init': 'PPT service may not be configured. Save content as markdown and inform the user.',
  'ppt_export': 'PPT export failed. Try saving as markdown and suggest manual conversion.',
};

function resolvePptRoot(api: PluginApi, cfg: PluginConfig): string {
  // Prefer a repo checked out at RC root: ./ppt-master (submodule or clone).
  // Keep backward compatibility: ./integrations/ppt-master.
  const userProvided = cfg.pptRoot ? api.resolvePath(cfg.pptRoot) : null;
  const candidates = [
    userProvided,
    api.resolvePath('ppt-master'),
    api.resolvePath('integrations/ppt-master'),
  ].filter(Boolean) as string[];

  for (const root of candidates) {
    // "pptRoot" must contain the skill scripts at skills/ppt-master/scripts/.
    const pm = path.join(root, 'skills', 'ppt-master', 'scripts', 'project_manager.py');
    const svg = path.join(root, 'skills', 'ppt-master', 'scripts', 'svg_to_pptx.py');
    if (fs.existsSync(pm) && fs.existsSync(svg)) return root;
  }
  // Fall back to the first candidate even if incomplete, so status() can show what's missing.
  return candidates[0] ?? api.resolvePath('integrations/ppt-master');
}

// ── Plugin definition ──────────────────────────────────────────────────

const DEFAULT_RC_DB_PATH = path.join(os.homedir(), '.research-claw', 'library.db');

const plugin: PluginDefinition = {
  id: 'research-claw-core',
  name: 'Research-Claw Core',
  description: 'Literature library, task management, and workspace tracking for academic research',
  version: '0.7.0',
  contracts: {
    tools: ['task_flow_stage'],
  },

  register(api) {
    const cfg = (api.pluginConfig ?? {}) as PluginConfig;
    const rawDbPath = typeof cfg.dbPath === 'string' && cfg.dbPath.trim()
      ? cfg.dbPath.trim()
      : DEFAULT_RC_DB_PATH;
    const dbPath = rawDbPath.startsWith('~/')
      ? path.join(os.homedir(), rawDbPath.slice(2))
      : api.resolvePath(rawDbPath);
    const deadlineWarningHours = cfg.heartbeatDeadlineWarningHours ?? 48;

    api.logger.info(`Research-Claw Core initializing (db: ${dbPath})`);

    // ── 1. Initialize stateful resources (once per process) ──────────
    // OC calls register() 2× per gateway boot (full + discovery mode).
    // jiti loads .ts as ESM — module scope persists across calls.
    // All stateful resources are created once and reused to avoid:
    //   - Duplicate SQLite connections (file handle leak)
    //   - Duplicate git-tracker inits (config lock race)
    //   - Duplicate seedDefaults() calls
    if (!_initialized) {
      _dbManager = createDatabaseManager(dbPath);
      runMigrations(_dbManager.db);

      _litService = new LiteratureService(_dbManager.db);
      _taskService = new TaskService(_dbManager.db);
      _heartbeatService = new HeartbeatService(_dbManager.db);
      _monitorService = new MonitorService(_dbManager.db);
      _monitorService.seedDefaults();

      _wsConfig = {
        root: resolveWorkspaceRoot(api, cfg.workspace?.root),
        autoTrackGit: cfg.autoTrackGit ?? true,
        commitDebounceMs: cfg.workspace?.commitDebounceMs ?? 5000,
        maxGitFileSize: cfg.workspace?.maxGitFileSize ?? 10_485_760,
        maxUploadSize: cfg.workspace?.maxUploadSize ?? 0,
        gitAuthorName: cfg.workspace?.gitAuthorName ?? 'Research-Claw',
        gitAuthorEmail: cfg.workspace?.gitAuthorEmail ?? 'research-claw@wentor.ai',
      };
      _wsService = new WorkspaceService(_wsConfig);
      _reviewService = new PaperReviewService(_dbManager.db, _wsService);
      _pptService = new PptService({
        pptRoot: resolvePptRoot(api, cfg),
        workspaceRoot: _wsConfig.root,
        repoRoot: api.resolvePath('.'),
      });

      if (MEMORY_MODULE_ENABLED) {
        // Initialize session monitoring service. Wire workspace root + config
        // path so the LLM extractor knows where to write MEMORY.md and how to
        // resolve the active model from openclaw.json.
        _memoryService = new MemoryService(_dbManager.db);
        _claudeMemSyncService = new ClaudeMemSyncService(_dbManager.db, {
          workerUrl: 'http://127.0.0.1:37777',
        });
        const sessionConfigPath =
          process.env.OPENCLAW_CONFIG_PATH ||
          path.join(findGitRoot(api.resolvePath('.')), 'config', 'openclaw.json');
        _sessionService = new SessionMonitoringService(_dbManager.db, {
          workspaceRoot: _wsConfig.root,
          configPath: sessionConfigPath,
        });
      }

      // Fire-and-forget: scaffold directories + git tracker in background.
      // MUST NOT await — OC plugin loader does not support async register().
      _wsInitPromise = _wsService.init().catch((err) => {
        api.logger.error(`Workspace init failed: ${err instanceof Error ? err.message : String(err)}`);
      });

      // Safety net: checkpoint WAL on process exit (last-resort).
      // The service stop() callback handles clean shutdown via OC's close chain.
      // This 'exit' handler catches edge cases where process.exit() is called
      // before stop() runs (e.g., uncaught exception handler).
      // NOTE: Do NOT register SIGTERM/SIGINT here — that would preempt
      // OpenClaw's own graceful shutdown sequence (channel teardown, WS drain).
      // SIGKILL durability is handled by synchronous=FULL in connection.ts.
      process.once('exit', () => {
        try {
          if (_dbManager?.isOpen()) {
            _dbManager.db.pragma('wal_checkpoint(TRUNCATE)');
            _dbManager.close();
          }
        } catch { /* best-effort on exit */ }
      });

      _initialized = true;
    }

    // Local aliases for the rest of register() — guaranteed non-null after init
    const dbManager = _dbManager!;
    const litService = _litService!;
    const taskService = _taskService!;
    const heartbeatService = _heartbeatService!;
    const monitorService = _monitorService!;
    const wsService = _wsService!;
    const reviewService = _reviewService!;
    const pptService = _pptService!;
    const wsConfig = _wsConfig!;

    // ── 3. Register database lifecycle service ───────────────────────
    api.registerService({
      id: 'research-claw-db',
      start() {
        if (dbManager?.isOpen()) {
          const result = dbManager.db.pragma('integrity_check') as Array<{ integrity_check: string }>;
          if (result[0]?.integrity_check !== 'ok') {
            api.logger.warn('Database integrity check returned warnings');
          }
        }
      },
      stop() {
        wsService.destroy();
        if (_dbManager?.isOpen()) {
          // Checkpoint WAL before closing to ensure all data is flushed to the main DB file
          _dbManager.db.pragma('wal_checkpoint(TRUNCATE)');
          _dbManager.close();
          api.logger.info('Research-Claw database closed');
        }
        // Reset module-level state so a fresh gateway restart re-initializes
        _dbManager = null;
        _litService = null;
        _taskService = null;
        _heartbeatService = null;
        _monitorService = null;
        _wsService = null;
        _pptService = null;
        _memoryService = null;
        _sessionService = null;
        _claudeMemSyncService = null;
        _wsConfig = null;
        _wsInitPromise = null;
        _toolCallProbeCache = new Map();
        _lastProbeResult = null;
        _toolErrorLog.length = 0;
        _initialized = false;
        _registrationDone = false;
      },
    });

    if (!_registrationDone) {
    // ── 4. Register tools (40 total) ─────────────────────────────────
    for (const tool of createLiteratureTools(litService)) {
      api.registerTool(tool);
    }
    for (const tool of createTaskTools(taskService)) {
      api.registerTool(tool);
    }
    for (const tool of createWorkspaceTools(wsService)) {
      api.registerTool(tool);
    }
    for (const tool of createMonitorTools(monitorService)) {
      api.registerTool(tool);
    }
    for (const tool of createPptTools(pptService)) {
      api.registerTool(tool);
    }

    // ── 4b. Skill Search tool ─────────────────────────────────────────
    // On-demand skill loading: searches research-plugins catalog and
    // returns SKILL.md content so the agent can load methodology guidance
    // beyond what fits in the initial prompt (~150 of 438 skills).
    {
      const rpCandidates = [
        path.join(api.resolvePath('..'), 'research-plugins'),
        path.join(api.resolvePath('.'), 'node_modules', '@wentorai', 'research-plugins'),
      ];
      const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? '';
      if (homeDir) {
        rpCandidates.push(
          path.join(homeDir, '.openclaw', 'extensions', 'research-plugins'),
        );
      }

      let rpRoot: string | null = null;
      for (const candidate of rpCandidates) {
        if (fs.existsSync(path.join(candidate, 'catalog.json'))) {
          rpRoot = candidate;
          break;
        }
      }

      if (!rpRoot) {
        api.logger.warn('[SkillSearch] research-plugins catalog.json not found — skill search disabled');
      } else {
        const indexedCount = initSkillIndex(rpRoot);
        api.logger.info(`[SkillSearch] Indexed ${indexedCount} skills from ${rpRoot}`);
      }

      // Only register the tool when catalog is available — avoids exposing
      // a tool that always returns "no skills" which confuses the model.
      if (rpRoot) api.registerTool({
        name: 'skill_search',
        description:
          'Search and load research methodology skills on demand. Use when you need ' +
          'domain-specific guidance (e.g., "LaTeX thesis", "citation network", "CNKI search strategy") ' +
          'that is not in your current prompt. Returns skill content that you should follow.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'Search query — use keywords like tool names, domain names, or methodology terms. ' +
                'Examples: "latex thesis", "citation apa", "CNKI chinese", "machine learning survey", "bokeh visualization"',
            },
            max_results: {
              type: 'number',
              description: 'Maximum number of skills to return (default: 3, max: 5)',
            },
            list_catalog: {
              type: 'boolean',
              description: 'Set to true to get a full catalog summary instead of searching',
            },
          },
          required: ['query'],
        },
        async execute(_toolCallId: string, params: Record<string, unknown>): Promise<unknown> {
          const query = String(params.query ?? '');
          const maxResults = Math.min(Number(params.max_results) || 3, 5);
          const listCatalog = Boolean(params.list_catalog);

          if (listCatalog) {
            return {
              content: [{ type: 'text', text: getSkillCatalogSummary() }],
              details: { catalog: true },
            };
          }

          if (!query.trim()) {
            return {
              content: [{ type: 'text', text: 'Error: Query cannot be empty. Provide keywords to search for skills.' }],
              details: { error: 'empty_query' },
            };
          }

          const matches = searchSkills(query, maxResults);
          if (matches.length === 0) {
            return {
              content: [{
                type: 'text',
                text: `No skills found for "${query}". Try broader keywords or use skill_search({ query: "", list_catalog: true }) to see all categories.`,
              }],
              details: { query, matches: 0 },
            };
          }

          const results: string[] = [];
          for (const match of matches) {
            const content = readSkillContent(match);
            if (content) {
              results.push(
                `--- SKILL: ${match.name} (${match.category}/${match.subcategory}) ---\n${content}`,
              );
            } else {
              results.push(
                `--- SKILL: ${match.name} (${match.category}/${match.subcategory}) ---\n[Content not available at ${match.path}]`,
              );
            }
          }

          return {
            content: [{
              type: 'text',
              text: `Found ${matches.length} skill(s) for "${query}":\n\n${results.join('\n\n')}`,
            }],
            details: {
              query,
              matches: matches.length,
              skills: matches.map(m => ({ id: m.id, name: m.name, category: m.category, subcategory: m.subcategory })),
            },
          };
        },
      });
    }
    } // end if (!_registrationDone) — tools only

    // ── 5. Register RPC methods (78 WS total) ────────────────────────
    // NOTE: RPC + HTTP routes MUST be registered on EVERY register() call.
    // OC calls register() twice: discovery pass (tools only) and gateway pass
    // (where registerGatewayMethod actually wires up the WS handler).
    // The _registrationDone guard above covers tools only — tools registered
    // on the first pass are visible globally, but gateway methods are NOT.
    // Rate limiting not needed: local satellite, no network exposure (ws://127.0.0.1:28789 only)
    //
    // Bridge: our RPC handlers use a simple (params) => result signature,
    // but the gateway expects (opts: { params, respond, ... }) => void.
    // This wrapper extracts opts.params, awaits the result, and calls
    // opts.respond() to send the WS response back to the client.
    const registerMethod: RegisterMethod = (method, handler) => {
      api.registerGatewayMethod(method, async (opts: {
        params: Record<string, unknown>;
        respond: (ok: boolean, payload?: unknown, error?: { code: string; message: string }) => void;
      }) => {
        try {
          const result = await handler(opts.params);
          opts.respond(true, result);
        } catch (err) {
          // Handle both Error instances and plain ErrorShape objects from classifyError()
          const message =
            err instanceof Error
              ? err.message
              : typeof err === 'object' && err !== null && 'message' in err
                ? String((err as { message: unknown }).message)
                : String(err);
          opts.respond(false, undefined, { code: 'PLUGIN_ERROR', message });
        }
      });
    };
    registerLiteratureRpc(registerMethod, litService);   // 33 methods
    registerTaskRpc(registerMethod, taskService);         // 10 task + 4 cron = 14 methods
    registerWorkspaceRpc(registerMethod, wsService, wsConfig.root);  // 9 methods
    registerMonitorRpc(registerMethod, monitorService);   // 12 methods
    registerPaperReviewRpc(registerMethod, reviewService); // 6 methods
    registerPptRpc(registerMethod, pptService);           // 3 methods
    registerProviderRpc(registerMethod, {
      config: api.runtime.config,
      logger: api.logger,
      setApiKey: (provider, apiKey) => setApiKeyProfile(provider, apiKey),
      clearApiKey: (provider) => clearApiKeyProfile(provider),
    });

    if (MEMORY_MODULE_ENABLED && _memoryService && _sessionService) {
    const memoryService = _memoryService;
    const sessionService = _sessionService;
    registerMemoryRpcMethods(registerMethod, memoryService); // 17 methods
    registerSessionRpcMethods(registerMethod, sessionService); // 10 methods

    // ── Memory diagnostics RPC ────────────────────────────────────────
    // Surfaces hook registration, search backend status, and the most-recent
    // automatic extraction stats. Used by tests and the dashboard to verify
    // that the auto-memory pipeline is wired end-to-end.
    registerMethod('rc.memory.diagnostics', async () => {
      const provider = memoryService.getSearchProvider();
      const extraction = sessionService.getExtractionDiagnostics();
      const model = sessionService.getActiveModelInfo();
      const sessionConfigPath =
        process.env.OPENCLAW_CONFIG_PATH ||
        path.join(findGitRoot(api.resolvePath('.')), 'config', 'openclaw.json');
      const memoryMdPath = path.join(wsConfig.root, 'MEMORY.md');
      const memoryMdExists = fs.existsSync(memoryMdPath);
      let memoryMdHasManagedSection = false;
      let memoryMdSize = 0;
      if (memoryMdExists) {
        try {
          const stat = fs.statSync(memoryMdPath);
          memoryMdSize = stat.size;
          const content = fs.readFileSync(memoryMdPath, 'utf8');
          memoryMdHasManagedSection =
            content.includes('<!-- rc:memory-auto-start -->') &&
            content.includes('<!-- rc:memory-auto-end -->');
        } catch {
          /* ignore */
        }
      }

      return {
        success: true,
        hooks: {
          session_start: true,
          session_end: true,
          agent_end: true,
          after_tool_call: true,
        },
        search: {
          provider: provider.provider,
          fts_available: provider.fts_available,
          embedding_available: provider.embedding_available,
          notes: provider.notes,
        },
        extraction,
        active_model: model,
        memory_md: {
          path: memoryMdPath,
          exists: memoryMdExists,
          managed_section_present: memoryMdHasManagedSection,
          last_synced_at: extraction.memory_md_last_synced_at,
          bytes: memoryMdSize,
        },
        config_path: sessionConfigPath,
      };
    });

    registerMethod('rc.memory.extractNow', async (params) => {
      const sessionId = typeof params?.session_id === 'string' ? params.session_id : null;
      const result = await sessionService.triggerExtractionNow(sessionId);
      return { success: true, ...result };
    });

    registerMethod('rc.memory.syncMarkdown', async () => {
      const result = sessionService.syncMemoryMarkdown();
      return { success: true, result };
    });

    registerMethod('rc.memory.hookLogs', async (params) => {
      const source = (typeof params?.source === 'string' ? params.source : 'all') as HookLogSource;
      const limit = typeof params?.limit === 'number' && Number.isFinite(params.limit)
        ? Math.max(10, Math.min(500, Math.floor(params.limit)))
        : 120;
      const matches = collectHookLogItems(source, limit);

      return {
        success: true,
        source,
        count: matches.length,
        items: matches,
      };
    });

    registerMethod('rc.memory.syncHookLogs', async (params) => {
      const source = (typeof params?.source === 'string' ? params.source : 'all') as HookLogSource;
      const limit = typeof params?.limit === 'number' && Number.isFinite(params.limit)
        ? Math.max(10, Math.min(500, Math.floor(params.limit)))
        : 220;
      const result = syncHookLogsIntoMemories({
        memoryService,
        source,
        limit,
        logger: api.logger,
      });
      return { success: true, ...result };
    });

    // ── Claude-mem sync RPC ─────────────────────────────────────────────
    registerMethod('rc.memory.syncClaudeMem', async (params) => {
      if (!_claudeMemSyncService) throw new Error('Claude-mem sync service not initialized');
      const limit = typeof params?.limit === 'number' ? params.limit : 100;
      const result = await _claudeMemSyncService.syncAll(limit);
      return {
        success: true,
        ...result,
        agent_memory_count: _claudeMemSyncService.getAgentMemoryCount(),
      };
    });

    registerMethod('rc.memory.getClaudeMemStatus', async () => {
      if (!_claudeMemSyncService) throw new Error('Claude-mem sync service not initialized');
      const status = await _claudeMemSyncService.getSyncStatus();
      return {
        success: true,
        ...status,
        rc_agent_memories: _claudeMemSyncService.getAgentMemoryCount(),
      };
    });
    } // MEMORY_MODULE_ENABLED

    // Heartbeat RPC (2 methods)
    registerMethod('rc.heartbeat.status', () => {
      return heartbeatService.getStatus();
    });
    registerMethod('rc.heartbeat.suppress', (params: Record<string, unknown>) => {
      const taskId = params.task_id as string;
      if (!taskId) throw new Error('task_id is required');
      heartbeatService.suppress(taskId);
      return { ok: true, task_id: taskId };
    });

    // OAuth RPC (3 methods) — Dashboard-initiated OAuth for subscription providers
    registerMethod('rc.oauth.initiate', (params: Record<string, unknown>) => {
      const provider = params.provider as string;
      if (!provider) throw new Error('provider is required');
      return oauthInitiate(provider);
    });
    registerMethod('rc.oauth.complete', async (params: Record<string, unknown>) => {
      const stateId = params.state_id as string;
      const callbackUrl = params.callback_url as string;
      if (!stateId || !callbackUrl) throw new Error('state_id and callback_url are required');
      return oauthComplete(stateId, callbackUrl);
    });
    registerMethod('rc.oauth.status', (params: Record<string, unknown>) => {
      const provider = params.provider as string;
      if (!provider) throw new Error('provider is required');
      return oauthStatus(provider);
    });
    registerMethod('rc.auth.status', (params: Record<string, unknown>) => {
      const provider = params.provider as string;
      if (!provider) throw new Error('provider is required');
      return apiKeyStatus(provider);
    });
    registerMethod('rc.auth.statuses', (params: Record<string, unknown>) => {
      const providers = (params.providers as string[] | undefined) ?? [];
      return apiKeyStatuses(providers);
    });
    registerMethod('rc.auth.setApiKey', (params: Record<string, unknown>) => {
      const provider = params.provider as string;
      const apiKey = params.apiKey as string;
      const profileId = params.profileId as string | undefined;
      if (!provider || !apiKey) throw new Error('provider and apiKey are required');
      return setApiKeyProfile(provider, apiKey, profileId);
    });
    registerMethod('rc.auth.clearApiKey', (params: Record<string, unknown>) => {
      const provider = params.provider as string;
      const profileId = params.profileId as string | undefined;
      if (!provider) throw new Error('provider is required');
      return clearApiKeyProfile(provider, profileId);
    });

    // Tool call probe RPC — tests whether the active Ollama model supports
    // structured tool calls. Dashboard calls this after config load to show
    // a warning banner when tool calling is unsupported.
    registerMethod('rc.model.probeToolCalling', async (params: Record<string, unknown>) => {
      // 1. Determine active model & provider
      let modelPrimary = params.model as string | undefined;
      let ollamaBaseUrl = params.baseUrl as string | undefined;

      if (!modelPrimary) {
        // Read from openclaw.json on disk
        try {
          const configPath = api.resolvePath('config/openclaw.json');
          const configText = fs.readFileSync(configPath, 'utf-8');
          const config = JSON.parse(configText) as Record<string, unknown>;
          const agents = config.agents as Record<string, unknown> | undefined;
          const defaults = agents?.defaults as Record<string, unknown> | undefined;
          const model = defaults?.model as Record<string, unknown> | undefined;
          modelPrimary = model?.primary as string | undefined;

          if (!ollamaBaseUrl) {
            const models = config.models as Record<string, unknown> | undefined;
            const providers = models?.providers as Record<string, Record<string, unknown>> | undefined;
            if (providers?.ollama?.baseUrl) {
              ollamaBaseUrl = providers.ollama.baseUrl as string;
            }
          }
        } catch {
          // Config read failed — fall back to params or defaults
        }
      }

      if (!modelPrimary) {
        return { supported: true, skipped: true, reason: 'no_model_configured' };
      }

      // 2. Parse provider from model string (e.g. "ollama/Qwen3.5:35b-a3b")
      const slashIdx = modelPrimary.indexOf('/');
      const providerKey = slashIdx > 0 ? modelPrimary.slice(0, slashIdx) : '';
      const modelId = slashIdx > 0 ? modelPrimary.slice(slashIdx + 1) : modelPrimary;

      // Only probe Ollama models — other providers reliably support tool calls
      if (providerKey !== 'ollama') {
        return { supported: true, skipped: true, reason: 'non_ollama', model: modelPrimary, provider: providerKey };
      }

      // 3. Check cache
      const cached = _toolCallProbeCache.get(modelPrimary);
      if (cached && Date.now() - cached.testedAt < PROBE_TTL_MS) {
        _lastProbeResult = { supported: cached.supported, model: modelPrimary };
        return cached;
      }

      // 4. Probe Ollama API
      const baseUrl = (ollamaBaseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
      const probePayload = {
        model: modelId,
        messages: [
          { role: 'system', content: 'You are a helpful assistant. Always use the provided tools when applicable.' },
          { role: 'user', content: 'What is 2+2? Use the calculator tool to compute it.' },
        ],
        tools: [{
          type: 'function',
          function: {
            name: 'calculator',
            description: 'Performs arithmetic calculations',
            parameters: {
              type: 'object',
              properties: {
                expression: { type: 'string', description: 'The math expression to evaluate' },
              },
              required: ['expression'],
            },
          },
        }],
        stream: false,
      };

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        const resp = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(probePayload),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!resp.ok) {
          const result = { supported: false, model: modelPrimary, provider: providerKey, testedAt: Date.now(), error: `http_${resp.status}` };
          _toolCallProbeCache.set(modelPrimary, result);
          _lastProbeResult = { supported: false, model: modelPrimary };
          return result;
        }

        const body = await resp.json() as { message?: { tool_calls?: unknown[] } };
        const toolCalls = body?.message?.tool_calls;
        const supported = Array.isArray(toolCalls) && toolCalls.length > 0;

        const result = { supported, model: modelPrimary, provider: providerKey, testedAt: Date.now() };
        _toolCallProbeCache.set(modelPrimary, result);
        _lastProbeResult = { supported, model: modelPrimary };
        api.logger.info(`[ToolProbe] Model ${modelPrimary}: tool calling ${supported ? 'supported' : 'NOT supported'}`);
        return result;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const isAbort = errMsg.includes('abort');
        const result = {
          supported: false,
          model: modelPrimary,
          provider: providerKey,
          testedAt: Date.now(),
          error: isAbort ? 'timeout' : 'connection_failed',
          message: errMsg,
        };
        _toolCallProbeCache.set(modelPrimary, result);
        _lastProbeResult = { supported: false, model: modelPrimary };
        api.logger.warn(`[ToolProbe] Probe failed for ${modelPrimary}: ${errMsg}`);
        return result;
      }
    });

    // App updates — GitHub release vs local package.json; optional pull + build (Settings → About)
    // api.resolvePath('.') returns the plugin directory, not the project root.
    // Walk up to find the nearest .git for the actual repo root.
    const appUpdateRoot = findGitRoot(api.resolvePath('.'));
    registerMethod('rc.app.check_updates', () => {
      return checkUpdates(appUpdateRoot);
    });
    registerMethod('rc.app.apply_update', () => {
      return applyUpdate(appUpdateRoot, api.logger);
    });
    registerMethod('rc.app.update_status', () => {
      return { running: isUpdateRunning() };
    });

    registerDashboardRpc(registerMethod);
    hydrateDashboardSystemPromptFromConfigPath(api.resolvePath('config/openclaw.json'));

    // ── 6. Register HTTP route: POST /rc/upload ──────────────────────
    api.registerHttpRoute({
      path: '/rc/upload',
      auth: 'gateway',
      match: 'exact',
      async handler(req, res) {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } }));
          return true;
        }

        try {
          const { file, destination } = await parseMultipartUpload(req, wsConfig.maxUploadSize);

          if (!file) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: { code: 'UPLOAD_NO_FILE', message: 'No file in upload' } }));
            return true;
          }

          // Sanitize destination: resolve and verify it stays within workspace root
          const destDir = destination || 'sources';
          const resolvedDest = path.resolve(wsConfig.root, destDir);
          if (!resolvedDest.startsWith(path.resolve(wsConfig.root) + path.sep) && resolvedDest !== path.resolve(wsConfig.root)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: { code: 'UPLOAD_INVALID_PATH', message: 'Invalid destination path' } }));
            return true;
          }

          // Sanitize filename: strip null bytes, slashes, and control characters
          const safeFilename = file.filename
            .replace(/\0/g, '')
            .replace(/[\\/]/g, '_')
            .replace(/[\x00-\x1f]/g, '');
          if (!safeFilename) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: { code: 'UPLOAD_INVALID_FILENAME', message: 'Invalid filename' } }));
            return true;
          }

          const destPath = `${destDir}/${safeFilename}`;
          const result = await wsService.save(destPath, file.data, `Upload: ${safeFilename} to ${destDir}`);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            file: {
              name: safeFilename,
              path: result.path,
              type: 'file',
              size: result.size,
              mime_type: file.mimeType,
              modified_at: new Date().toISOString(),
              git_status: result.committed ? 'committed' : 'untracked',
            },
          }));
          return true;
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Upload failed';
          const isTooLarge = message.includes('too large') || message.includes('TOO_LARGE');
          res.writeHead(isTooLarge ? 413 : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: false,
            error: { code: isTooLarge ? 'UPLOAD_TOO_LARGE' : 'UPLOAD_WRITE_FAILED', message },
          }));
          return true;
        }
      },
    });

    // ── 6b. Register HTTP route: GET /rc/download ─────────────────────
    api.registerHttpRoute({
      path: '/rc/download',
      auth: 'gateway',
      match: 'exact',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'GET only' } }));
          return true;
        }

        try {
          const url = new URL(req.url!, `http://${req.headers.host}`);
          const filePath = url.searchParams.get('path');
          if (!filePath) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: { code: 'MISSING_PATH', message: 'path query param required' } }));
            return true;
          }

          const resolved = path.resolve(wsConfig.root, filePath);
          if (!resolved.startsWith(path.resolve(wsConfig.root) + path.sep) && resolved !== path.resolve(wsConfig.root)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: { code: 'PATH_ESCAPE', message: 'Path escapes workspace root' } }));
            return true;
          }

          const stat = await fs.promises.stat(resolved).catch(() => null);
          if (!stat) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'Path not found' } }));
            return true;
          }

          if (stat.isDirectory()) {
            // Directory → stream as tar.gz archive
            const dirName = path.basename(resolved);
            const archiveName = `${dirName}.tar.gz`;
            res.writeHead(200, {
              'Content-Type': 'application/gzip',
              'Content-Disposition': `attachment; filename="${encodeURIComponent(archiveName)}"`,
            });
            await new Promise<void>((resolve, reject) => {
              const tar = spawn('tar', ['czf', '-', '-C', path.dirname(resolved), dirName]);
              tar.stdout.pipe(res);
              tar.stderr.on('data', () => { /* ignore tar warnings */ });
              tar.on('close', () => resolve());
              tar.on('error', (err) => {
                if (!res.headersSent) {
                  res.writeHead(500, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ ok: false, error: { code: 'ARCHIVE_FAILED', message: err.message } }));
                }
                reject(err);
              });
            });
            return true;
          }

          const fileName = path.basename(resolved);
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
            'Content-Length': stat.size,
          });
          const stream = fs.createReadStream(resolved);
          stream.pipe(res);
          return true;
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: { code: 'DOWNLOAD_FAILED', message: String(err) } }));
          return true;
        }
      },
    });

    // ── 7. Register hooks ─────────────────────────────────────────────
    // Hooks MUST only be registered once — duplicate registration causes
    // handlers to fire multiple times per event.
    if (!_registrationDone) {

    // Hook 1: Inject research context into agent prompt
    //
    // Provides the agent with a snapshot of current state at each turn:
    //   - Library statistics (total papers, unread count)
    //   - Overdue tasks (past deadline)
    //   - Upcoming tasks (within deadline warning window)
    //   - Active task overview (todo + in_progress, both agent and user tasks)
    api.on('before_prompt_build', () => {
      try {
        const stats = litService.getStats();
        const overdue = taskService.overdue();
        const upcoming = taskService.upcoming(deadlineWarningHours);

        // Fetch active tasks (todo + in_progress) for overview
        const activeTasks = taskService.list({
          limit: 10,
          sort: 'priority',
          direction: 'asc',
          include_completed: false,
        });

        const lines: string[] = [];
        lines.push(`[Research-Claw] Library: ${stats.total} papers (${stats.by_status['unread'] ?? 0} unread)`);

        if (overdue.length > 0) {
          lines.push(`[Research-Claw] OVERDUE: ${overdue.length} task(s) past deadline`);
          for (const t of overdue.slice(0, 3)) {
            lines.push(`  - "${t.title}" (deadline: ${t.deadline})`);
          }
        }
        if (upcoming.length > 0) {
          lines.push(`[Research-Claw] Upcoming: ${upcoming.length} task(s) due within ${deadlineWarningHours}h`);
          for (const t of upcoming.slice(0, 3)) {
            lines.push(`  - "${t.title}" (deadline: ${t.deadline})`);
          }
        }

        // Heartbeat tick: check and send notifications if due, then inject escalation status
        try {
          heartbeatService.tick((type, title, body) => {
            taskService.sendNotification(type, title, body);
          });
          const hbStatus = heartbeatService.getStatus();
          const urgent = hbStatus.filter((h) => h.current_tier === 'overdue' || h.current_tier === 'hourly' || h.current_tier === 'every_6h');
          if (urgent.length > 0) {
            lines.push(`[Research-Claw] Heartbeat ESCALATED: ${urgent.length} task(s) need attention`);
            for (const h of urgent.slice(0, 5)) {
              lines.push(`  - [${h.current_tier.toUpperCase()}] "${h.task_title}" (deadline: ${h.deadline})`);
            }
          }
        } catch {
          // Non-fatal
        }

        // Active task overview — gives the agent awareness of user's and its own todos
        if (activeTasks.items.length > 0) {
          const agentTasks = activeTasks.items.filter((t: { task_type: string }) => t.task_type === 'agent' || t.task_type === 'mixed');
          const humanTasks = activeTasks.items.filter((t: { task_type: string }) => t.task_type === 'human');

          if (agentTasks.length > 0) {
            lines.push(`[Research-Claw] Agent tasks (${agentTasks.length} active):`);
            for (const t of agentTasks.slice(0, 5)) {
              const status = (t as { status: string }).status;
              lines.push(`  - [${status}] "${(t as { title: string }).title}"`);
            }
          }
          if (humanTasks.length > 0) {
            lines.push(`[Research-Claw] User tasks (${humanTasks.length} active):`);
            for (const t of humanTasks.slice(0, 5)) {
              const status = (t as { status: string }).status;
              lines.push(`  - [${status}] "${(t as { title: string }).title}"`);
            }
          }
        }

        // Active monitors context — tell agent about enabled monitors
        const enabledMonitors = monitorService.listEnabled();
        if (enabledMonitors.length > 0) {
          lines.push(`[Research-Claw] ${enabledMonitors.length} active monitor(s):`);
          for (const m of enabledMonitors.slice(0, 5)) {
            const lastCheck = m.last_check_at ?? 'never';
            lines.push(`  - "${m.name}" (${m.source_type}, schedule: ${m.schedule}, last: ${lastCheck})`);
          }
        }

        // Tool call probe warning — if the active model failed the probe,
        // inject guidance so the agent does not hallucinate tool results.
        if (_lastProbeResult && !_lastProbeResult.supported) {
          lines.push(
            '[Research-Claw] WARNING: Current model may not support structured tool calls. ' +
            'If a tool call fails or returns no structured result, report "(检测失败 — 工具调用不可用)" ' +
            'instead of assuming the tool/plugin is not installed. Inform the user about model compatibility.',
          );
        }

        // ── Error memory context injection ─────────────────────────────
        // If there are recent tool failures, inject a summary so the model
        // is aware even after compaction/context reset.
        if (_toolErrorLog.length > 0) {
          const tenMinAgo = Date.now() - 600_000;
          const recentErrors = _toolErrorLog.filter(e => e.ts > tenMinAgo);
          if (recentErrors.length > 0) {
            const byTool = new Map<string, number>();
            for (const e of recentErrors) {
              byTool.set(e.tool, (byTool.get(e.tool) ?? 0) + 1);
            }
            const failLines = Array.from(byTool.entries())
              .map(([tool, count]) => {
                const hint = DEGRADATION_HINTS[tool] ?? '';
                return `  - ${tool}: ${count} failure(s)${hint ? ` — ${hint}` : ''}`;
              })
              .join('\n');
            lines.push(`[Research-Claw] TOOL FAILURES (last 10 min):\n${failLines}`);
            lines.push('[Research-Claw] Do NOT retry failed tools with the same arguments. Use the suggested alternatives above.');
          }
        }

        const userSystemPrompt = formatDashboardSystemPromptBlock();
        if (userSystemPrompt) {
          lines.push(userSystemPrompt);
        }

        lines.push(TASK_FLOW_AGENT_GUIDANCE);

        return lines.length > 0 ? { prependContext: lines.join('\n') } : {};
      } catch {
        return {};
      }
    });

    // Hook 2: Ensure DB is open and migrated on session start
    api.on('session_start', () => {
      // Reset tool call dedup state — each session/run is a fresh context.
      // Without this, dedup threshold leaks across sessions and blocks
      // legitimate calls that happen to match a previous session's pattern.
      _lastToolSig = null;
      _lastToolCount = 0;

      // Reset error log — each session starts fresh, but errors from the
      // current session will persist through compaction/context resets.
      _toolErrorLog.length = 0;
      if (MEMORY_MODULE_ENABLED) {
        _memoryRecordedMessageCounts.clear();
      }

      if (dbManager?.isOpen()) {
        runMigrations(dbManager.db);
      }

      if (MEMORY_MODULE_ENABLED && _sessionService) {
        try {
          _sessionService.startSession();
          api.logger.info('[SessionMonitoring] Started tracking new session');
        } catch (err) {
          api.logger.warn(`[SessionMonitoring] Failed to start session: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

    // Hook 3: Close open reading sessions on session end (including stale sessions > 24h)
    api.on('session_end', () => {
      if (!dbManager?.isOpen()) return;
      try {
        // Close stale sessions older than 24 hours (e.g. user crashed without ending)
        dbManager.db
          .prepare(
            `UPDATE rc_reading_sessions
             SET ended_at = datetime('now'),
                 duration_minutes = CAST((julianday('now') - julianday(started_at)) * 1440 AS INTEGER)
             WHERE ended_at IS NULL
               AND started_at < datetime('now', '-24 hours')`,
          )
          .run();

        // Close remaining open sessions from this agent session
        const openSessions = dbManager.db
          .prepare('SELECT id FROM rc_reading_sessions WHERE ended_at IS NULL')
          .all() as Array<{ id: string }>;
        for (const session of openSessions) {
          try {
            litService.endReading(session.id);
          } catch (err) {
            api.logger.warn(`Failed to end reading session ${session.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        api.logger.warn(`Error closing reading sessions: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (MEMORY_MODULE_ENABLED && _sessionService) {
        try {
          const session = _sessionService.endSession();
          if (session) {
            api.logger.info(`[SessionMonitoring] Ended session ${session.id} with ${session.events_count} events`);
          }
          _memoryRecordedMessageCounts.clear();
        } catch (err) {
          api.logger.warn(`[SessionMonitoring] Failed to end session: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

    // Hook 4: Guard against destructive exec commands outside workspace
    //
    // OpenClaw's `exec` tool lets the agent run arbitrary shell commands.
    // We intercept it here to block commands that could recursively delete
    // or format storage outside the workspace root. Normal commands (python,
    // git, npm, curl, single-file rm, etc.) pass through unhindered.
    //
    // Design philosophy: block only catastrophic operations (recursive
    // delete on system/home paths, disk-level destruction). Single-file rm,
    // redirects to /tmp, chmod on local scripts are all legitimate and
    // must NOT be blocked. Prompt-level HiL constraints in AGENTS.md
    // cover the remaining surface area.
    //
    // Returns { block: true, blockReason } to prevent execution,
    // or {} to allow it.
    const wsRoot = wsConfig.root;

    // Only block recursive rm targeting paths outside the workspace
    const CATASTROPHIC_PATTERNS = [
      // rm -rf / rm -fr / rm -r targeting absolute paths (outside workspace)
      /\brm\s+(-\w*r\w*f|-\w*f\w*r|-r)\s+\//,
      // rm -rf / rm -fr / rm -r targeting home directory
      /\brm\s+(-\w*r\w*f|-\w*f\w*r|-r)\s+~/,
      // rm -rf / rm -fr / rm -r targeting parent traversal
      /\brm\s+(-\w*r\w*f|-\w*f\w*r|-r)\s+\.\.\//,
      // Disk-level destructive operations — never needed for research
      /\bdd\s+.*of=\/dev\//,
      /\bmkfs\b/,
      /\bshred\s/,
      // Fork bomb
      /:\(\)\s*\{.*:\|:.*&\s*\}/,
    ];

    // ── Tool call dedup guard ──────────────────────────────────────
    // Some models (e.g. glm-5) generate 1000+ identical tool calls in
    // a single response. Track consecutive identical calls and block
    // after TOOL_DEDUP_MAX repeats to prevent transcript bloat.
    const TOOL_DEDUP_MAX = 3;

    api.on('before_tool_call', (event: unknown) => {
      const evt = event as { toolName?: string; params?: Record<string, unknown> } | undefined;
      if (!evt) return {};

      // ── Duplicate tool call guard ───────────────────────────────────
      const toolSig = `${evt.toolName ?? ''}::${JSON.stringify(evt.params ?? {})}`;
      if (toolSig === _lastToolSig) {
        _lastToolCount++;
        if (_lastToolCount > TOOL_DEDUP_MAX) {
          api.logger.warn(
            `[ToolDedup] Blocked "${evt.toolName}" — ${_lastToolCount} identical consecutive calls`,
          );
          return {
            block: true,
            blockReason:
              `Blocked: "${evt.toolName}" called ${_lastToolCount} times with identical arguments. ` +
              `This appears to be a model tool-call loop. Change the arguments or use a different approach.`,
          };
        }
      } else {
        _lastToolSig = toolSig;
        _lastToolCount = 1;
      }

      // ── Error-aware preemptive block ───────────────────────────────
      // If this tool has failed 3+ times in the last 10 minutes, block it
      // preemptively even if the arguments are different.
      {
        const tenMinAgo = Date.now() - 600_000;
        const recentFails = _toolErrorLog.filter(
          e => e.tool === (evt.toolName ?? '') && e.ts > tenMinAgo,
        );
        if (recentFails.length >= 3) {
          const hint = DEGRADATION_HINTS[evt.toolName ?? ''] ??
            'Try a completely different approach.';
          api.logger.warn(
            `[ErrorGuard] Preemptively blocked "${evt.toolName}" — ${recentFails.length} recent failures`,
          );
          return {
            block: true,
            blockReason:
              `Blocked: "${evt.toolName}" has failed ${recentFails.length} times in the last 10 minutes. ` +
              `The tool appears to be unavailable or misconfigured. ${hint}`,
          };
        }
      }

      // ── Cron schedule sync ──────────────────────────────────────────
      // The agent uses OpenClaw's built-in `cron` tool (action: "update")
      // which bypasses our rc_cron_state DB. Intercept here and sync the
      // schedule BEFORE the tool executes. Even if the tool later fails,
      // the next loadPresets → reconcile will fix the mismatch.
      if (evt.toolName === 'cron' && dbManager?.isOpen()) {
        try {
          const params = evt.params ?? {};
          if (params.action === 'update') {
            const jobId =
              typeof params.jobId === 'string' ? params.jobId :
              typeof params.id === 'string' ? params.id : undefined;

            // Extract schedule from patch.schedule (could be string or {kind, expr})
            const patch = params.patch as Record<string, unknown> | undefined;
            let scheduleExpr: string | undefined;
            if (patch) {
              const sched = patch.schedule;
              if (typeof sched === 'string') {
                scheduleExpr = sched;
              } else if (typeof sched === 'object' && sched !== null) {
                const obj = sched as Record<string, unknown>;
                if (typeof obj.expr === 'string') scheduleExpr = obj.expr;
                if (typeof obj.expression === 'string') scheduleExpr = obj.expression;
              }
            }

            if (jobId && scheduleExpr) {
              const row = dbManager.db.prepare(
                'SELECT preset_id FROM rc_cron_state WHERE gateway_job_id = ?',
              ).get(jobId) as { preset_id: string } | undefined;

              if (row) {
                dbManager.db.prepare(
                  'UPDATE rc_cron_state SET schedule = ? WHERE preset_id = ?',
                ).run(scheduleExpr, row.preset_id);
                api.logger.info(`[CronSync] Synced schedule "${scheduleExpr}" for preset "${row.preset_id}" from native cron tool`);
              }
            }
          }
        } catch (err) {
          api.logger.warn(`[CronSync] Failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return {}; // Always allow — let the built-in cron tool proceed
      }

      // ── .ResearchClaw path redirect for OC built-in tools ─────────
      // OpenClaw's read/write/edit resolve paths relative to workspace root.
      // After system-file migration, HEARTBEAT.md etc. live in .ResearchClaw/.
      // Rewrite the path param so OC tools find the file at the correct location.
      // Only redirects bare filenames (not nested paths like "outputs/HEARTBEAT.md")
      // and only when the file actually exists in .ResearchClaw/.
      if (
        (evt.toolName === 'read' || evt.toolName === 'write' || evt.toolName === 'edit') &&
        _wsConfig?.root
      ) {
        const rawPath =
          typeof evt.params?.path === 'string' ? evt.params.path :
          typeof evt.params?.file_path === 'string' ? evt.params.file_path :
          undefined;
        if (rawPath) {
          const basename = path.basename(rawPath);
          // Only redirect bare filenames matching relocatable prompt files
          if (RELOCATABLE_FILES.has(basename) && rawPath === basename) {
            const rcPath = path.join(_wsConfig.root, '.ResearchClaw', basename);
            if (fs.existsSync(rcPath)) {
              const redirected = `.ResearchClaw/${basename}`;
              return { params: { path: redirected } };
            }
          }
        }
      }

      // ── Exec safety guard ──────────────────────────────────────────
      if (evt.toolName !== 'exec') return {};

      const command = typeof evt.params?.command === 'string' ? evt.params.command : '';
      if (!command) return {};

      // Always check catastrophic patterns — no short-circuit bypass.
      for (const pattern of CATASTROPHIC_PATTERNS) {
        if (pattern.test(command)) {
          api.logger.warn(`[SafeGuard] Blocked catastrophic command: ${command.slice(0, 120)}`);
          return {
            block: true,
            blockReason:
              `Destructive command blocked by Research-Claw safety guard. ` +
              `Recursive deletion and disk-level operations outside the workspace are not permitted. ` +
              `Use workspace tools for file management. Command: ${command.slice(0, 80)}`,
          };
        }
      }

      return {};
    });

    // Hook 5: Capture every agent run into the memory substrate.
    //
    // This is the first, deterministic layer inspired by claude-mem:
    //   1. store raw session events in rc_session_events;
    //   2. create a compact project memory in rc_memories per successful run.
    //
    // A later layer can replace the compact summary with LLM-based extraction,
    // but this hook ensures the memory panel has real session-derived data now.
    if (MEMORY_MODULE_ENABLED) {
    api.on('agent_end', (event: unknown, ctx: unknown) => {
      try {
        if (!dbManager?.isOpen() || !_memoryService || !_sessionService) return;
        const memoryService = _memoryService;
        const sessionService = _sessionService;
        if (!sessionService.getCurrentSession()) {
          sessionService.startSession({ source: 'agent_end_hook' });
        }

        const evt = event as { messages?: unknown[]; success?: boolean; durationMs?: number; error?: string } | undefined;
        const hookCtx = ctx as { sessionKey?: string; sessionId?: string; agentId?: string; channelId?: string } | undefined;
        const messages = Array.isArray(evt?.messages) ? evt.messages : [];
        const memoryKey = hookCtx?.sessionKey ?? hookCtx?.sessionId ?? 'default';
        const previousCount = _memoryRecordedMessageCounts.get(memoryKey) ?? 0;
        const newMessages = messages.slice(previousCount);
        _memoryRecordedMessageCounts.set(memoryKey, messages.length);

        const userTexts: string[] = [];
        const assistantTexts: string[] = [];

        for (const message of newMessages) {
          if (!isRecord(message)) continue;
          const role = typeof message.role === 'string' ? message.role : '';
          const text = extractMessageText(message);
          if (!text) continue;

          if (role === 'user') {
            userTexts.push(text);
            sessionService.recordUserPrompt(text);
          } else if (role === 'assistant') {
            assistantTexts.push(text);
            const toolCalls = Array.isArray(message.tool_calls)
              ? message.tool_calls.map((tc) => {
                  if (!isRecord(tc)) return { name: 'unknown', input: {} };
                  return {
                    name: typeof tc.name === 'string' ? tc.name : String(tc.function ?? 'tool'),
                    input: isRecord(tc.input) ? tc.input : {},
                  };
                })
              : undefined;
            sessionService.recordAssistantResponse(text, toolCalls);
          }
        }

        if (evt?.success !== false && (userTexts.length > 0 || assistantTexts.length > 0)) {
          for (const memory of buildAutoMemories({
            userTexts,
            assistantTexts,
            sessionKey: hookCtx?.sessionKey,
            sessionId: hookCtx?.sessionId,
            agentId: hookCtx?.agentId,
            channelId: hookCtx?.channelId,
            durationMs: evt?.durationMs,
          })) {
            memoryService.upsertMemory({
              type: memory.type,
              name: memory.name,
              description: memory.description,
              content: memory.content,
              metadata: memory.metadata,
              dedupe_key: memory.dedupe_key,
              tags: memory.tags,
            });
          }

          // Bridge both hook log streams (research-claw-core + claude-mem)
          // into rc_memories so the main memory view can show unified entries.
          // Dedupe keys make this idempotent across repeated agent_end calls.
          syncHookLogsIntoMemories({
            memoryService,
            source: 'all',
            limit: 80,
            logger: api.logger,
          });
        }
      } catch (err) {
        api.logger.warn(`[SessionMonitoring] Failed to capture agent run: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    api.on('after_tool_call', (event: unknown) => {
      try {
        if (!dbManager?.isOpen() || !_sessionService) return;
        const sessionService = _sessionService;
        if (!sessionService.getCurrentSession()) {
          sessionService.startSession({ source: 'after_tool_call_hook' });
        }
        const evt = event as {
          toolName?: string;
          params?: Record<string, unknown>;
          result?: unknown;
          durationMs?: number;
        } | undefined;
        if (!evt?.toolName) return;
        sessionService.recordToolUse(
          evt.toolName,
          evt.params ?? {},
          compactUnknown(evt.result),
          evt.durationMs,
        );
      } catch (err) {
        api.logger.warn(`[SessionMonitoring] Failed to capture tool call: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    } // MEMORY_MODULE_ENABLED

    // Hook 6: Sync native cron schedule changes back to rc_cron_state.
    //
    // The agent may use OpenClaw's built-in cron management tools (e.g.
    // cron_update) which bypass our plugin DB. When that happens, the
    // gateway cron job gets the new schedule but our DB still has the old
    // one, causing the dashboard to show stale data.
    //
    // This hook detects native cron tool calls, extracts the schedule
    // expression, maps the gateway job ID back to our preset, and updates
    // rc_cron_state.schedule so the dashboard stays in sync.
    api.on('after_tool_call', (event: unknown) => {
      const evt = event as {
        toolName?: string;
        params?: Record<string, unknown>;
        result?: unknown;
      } | undefined;

      if (!evt?.toolName || !dbManager?.isOpen()) return;

      // Only intercept cron-related tools
      const toolName = evt.toolName.toLowerCase();
      if (!toolName.includes('cron')) return;

      try {
        const params = evt.params ?? {};

        // Extract schedule expression from various possible param shapes:
        //   { schedule: "0 12 * * 4" }
        //   { schedule: { kind: "cron", expr: "0 12 * * 4" } }
        let scheduleExpr: string | undefined;
        const schedParam = params.schedule;
        if (typeof schedParam === 'string') {
          scheduleExpr = schedParam;
        } else if (typeof schedParam === 'object' && schedParam !== null) {
          const obj = schedParam as Record<string, unknown>;
          if (typeof obj.expr === 'string') scheduleExpr = obj.expr;
          if (typeof obj.expression === 'string') scheduleExpr = obj.expression;
        }

        if (!scheduleExpr) return;

        // Try to find the preset by gateway_job_id
        const jobId =
          typeof params.id === 'string' ? params.id :
          typeof params.job_id === 'string' ? params.job_id :
          typeof params.jobId === 'string' ? params.jobId : undefined;

        if (jobId) {
          const row = dbManager.db.prepare(
            'SELECT preset_id FROM rc_cron_state WHERE gateway_job_id = ?',
          ).get(jobId) as { preset_id: string } | undefined;

          if (row) {
            dbManager.db.prepare(
              'UPDATE rc_cron_state SET schedule = ? WHERE preset_id = ?',
            ).run(scheduleExpr, row.preset_id);
            api.logger.info(`[CronSync] Synced schedule "${scheduleExpr}" for preset "${row.preset_id}" from native cron tool`);
          }
        }
      } catch (err) {
        // Non-fatal — just log
        api.logger.warn(`[CronSync] Failed to sync cron schedule: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // Hook 7: Heartbeat lifecycle — react to task tool calls
    //
    // After task_create/update/complete/delete, update heartbeat tracking.
    // Uses after_tool_call which fires only for plugin tools (our tools).
    api.on('after_tool_call', (event: unknown) => {
      const evt = event as {
        toolName?: string;
        params?: Record<string, unknown>;
        result?: { details?: Record<string, unknown> };
      };
      if (!evt.toolName || !dbManager?.isOpen()) return;

      try {
        const details = evt.result?.details as Record<string, unknown> | undefined;

        switch (evt.toolName) {
          case 'task_create': {
            // Register if task was created with a deadline
            const taskId = details?.id as string | undefined;
            const deadline = details?.deadline as string | undefined;
            if (taskId && deadline) {
              heartbeatService.register(taskId);
            }
            break;
          }
          case 'task_update': {
            // Recalculate if deadline or status changed
            const taskId = (evt.params?.id as string) ?? (details?.id as string);
            if (!taskId) break;
            const newStatus = details?.status as string | undefined;
            if (newStatus === 'done' || newStatus === 'cancelled') {
              heartbeatService.unregister(taskId);
            } else {
              heartbeatService.recalculate(taskId);
            }
            break;
          }
          case 'task_complete': {
            const taskId = (evt.params?.id as string) ?? (details?.id as string);
            if (taskId) heartbeatService.unregister(taskId);
            break;
          }
          case 'task_delete': {
            // CASCADE handles DB cleanup, but clear in-memory if needed
            break;
          }
        }
      } catch (err) {
        api.logger.warn(`[Heartbeat] Post-tool hook error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, { priority: 50 });

    // Hook 8b: Error context injection — track tool failures for
    // degradation via before_prompt_build and before_tool_call blocking.
    //
    // after_tool_call is a VOID hook in OC — return values are discarded.
    // So we only record errors here; the actual degradation happens in:
    //   - before_tool_call (preemptive block at 3+ failures)
    //   - before_prompt_build (context injection with hints)
    //
    // Error detection: OC populates evt.error for thrown exceptions, and
    // we also inspect result shape for non-throwing error returns.
    api.on('after_tool_call', (event: unknown) => {
      const evt = event as {
        toolName?: string;
        params?: Record<string, unknown>;
        result?: unknown;
        error?: string;       // OC native: populated when tool throws
        durationMs?: number;
      } | undefined;
      if (!evt?.toolName) return;

      // Detect error — check OC native error field first, then result shape
      let isError = false;
      let errorMsg = '';

      // 1. OC native error field (thrown exceptions)
      if (evt.error) {
        isError = true;
        errorMsg = evt.error.slice(0, 200);
      }

      // 2. Result-based error detection (non-throwing failures)
      if (!isError) {
        const result = evt.result;
        if (typeof result === 'string') {
          if (/^(Error|Failed|error:)/i.test(result)) {
            isError = true;
            errorMsg = result.slice(0, 200);
          }
        } else if (typeof result === 'object' && result !== null) {
          const obj = result as Record<string, unknown>;
          if (obj.error !== undefined) {
            isError = true;
            errorMsg = typeof obj.error === 'string'
              ? obj.error.slice(0, 200)
              : JSON.stringify(obj.error).slice(0, 200);
          } else if (obj.ok === false) {
            isError = true;
            const msg = typeof obj.message === 'string' ? obj.message : JSON.stringify(obj);
            errorMsg = msg.slice(0, 200);
          }
        }
      }

      if (isError) {
        _toolErrorLog.push({
          tool: evt.toolName,
          error: errorMsg || 'Unknown error',
          ts: Date.now(),
        });

        // Cap error log size
        if (_toolErrorLog.length > ERROR_LOG_MAX) {
          _toolErrorLog.splice(0, _toolErrorLog.length - ERROR_LOG_MAX);
        }

        api.logger.warn(
          `[ErrorTracker] "${evt.toolName}" failed: ${errorMsg.slice(0, 80)}`,
        );
      } else {
        // On success, clear old errors for this tool (it's working again).
        // Only clear entries older than 5 minutes to avoid flapping.
        const fiveMinAgo = Date.now() - 300_000;
        for (let i = _toolErrorLog.length - 1; i >= 0; i--) {
          if (_toolErrorLog[i].tool === evt.toolName && _toolErrorLog[i].ts < fiveMinAgo) {
            _toolErrorLog.splice(i, 1);
          }
        }
      }
    }, { priority: 90 });

    // Hook 9: Verify DB integrity + bootstrap heartbeat on gateway start
    // (was Hook 8 before error-resilience hooks were added)
    api.on('gateway_start', () => {
      if (!dbManager?.isOpen()) return;
      try {
        const result = dbManager.db.pragma('integrity_check') as Array<{ integrity_check: string }>;
        if (result[0]?.integrity_check !== 'ok') {
          api.logger.warn('Database integrity check failed on gateway start');
        }
      } catch (err) {
        api.logger.error(`DB integrity check error: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Bootstrap heartbeat: scan active deadline tasks and populate tracking
      try {
        const hbResult = heartbeatService.bootstrap();
        if (hbResult.registered > 0 || hbResult.updated > 0) {
          api.logger.info(`[Heartbeat] Bootstrap: ${hbResult.registered} registered, ${hbResult.updated} updated`);
        }
      } catch (err) {
        api.logger.warn(`[Heartbeat] Bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // Hook 10: Redirect bootstrap file loading from workspace root to .ResearchClaw/ subdirectory.
    //
    // OpenClaw hardcodes loading AGENTS.md, SOUL.md, etc. from the workspace root.
    // With skipBootstrap: true, OC won't create default templates at root. This hook
    // intercepts the agent:bootstrap event and replaces missing root entries with the
    // actual files from .ResearchClaw/, keeping the workspace root clean for users.
    //
    // MEMORY.md + memory/ stay at workspace root (agent memory search scans root).
    const RELOCATABLE_FILES = new Set([
      'AGENTS.md', 'SOUL.md', 'TOOLS.md', 'IDENTITY.md',
      'USER.md', 'HEARTBEAT.md', 'BOOTSTRAP.md',
    ]);

    if (api.registerHook) {
      api.registerHook('agent:bootstrap', (event) => {
        const ctx = event.context as {
          workspaceDir?: string;
          bootstrapFiles?: Array<{
            name: string;
            path: string;
            content?: string;
            missing?: boolean;
          }>;
        };
        if (!ctx?.workspaceDir || !Array.isArray(ctx.bootstrapFiles)) return;

        const rcDir = path.join(ctx.workspaceDir, '.ResearchClaw');
        if (!fs.existsSync(rcDir)) return;

        ctx.bootstrapFiles = ctx.bootstrapFiles.map((file) => {
          if (!RELOCATABLE_FILES.has(file.name)) return file;

          const rcPath = path.join(rcDir, file.name);
          try {
            const content = fs.readFileSync(rcPath, 'utf-8');
            return { ...file, path: rcPath, content, missing: false };
          } catch {
            return file;
          }
        });
      }, { name: 'research-claw.bootstrap-redirect', description: 'Load prompt files from .ResearchClaw/ subdirectory' });
    } else {
      api.logger.warn('registerHook not available — system files will remain at workspace root');
    }

    api.logger.info('Research-Claw Core registered (40 tools, 89 WS RPC + 2 HTTP = 91 interfaces, 10 hooks, 1 session monitoring service)');
    _registrationDone = true;
    }
  },
};

export default plugin;

// ── Multipart upload parser ────────────────────────────────────────────

interface UploadedFile {
  filename: string;
  data: Buffer;
  mimeType: string;
}

async function parseMultipartUpload(
  req: IncomingMessage,
  maxSize: number,
): Promise<{ file: UploadedFile | null; destination: string }> {
  const contentType = req.headers['content-type'] ?? '';
  const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
  if (!boundaryMatch) {
    throw new Error('Missing multipart boundary');
  }

  // Unquote boundary if quoted per RFC 2046
  let boundary = boundaryMatch[1];
  if (boundary.startsWith('"') && boundary.endsWith('"')) {
    boundary = boundary.slice(1, -1);
  }
  const chunks: Buffer[] = [];
  let totalSize = 0;

  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (maxSize > 0 && totalSize > maxSize) {
        req.destroy();
        reject(new Error('UPLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', resolve);
    req.on('error', reject);
  });

  const rawBody = Buffer.concat(chunks);
  const boundaryBuf = Buffer.from(`--${boundary}`);

  // Split raw body by boundary, preserving binary data
  const partBuffers: Buffer[] = [];
  let searchStart = 0;
  while (searchStart < rawBody.length) {
    const idx = rawBody.indexOf(boundaryBuf, searchStart);
    if (idx === -1) {
      partBuffers.push(rawBody.subarray(searchStart));
      break;
    }
    if (idx > searchStart) {
      partBuffers.push(rawBody.subarray(searchStart, idx));
    }
    searchStart = idx + boundaryBuf.length;
  }

  let file: UploadedFile | null = null;
  let destination = '';

  for (const partBuf of partBuffers) {
    // Find header/body separator (\r\n\r\n)
    const separator = Buffer.from('\r\n\r\n');
    const headerEnd = partBuf.indexOf(separator);
    if (headerEnd === -1) continue;

    // Parse headers as UTF-8 to correctly handle non-ASCII filenames
    const headers = partBuf.subarray(0, headerEnd).toString('utf-8');

    // Extract body as raw Buffer, strip trailing \r\n
    let bodyBuf = partBuf.subarray(headerEnd + 4);
    if (bodyBuf.length >= 2 && bodyBuf[bodyBuf.length - 2] === 0x0d && bodyBuf[bodyBuf.length - 1] === 0x0a) {
      bodyBuf = bodyBuf.subarray(0, bodyBuf.length - 2);
    }

    const trimmedHeaders = headers.trim();
    if (trimmedHeaders === '' || trimmedHeaders === '--') continue;

    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);
    const ctMatch = headers.match(/Content-Type:\s*(.+?)(?:\r\n|$)/i);

    if (!nameMatch) continue;

    if (nameMatch[1] === 'file' && filenameMatch) {
      file = {
        filename: filenameMatch[1],
        data: bodyBuf,
        mimeType: ctMatch?.[1]?.trim() ?? 'application/octet-stream',
      };
    } else if (nameMatch[1] === 'destination') {
      destination = bodyBuf.toString('utf-8').trim();
    }
  }

  return { file, destination };
}
