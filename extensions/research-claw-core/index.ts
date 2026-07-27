/**
 * Research-Claw Core Plugin — Entry Point
 *
 * Registers all tools, RPC methods, hooks, services, and HTTP routes
 * for the literature library, task system, and workspace tracking.
 *
 * Registration totals:
 *   - 56 agent tools (17 literature + 11 task + 11 workspace + 7 monitor + 2 ppt + 1 skill_search + 4 job + 3 periph)
 *   - 137 WS RPC methods + 3 HTTP routes = 140 interface methods
 *     (rc.lit.* + rc.task.* + rc.cron.* + rc.notifications.* + rc.heartbeat.* + rc.ws.* + rc.monitor.* + rc.ppt.* + rc.oauth.* + rc.model.* + rc.app.* + rc.session.* + rc.onboarding.* + rc.periph.* = 137 WS; POST /rc/upload + GET /rc/download + GET /rc/rtsp-preview = 3 HTTP)
 *   - 11 typed hook handlers (7 hook names; agent_end ×2, after_tool_call ×4)
 *     + 1 legacy agent:bootstrap hook
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
import { WorkspaceService, WorkspaceError, WS_FILE_EXISTS, type WorkspaceConfig } from './src/workspace/service.js';
import { createWorkspaceTools } from './src/workspace/tools.js';
import { registerWorkspaceRpc } from './src/workspace/rpc.js';
import { finderStyleName, normalizeConflictMode, resolveUploadConflict } from './src/workspace/upload-conflict.js';
import { parseMultipartToTemp, type StreamedUpload } from './src/workspace/multipart.js';
import { MonitorService } from './src/monitor/service.js';
import { registerMonitorRpc } from './src/monitor/rpc.js';
import { createMonitorTools } from './src/monitor/tools.js';
import { PptService } from './src/ppt/service.js';
import { registerPptRpc } from './src/ppt/rpc.js';
import { registerSessionNamingRpc } from './src/session-naming/rpc.js';
import { SessionNamingService } from './src/session-naming/service.js';
import { createPptTools } from './src/ppt/tools.js';
import type { RegisterMethod } from './src/types.js';
import { buildRpcErrorOutcome } from './src/rpc-error.js';
import {
  auditPluginActivation,
  discoverPluginInputs,
  findRecentStartupFailures,
  resolveOpenClawStateDir,
  type ProbeInput,
} from './src/self-check/activation-probe.js';
import {
  auditRuntimeMounts,
  readSessionPromptReport,
  readSkillsCliReport,
  runtimeMountAuditSkipReason,
  selectModelVisibleEligibleSkills,
  type RuntimeProbeConfigLike,
} from './src/self-check/runtime-probe.js';
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
import { SELF_CHECK_AGENT_GUIDANCE } from './src/self-check/prompt.js';
import { registerDashboardRpc } from './src/dashboard/rpc.js';
import { PaperReviewService } from './src/paper-review/service.js';
import { registerPaperReviewRpc } from './src/paper-review/rpc.js';
import { resolveWorkspaceRoot } from './src/workspace/resolve-root.js';
import { registerProviderRpc } from './src/provider/rpc.js';
import { JobService } from './src/jobs/service.js';
import { createJobTools } from './src/jobs/tools.js';
import { registerJobRpc } from './src/jobs/rpc.js';
import { syncOpenClawSubagentJobs } from './src/jobs/openclaw-sync.js';
import { registerOnboardingRpc } from './src/onboarding/rpc.js';
import { bootstrapDoneExists } from './src/onboarding/bootstrap-done.js';
import { PeriphService } from './src/periph/service.js';
import { periphBridge } from './src/periph/bridge.js';
import { registerPeriphRpc, RTSP_PREVIEW_ROUTE } from './src/periph/rpc.js';
import { createPeriphTools } from './src/periph/tools.js';
import { PlaudManager } from './src/periph/plaud.js';
import { RtspPreviewManager, PREVIEW_PLAYLIST_NAME } from './src/periph/rtsp-preview.js';
import { resolveWithinRoot } from './src/workspace/path-guard.js';

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
let _hooksRegistered = false;
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
let _jobService: JobService | null = null;
let _periphService: PeriphService | null = null;

// ── Plaud MCP manager ──────────────────────────────────────────────────────
// Real mini stdio MCP client. Construction is pure (no process spawns until a
// tool call), so a module-level singleton is safe; it is instantiated in the
// init block below to keep all periph wiring together.
let _plaudManager: PlaudManager | null = null;

// ── RTSP→HLS live-preview manager (§15 v1.3 场景③ H1-H6) ─────────────────────
// Owns on-demand ffmpeg transmux sessions (RTSP→HLS) for the dashboard live
// preview. Process-level singleton: the idle sweep + all live sessions must
// survive runtime teardown/reload like the other periph singletons. Its
// destroy() (kill all ffmpeg + clean temp dirs) is wired to the research-claw-db
// service stop() below so a real gateway shutdown leaves no orphan processes.
let _rtspPreviewManager: RtspPreviewManager | null = null;

/**
 * Minimal session lookup surface the RTSP→HLS route handler needs. Kept as a
 * narrow interface (not the whole manager) so the route factory is unit/E2E
 * testable against a real manager OR a fake, without dragging in ffmpeg.
 */
interface RtspPreviewRouteDeps {
  getByToken: (sessionToken: string) => { dir: string } | null;
  touch: (sessionToken: string) => boolean;
  /** Symlink-aware path guard (H3). Defaults to resolveWithinRoot. */
  resolveWithinRoot?: (root: string, rel: string) => string;
  /** Playlist file name (H3 content-type branch). Defaults to PREVIEW_PLAYLIST_NAME. */
  playlistName?: string;
}

/**
 * Build the GET /rc/rtsp-preview/<token>/<file> request handler (§15 v1.3 场景③
 * H3/H4). Extracted from the inline registerHttpRoute closure so a REAL http
 * end-to-end test can mount the EXACT same logic against a real http.Server,
 * backed by a real transmux session — proving the path guard rejects `..`
 * traversal / null-byte / bad-ext and serves a real playlist/segment on the
 * happy path. The gateway auth layer (auth:'gateway' → 401 for missing token)
 * is applied by OpenClaw ahead of this handler; it is exercised separately in
 * the E2E harness which reproduces the same Bearer check.
 */
export function createRtspPreviewRouteHandler(deps: RtspPreviewRouteDeps) {
  const guard = deps.resolveWithinRoot ?? resolveWithinRoot;
  const playlist = deps.playlistName ?? PREVIEW_PLAYLIST_NAME;
  return async function rtspPreviewRouteHandler(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'GET only' } }));
      return true;
    }

    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      // Strip the route prefix → `<token>/<file>`. pathname is already
      // percent-decoded by URL for the most part; decode defensively.
      let rel = decodeURIComponent(url.pathname);
      if (rel.startsWith(RTSP_PREVIEW_ROUTE)) rel = rel.slice(RTSP_PREVIEW_ROUTE.length);
      rel = rel.replace(/^\/+/, ''); // drop leading slash(es)

      const slash = rel.indexOf('/');
      const sessionToken = slash === -1 ? rel : rel.slice(0, slash);
      const file = slash === -1 ? '' : rel.slice(slash + 1);

      if (!sessionToken || !file) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'BAD_REQUEST', message: 'token and file required' } }));
        return true;
      }

      const session = deps.getByToken(sessionToken);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'NO_SESSION', message: 'No such preview session' } }));
        return true;
      }

      // Extension allowlist: only the playlist + its transport segments.
      if (!/\.(m3u8|ts)$/.test(file)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN_EXT', message: 'Only .m3u8/.ts served' } }));
        return true;
      }

      // Path guard (H3): contain `file` within the session dir (symlink-aware).
      let resolved: string;
      try {
        resolved = guard(session.dir, file);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'PATH_ESCAPE', message: 'Path escapes session dir' } }));
        return true;
      }

      const stat = await fs.promises.stat(resolved).catch(() => null);
      if (!stat || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'Segment not found' } }));
        return true;
      }

      // A successful, authenticated hit keeps the session alive (H1) so an
      // actively-watched preview is not swept out from under the player.
      deps.touch(sessionToken);

      const isPlaylist = file.endsWith('.m3u8') || file === playlist;
      res.writeHead(200, {
        'Content-Type': isPlaylist ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
        'Content-Length': stat.size,
        // Live segments must never be cached by intermediaries.
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      fs.createReadStream(resolved).pipe(res);
      return true;
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'PREVIEW_FAILED', message: String(err) } }));
      return true;
    }
  };
}

// Server-side jobs sync loop: keeps OpenClaw subagent jobs and stale-detection
// fresh even when no dashboard is polling, and coalesces all sync triggers
// (RPC + timer) behind one throttle so the synchronous transcript sweep never
// runs more than once per window.
let _jobSyncTimer: ReturnType<typeof setInterval> | null = null;
let _lastJobSyncAt = 0;
const JOB_SYNC_THROTTLE_MS = 3_000;
const JOB_SYNC_INTERVAL_MS = 20_000;
const _runtimeProbeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const _lastRuntimeProbeReportAt = new Map<string, number>();
/** Agents already reconciled in this gateway process (see the once-per-lifetime note). */
const _runtimeReconciledAgents = new Set<string>();
/**
 * Manifest-declared tools this process chose not to register, keyed by reason.
 *
 * `contracts.tools` must list every tool the plugin may register, so a tool
 * registered behind a runtime condition is still declared unconditionally. The
 * runtime mount audit reads that manifest, so it needs to be told which absences
 * are deliberate — otherwise it reports our own decision as a mount failure.
 */
const _unregisteredDeclaredTools = new Map<string, string>();

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
  // api.resolvePath() is plugin-dir-relative, but the ppt-master submodule lives
  // at the RC git root — so resolve each relative spec against the git root first
  // (dev/submodule layout), then the plugin dir (bundled/installed layout).
  const gitRoot = findGitRoot(api.resolvePath('.'));
  const expand = (rel: string): string[] =>
    path.isAbsolute(rel) ? [rel] : [path.join(gitRoot, rel), api.resolvePath(rel)];
  const candidates = [
    ...(cfg.pptRoot ? expand(cfg.pptRoot) : []),
    ...expand('ppt-master'),
    ...expand('integrations/ppt-master'),
  ];

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

const RESEARCH_CLAW_AGENT_TOOLS = [
  'library_add_paper',
  'library_search',
  'library_list_papers',
  'library_update_paper',
  'library_get_paper',
  'library_delete_paper',
  'library_export_bibtex',
  'library_reading_stats',
  'library_batch_add',
  'library_manage_collection',
  'library_tag_paper',
  'library_add_note',
  'library_import_bibtex',
  'library_citation_graph',
  'library_zotero',
  'library_endnote',
  'library_import_ris',
  'task_create',
  'task_list',
  'task_complete',
  'task_update',
  'task_link',
  'task_note',
  'task_link_file',
  'cron_update_schedule',
  'send_notification',
  'task_flow_stage',
  'task_delete',
  'workspace_save',
  'workspace_read',
  'workspace_list',
  'workspace_diff',
  'workspace_history',
  'workspace_restore',
  'workspace_move',
  'workspace_export',
  'workspace_delete',
  'workspace_append',
  'workspace_download',
  'monitor_create',
  'monitor_list',
  'monitor_update',
  'monitor_report',
  'monitor_get_context',
  'monitor_collect_candidates',
  'monitor_note',
  'ppt_init',
  'ppt_export',
  'skill_search',
  'job_start',
  'job_checkpoint',
  'job_status',
  'job_finish',
  'periph_list',
  'periph_camera_snap',
  'periph_observe',
];

const plugin: PluginDefinition = {
  id: 'research-claw-core',
  name: 'Research-Claw Core',
  description: 'Literature library, task management, and workspace tracking for academic research',
  version: '0.7.6',
  contracts: {
    tools: RESEARCH_CLAW_AGENT_TOOLS,
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
      _jobService = new JobService(_dbManager.db);
      _monitorService.seedDefaults();
      const repairedMonitorPrompts = _monitorService.repairLegacyDefaultPrompts();
      if (repairedMonitorPrompts > 0) {
        api.logger.info(`[monitor] repaired ${repairedMonitorPrompts} legacy default prompt(s) for collector-first runs`);
      }

      _wsConfig = {
        root: resolveWorkspaceRoot(api, cfg.workspace?.root),
        autoTrackGit: cfg.autoTrackGit ?? true,
        commitDebounceMs: cfg.workspace?.commitDebounceMs ?? 5000,
        maxGitFileSize: cfg.workspace?.maxGitFileSize ?? 10_485_760,
        // Default 2GB: uploads stream to disk (O(1) memory), so the cap is a
        // sanity bound for a local workbench, not a memory guard.
        maxUploadSize: cfg.workspace?.maxUploadSize ?? 2_147_483_648,
        gitAuthorName: cfg.workspace?.gitAuthorName ?? 'Research-Claw',
        gitAuthorEmail: cfg.workspace?.gitAuthorEmail ?? 'research-claw@wentor.ai',
      };
      _periphService = new PeriphService(_dbManager.db, { workspaceRoot: _wsConfig.root });
      _plaudManager = new PlaudManager();
      _rtspPreviewManager = new RtspPreviewManager();
      try {
        _periphService.ensurePeriphGitignore();
      } catch (err) {
        console.warn('[periph] ensurePeriphGitignore failed (non-fatal):', err instanceof Error ? err.message : String(err));
      }
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
    const jobService = _jobService!;
    const wsService = _wsService!;
    const reviewService = _reviewService!;
    const pptService = _pptService!;
    const wsConfig = _wsConfig!;

    // Single coalescing entry point for the OpenClaw subagent sync. Reads the
    // live JobService from module state (robust across restart cycles) and skips
    // if another trigger synced within the throttle window.
    const throttledJobSync = (): void => {
      const svc = _jobService;
      if (!svc) return;
      const now = Date.now();
      if (now - _lastJobSyncAt < JOB_SYNC_THROTTLE_MS) return;
      _lastJobSyncAt = now;
      try {
        syncOpenClawSubagentJobs(svc, { logger: api.logger });
      } catch (err) {
        api.logger.warn(`[Jobs] OpenClaw subagent sync failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    // ── 3. Register database lifecycle service ───────────────────────
    // stop() MUST NOT close the SQLite connection or null module singletons.
    // OpenClaw calls service stop() on every plugin-runtime teardown — which
    // includes `plugins.*` HOT reloads that rebuild the agent runtime WITHOUT
    // restarting the process. _dbManager and the service instances are
    // process-shared singletons (jiti keeps module scope across register()
    // calls and across the gateway/agent runtimes), so closing or nulling them
    // here would invalidate the gateway control-plane's already-registered RPC
    // closures and permanently break every db-backed RPC with
    // "The database connection is not open" until a full restart.
    // The connection is process-owned and closed exactly once, in the 'exit'
    // handler registered above.
    api.registerService({
      id: 'research-claw-db',
      start() {
        if (_dbManager?.isOpen()) {
          const result = _dbManager.db.pragma('integrity_check') as Array<{ integrity_check: string }>;
          if (result[0]?.integrity_check !== 'ok') {
            api.logger.warn('Database integrity check returned warnings');
          }
          const stalled = jobService.markStalled(90);
          if (stalled > 0) {
            api.logger.warn(`[Jobs] Marked ${stalled} orphaned running job(s) as stalled`);
          }
          const pruned = jobService.pruneOld(30);
          if (pruned > 0) {
            api.logger.info(`[Jobs] Pruned ${pruned} terminal job(s) older than 30 days`);
          }
        }
        // Self-driving sync: refresh OpenClaw subagent jobs + sweep stalled ones
        // on an interval so the panel and notifications stay correct without a
        // dashboard open. unref() so it never keeps the process alive.
        if (!_jobSyncTimer) {
          _jobSyncTimer = setInterval(() => {
            if (!_jobService) return;
            throttledJobSync();
            _jobService.markStalled(90);
          }, JOB_SYNC_INTERVAL_MS);
          _jobSyncTimer.unref?.();
        }
      },
      stop() {
        // Process-scoped singletons survive runtime teardown (see note above).
        // EXCEPTION (§15 场景③ H1): RTSP→HLS preview sessions each hold a live
        // ffmpeg child + a temp dir. On a real gateway shutdown we MUST kill them
        // and clean up, otherwise orphan ffmpeg processes and HLS segment dirs
        // leak. destroy() is idempotent and never throws.
        if (_rtspPreviewManager) {
          void _rtspPreviewManager.destroy();
        }
      },
    });

    // ── 4. Register tools (56 total) ─────────────────────────────────
    // Tool registration is runtime-scoped in OpenClaw. The same plugin module
    // may be reused across discovery, gateway, hot-reload, and agent-runtime
    // passes, but each pass receives a fresh api/registry. Keep stateful
    // services process-singleton above, and always publish tool descriptors
    // into the current registry here.
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
    for (const tool of createJobTools(jobService)) {
      api.registerTool(tool);
    }
    for (const tool of createPeriphTools(_periphService!, periphBridge, { workspaceRoot: wsConfig.root })) {
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
        _unregisteredDeclaredTools.set(
          'skill_search',
          'research-plugins catalog.json not found, so skill search has nothing to search',
        );
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

    // ── 5. Register RPC methods (79 WS total) ────────────────────────
    // NOTE: RPC + HTTP routes MUST be registered on EVERY register() call.
    // OC calls register() twice: discovery pass (tools only) and gateway pass
    // (where registerGatewayMethod actually wires up the WS handler).
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
        if ((opts as any)?.context) {
          periphBridge.adoptContext((opts as any).context);
        }
        try {
          const result = await handler(opts.params);
          opts.respond(true, result);
        } catch (err) {
          // Preserve the domain classification (classifyError → {code,message})
          // instead of flattening to PLUGIN_ERROR, and record enough to trace
          // the failure in the log file. Secret safety: log param KEYS only —
          // never values (provider.upsert/setApiKey carry apiKey).
          const paramKeys =
            opts.params && typeof opts.params === 'object' ? Object.keys(opts.params) : [];
          const outcome = buildRpcErrorOutcome(method, err, paramKeys);
          if (outcome.level === 'error') api.logger.error(outcome.line);
          else api.logger.warn(outcome.line);
          opts.respond(false, undefined, { code: outcome.code, message: outcome.message });
        }
      });
    };
    registerLiteratureRpc(registerMethod, litService);   // 33 methods
    registerTaskRpc(registerMethod, taskService);         // 10 task + 4 cron = 14 methods
    registerWorkspaceRpc(registerMethod, wsService, wsConfig.root);  // 13 methods (recount rpc.ts when editing)
    registerMonitorRpc(registerMethod, monitorService);   // 12 methods
    registerJobRpc(registerMethod, jobService, {
      syncOpenClawSubagents: throttledJobSync,
    });
    registerPaperReviewRpc(registerMethod, reviewService); // 6 methods
    registerPptRpc(registerMethod, pptService);           // 3 methods
    registerSessionNamingRpc(registerMethod, new SessionNamingService()); // 1 method
    registerProviderRpc(registerMethod, {
      config: api.runtime.config,
      logger: api.logger,
      setApiKey: (provider, apiKey) => setApiKeyProfile(provider, apiKey),
      clearApiKey: (provider) => clearApiKeyProfile(provider),
    });
    // First-run detection for the dashboard welcome card. Getters read the
    // module singletons so a pass where init has not happened fails safe
    // (firstRun=false) instead of crashing.
    registerOnboardingRpc(registerMethod, {
      getWorkspaceRoot: () => _wsConfig?.root ?? null,
      getLitService: () => _litService,
      getTaskService: () => _taskService,
    }); // 1 method
    registerPeriphRpc(registerMethod, _periphService!, periphBridge, _plaudManager!, _rtspPreviewManager!); // 14 methods

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

        let parsed: StreamedUpload | null = null;
        try {
          // Streaming parse: file bytes land in <root>/.uploads-tmp/ (O(1) memory).
          parsed = await parseMultipartToTemp(req, {
            maxSize: wsConfig.maxUploadSize,
            tmpDir: path.join(wsConfig.root, '.uploads-tmp'),
          });
          const { file, destination, onConflict } = parsed;

          if (!file) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: { code: 'UPLOAD_NO_FILE', message: 'No file in upload' } }));
            return true;
          }

          // Sanitize destination via the symlink-aware guard (path-guard through
          // service). '.' selects the workspace root; absent defaults to sources.
          const destDir = destination === '.' ? '' : (destination || 'sources');
          let resolvedDest: string;
          try {
            resolvedDest = wsService.resolvePath(destDir || '.');
          } catch {
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

          // Conflict policy (handler-level only — save() keeps overwrite-as-Update
          // semantics for editor saves / image saves / agent tools). Default 'fail'
          // returns 409 instead of silently replacing an existing file. Emitted
          // inline, NOT thrown: the catch below would misclassify it as a 500.
          const mode = normalizeConflictMode(onConflict);
          const conflict = await resolveUploadConflict(resolvedDest, safeFilename, mode);
          if (conflict.action === 'conflict') {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: false,
              error: {
                code: 'UPLOAD_FILE_EXISTS',
                message: `Already exists: ${destDir ? `${destDir}/` : ''}${safeFilename}`,
                path: `${destDir ? `${destDir}/` : ''}${safeFilename}`,
                existing: conflict.existing,
              },
            }));
            return true;
          }

          // The write below is atomic-exclusive (unless overwrite), so a
          // concurrent upload racing for the same name cannot silently clobber:
          // the loser gets WS_FILE_EXISTS and we either re-pick a slot (rename)
          // or 409 (fail). resolveUploadConflict's stat is only the fast path.
          let finalName = conflict.fileName;
          let renamed = conflict.renamed;
          let result: Awaited<ReturnType<typeof wsService.saveFromTempFile>> | null = null;
          for (let attempt = 2; ; attempt++) {
            const destPath = destDir ? `${destDir}/${finalName}` : finalName;
            try {
              result = await wsService.saveFromTempFile(
                file.tmpPath,
                destPath,
                `Upload: ${finalName} to ${destDir || '/'}`,
                { overwrite: mode === 'overwrite' },
              );
              break;
            } catch (e) {
              if (e instanceof WorkspaceError && e.code === WS_FILE_EXISTS) {
                if (mode === 'rename' && attempt < 1002) {
                  finalName = finderStyleName(safeFilename, attempt);
                  renamed = true;
                  continue;
                }
                // fail mode (or exhausted rename slots) lost the race
                res.writeHead(409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  ok: false,
                  error: {
                    code: 'UPLOAD_FILE_EXISTS',
                    message: `Already exists: ${destDir ? `${destDir}/` : ''}${finalName}`,
                    path: `${destDir ? `${destDir}/` : ''}${finalName}`,
                    existing: 'file',
                  },
                }));
                return true;
              }
              throw e;
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            file: {
              name: finalName,
              path: result.path,
              type: 'file',
              size: result.size,
              mime_type: file.mimeType,
              modified_at: new Date().toISOString(),
              git_status: result.committed ? 'committed' : 'untracked',
              is_new: result.is_new,
              renamed,
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
        } finally {
          // Remove the staging file on every path that did not consume it via
          // rename (409 conflict, 400s, write failures). ENOENT after a
          // successful rename is the normal case.
          if (parsed?.file) {
            try {
              await fs.promises.unlink(parsed.file.tmpPath);
            } catch {
              // Already consumed or gone — fine.
            }
          }
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

          // Symlink-aware containment (path-guard via service) — this is a
          // user-controlled READ path, so the prefix-only check was a real gap
          // (workspace-internal `ln -s /etc evil` could read outside).
          let resolved: string;
          try {
            resolved = wsService.resolvePath(filePath);
          } catch {
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

    // ── 6c. Register HTTP route: GET /rc/rtsp-preview/<token>/<file> ──
    // Serves the HLS playlist + .ts segments for a live RTSP→HLS preview session
    // (§15 v1.3 场景③ H3). Reuses the SAME gateway auth token as /rc/download
    // (auth:'gateway' → Bearer / x-openclaw-password), so an unauthenticated
    // request is rejected before this handler runs.
    //
    // Path guard (H3): the requested <file> is contained to the session's temp
    // dir via resolveWithinRoot (symlink-aware realpath walk) — a `..` traversal
    // or a symlink escape is rejected. Only .m3u8 / .ts extensions are served.
    // Credentials (H4): the URL carries only the random sessionToken; the RTSP
    // user:pass never appears in the path/playlist/segment names.
    api.registerHttpRoute({
      path: RTSP_PREVIEW_ROUTE,
      auth: 'gateway',
      match: 'prefix',
      handler: createRtspPreviewRouteHandler({
        getByToken: (token) => _rtspPreviewManager?.getByToken(token) ?? null,
        touch: (token) => _rtspPreviewManager?.touch(token) ?? false,
      }),
    });

    // ── 7. Register hooks ─────────────────────────────────────────────
    // Hooks MUST only be registered once — duplicate registration causes
    // handlers to fire multiple times per event.
    if (!_hooksRegistered) {
    // Extends the probe's own config view rather than restating it: the tool
    // projection shapes are subtle enough that a second hand-written copy would
    // drift, and a drifted copy reads as "no projection configured".
    type SelfCheckConfig = RuntimeProbeConfigLike & {
      plugins?: { load?: { paths?: unknown } };
      session?: { store?: unknown };
    };

    const getSelfCheckContext = (): {
      root: string;
      stateDir: string;
      config: SelfCheckConfig;
      plugins: ProbeInput[];
    } => {
      const resolved = api.resolvePath('.');
      const startDir = typeof resolved === 'string' && resolved ? resolved : process.cwd();
      const root = findGitRoot(startDir);
      const stateDir = resolveOpenClawStateDir();
      const config = api.runtime.config.current() as SelfCheckConfig;
      const rawLoadPaths = config.plugins?.load?.paths;
      const loadPaths = Array.isArray(rawLoadPaths)
        ? rawLoadPaths.filter((item): item is string => typeof item === 'string')
        : [];
      return {
        root,
        stateDir,
        config,
        plugins: discoverPluginInputs({ projectRoot: root, stateDir, loadPaths }),
      };
    };

    const notifySelfCheck = (title: string, message: string): void => {
      try {
        taskService.sendNotificationOnce('error', title, message);
      } catch {
        // Dashboard notification is best-effort; the warning log remains.
      }
    };

    /**
     * agent_end fires before OpenClaw persists systemPromptReport. Poll the
     * requested session store briefly, then reconcile the new report against
     * an independently enumerated skills CLI result.
     */
    const scheduleRuntimeReconciliation = (
      hookContext: { sessionKey?: string; agentId?: string } | undefined,
    ): void => {
      const sessionKey = hookContext?.sessionKey;
      if (!sessionKey) return;
      const agentId = hookContext?.agentId?.trim() || 'main';
      // Plugins register their tools once at gateway startup, so the
      // manifest→mount contract is process-stable: one reconciliation per agent
      // per gateway lifetime is enough. Re-auditing every turn would spawn a
      // skills CLI subprocess and re-poll the session store on the hot path.
      if (_runtimeReconciledAgents.has(agentId)) return;
      const timerKey = `${agentId}:${sessionKey}`;
      const priorTimer = _runtimeProbeTimers.get(timerKey);
      if (priorTimer) clearTimeout(priorTimer);

      let selfCheckContext: ReturnType<typeof getSelfCheckContext>;
      try {
        selfCheckContext = getSelfCheckContext();
      } catch (error) {
        api.logger.warn(
          `[self-check] runtime probe setup failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      const skipReason = runtimeMountAuditSkipReason({
        sessionKey,
        agentId,
        config: selfCheckContext.config,
      });
      if (skipReason) {
        api.logger.debug?.(`[self-check] runtime reconciliation skipped: ${skipReason}`);
        return;
      }
      const configuredStore =
        typeof selfCheckContext.config.session?.store === 'string'
          ? selfCheckContext.config.session.store
          : undefined;
      const baseline = readSessionPromptReport({
        stateDir: selfCheckContext.stateDir,
        agentId,
        sessionKey,
        configuredStore,
      })?.generatedAt ?? 0;
      const alreadyAudited = _lastRuntimeProbeReportAt.get(timerKey) ?? 0;
      let attemptsRemaining = 20;

      const poll = (): void => {
        const report = readSessionPromptReport({
          stateDir: selfCheckContext.stateDir,
          agentId,
          sessionKey,
          configuredStore,
        });
        if (
          !report ||
          report.source !== 'run' ||
          report.generatedAt <= baseline ||
          report.generatedAt <= alreadyAudited
        ) {
          attemptsRemaining -= 1;
          if (attemptsRemaining <= 0) {
            _runtimeProbeTimers.delete(timerKey);
            api.logger.warn(
              `[self-check] runtime report unavailable after agent_end for ${sessionKey}; reconciliation skipped without blocking the run.`,
            );
            return;
          }
          const timer = setTimeout(poll, 250);
          timer.unref?.();
          _runtimeProbeTimers.set(timerKey, timer);
          return;
        }

        _runtimeProbeTimers.delete(timerKey);
        _lastRuntimeProbeReportAt.set(timerKey, report.generatedAt);
        _runtimeReconciledAgents.add(agentId);
        const entryPath = process.argv[1];
        if (!entryPath || !fs.existsSync(entryPath)) {
          api.logger.warn(
            '[self-check] OpenClaw CLI entry is unavailable; runtime skills reconciliation skipped.',
          );
          return;
        }
        void readSkillsCliReport({
          entryPath,
          cwd: selfCheckContext.root,
          agentId,
          env: process.env,
        })
          .then((skillsReport) => {
            // §W6 scopes tool reconciliation to Research-Claw's two product
            // plugins. Other OpenClaw channel plugins may intentionally expose
            // tools only under channel-specific policy.
            const productPlugins = selfCheckContext.plugins.filter(
              (pluginInput) =>
                pluginInput.id === 'research-claw-core' ||
                pluginInput.id === 'research-plugins',
            );
            for (const [tool, reason] of _unregisteredDeclaredTools) {
              api.logger.info(`[self-check] ${tool} intentionally not registered: ${reason}`);
            }
            const findings = auditRuntimeMounts({
              plugins: productPlugins,
              systemPromptReport: report,
              indexedSkillNames: selectModelVisibleEligibleSkills(skillsReport),
              intentionallyUnregisteredTools: _unregisteredDeclaredTools.keys(),
            });
            for (const finding of findings) {
              api.logger.warn(`[self-check] ${finding.message}`);
              notifySelfCheck(finding.title, finding.message);
            }
            if (findings.length === 0) {
              api.logger.info(
                `[self-check] runtime reconciliation passed (${report.tools.entries.length} mounted tools, ${report.skills.entries.length} injected skills)`,
              );
            }
          })
          .catch((error) => {
            api.logger.warn(
              `[self-check] runtime skills probe failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      };

      const timer = setTimeout(poll, 250);
      timer.unref?.();
      _runtimeProbeTimers.set(timerKey, timer);
    };

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
        lines.push(SELF_CHECK_AGENT_GUIDANCE);

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

      // Long-running processes must outlive the chat turn. A long process.poll
      // consumes the agent's entire 300s run budget and makes the UI look stuck
      // even when the worker continues successfully in the background.
      if (evt.toolName === 'process' && evt.params?.action === 'poll') {
        const timeout = Number(evt.params.timeout ?? 0);
        if (Number.isFinite(timeout) && timeout > 15_000) {
          return {
            block: true,
            blockReason:
              'Blocked: process.poll timeout exceeds 15 seconds. Create/update a persistent job, ' +
              'return control to the user, and check job_status in a later turn.',
          };
        }
      }

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

    // Runtime reconciliation must run independently of the optional memory
    // module. It reads OpenClaw's post-run persisted systemPromptReport rather
    // than trusting plugin declarations as evidence of actual mounts.
    api.on('agent_end', (_event: unknown, context: unknown) => {
      scheduleRuntimeReconciliation(
        context as { sessionKey?: string; agentId?: string } | undefined,
      );
    });

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

      // Startup self-check: silent-failure audit. Detects the v1.4.7-class gap
      // where a plugin advertises tools but lacks the activation contract, so
      // its tools silently never register. Also surfaces recent gateway
      // startup_failed crash snapshots that otherwise pile up unseen.
      // Fully guarded — a probe failure must never block gateway startup.
      try {
        const selfCheckContext = getSelfCheckContext();
        const { discovered, stateDir } = {
          discovered: selfCheckContext.plugins,
          stateDir: selfCheckContext.stateDir,
        };

        const findings = auditPluginActivation(discovered);
        for (const f of findings) {
          api.logger.warn(`[self-check] ${f.message}`);
          notifySelfCheck(`插件未正确加载:${f.id}`, f.message);
        }

        // Surface recent gateway startup_failed snapshots (last 24h) so crash
        // loops don't stay invisible (real machines had 20+ pile up unseen).
        try {
          const recent = findRecentStartupFailures(stateDir);
          if (recent.length > 0) {
            const stabilityDir = path.join(stateDir, 'logs', 'stability');
            const msg = `Found ${recent.length} gateway startup_failed snapshot(s) in the last 24h at ${stabilityDir} — the gateway crashed on a recent start.`;
            api.logger.warn(`[self-check] ${msg}`);
            notifySelfCheck('网关近期启动失败', msg);
          }
        } catch { /* stability scan is best-effort */ }

        if (findings.length === 0) {
          api.logger.info(`[self-check] plugin activation audit passed (${discovered.length} plugin(s))`);
        }
      } catch (err) {
        api.logger.warn(`[self-check] probe error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
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

        // .done sentinel defense: the loading layer historically never checked
        // BOOTSTRAP.md.done, so residual BOOTSTRAP.md (or its root symlink)
        // re-ran onboarding for users who had already completed it.
        const bootstrapDone = bootstrapDoneExists(ctx.workspaceDir);

        ctx.bootstrapFiles = ctx.bootstrapFiles.map((file) => {
          if (!RELOCATABLE_FILES.has(file.name)) return file;

          // With the sentinel present, never inject BOOTSTRAP content — blank
          // the entry using OC's missing-file shape ({name, path, missing:true},
          // no content) so hasBootstrapFileContent() stays false.
          if (file.name === 'BOOTSTRAP.md' && bootstrapDone) {
            return { name: file.name, path: file.path, missing: true };
          }

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

    api.logger.info('Research-Claw Core registered (56 tools, 137 WS RPC + 3 HTTP = 140 interfaces, 11 typed hook handlers + 1 legacy hook, 1 session monitoring service)');
    _hooksRegistered = true;
    }
  },
};

export default plugin;
