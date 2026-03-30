/**
 * Research-Claw Core Plugin — Entry Point
 *
 * Registers all tools, RPC methods, hooks, services, and HTTP routes
 * for the literature library, task system, and workspace tracking.
 *
 * Registration totals:
 *   - 39 agent tools (17 literature + 10 task + 7 workspace + 5 monitor)
 *   - 81 WS RPC methods + 1 HTTP route = 82 interface methods
 *     (34 rc.lit.* + 11 rc.task.* + 7 rc.cron.* + 2 rc.notifications.* + 2 rc.heartbeat.* + 12 rc.ws.* + 12 rc.monitor.* + 1 rc.model.* = 81 WS; POST /rc/upload = 1 HTTP)
 *   - 8 hooks (before_prompt_build, session_start, session_end, before_tool_call, agent_end, after_tool_call ×2, gateway_start, agent:bootstrap)
 *   - 1 service (research-claw-db lifecycle)
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
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
  register?: (api: PluginApi) => void | Promise<void>;
}

// ── Module-level state (survives multiple register() calls per boot) ──────
// OC calls register() multiple times per gateway boot (full + discovery
// registration modes). jiti loads .ts directly so module scope persists
// across calls. All stateful resources (DB, services, workspace) must be
// initialized once and reused — creating duplicates wastes file handles
// and causes git lock races.
let _initialized = false;
let _dbManager: DatabaseManager | null = null;
let _litService: InstanceType<typeof LiteratureService> | null = null;
let _taskService: InstanceType<typeof TaskService> | null = null;
let _heartbeatService: InstanceType<typeof HeartbeatService> | null = null;
let _monitorService: InstanceType<typeof MonitorService> | null = null;
let _wsService: InstanceType<typeof WorkspaceService> | null = null;
let _wsConfig: WorkspaceConfig | null = null;
let _wsInitPromise: Promise<void> | null = null;
let _pptService: InstanceType<typeof PptService> | null = null;

// ── Tool call probe state ─────────────────────────────────────────────
// Caches Ollama tool-calling probe results per model string (30-min TTL).
// _lastProbeResult is read by before_prompt_build to inject agent warnings.
const PROBE_TTL_MS = 30 * 60 * 1000;
let _toolCallProbeCache = new Map<string, { supported: boolean; model: string; provider: string; testedAt: number }>();
let _lastProbeResult: { supported: boolean; model: string } | null = null;

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

const plugin: PluginDefinition = {
  id: 'research-claw-core',
  name: 'Research-Claw Core',
  description: 'Literature library, task management, and workspace tracking for academic research',
  version: '0.6.0',

  register(api) {
    const cfg = (api.pluginConfig ?? {}) as PluginConfig;
    const dbPath = api.resolvePath(cfg.dbPath ?? '.research-claw/library.db');
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
        root: api.resolvePath(cfg.workspace?.root ?? 'workspace'),
        autoTrackGit: cfg.autoTrackGit ?? true,
        commitDebounceMs: cfg.workspace?.commitDebounceMs ?? 5000,
        maxGitFileSize: cfg.workspace?.maxGitFileSize ?? 10_485_760,
        maxUploadSize: cfg.workspace?.maxUploadSize ?? 0,
        gitAuthorName: cfg.workspace?.gitAuthorName ?? 'Research-Claw',
        gitAuthorEmail: cfg.workspace?.gitAuthorEmail ?? 'research-claw@wentor.ai',
      };
      _wsService = new WorkspaceService(_wsConfig);
      _pptService = new PptService({
        pptRoot: resolvePptRoot(api, cfg),
        workspaceRoot: _wsConfig.root,
        repoRoot: api.resolvePath('.'),
      });

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
        _wsConfig = null;
        _wsInitPromise = null;
        _toolCallProbeCache = new Map();
        _lastProbeResult = null;
        _initialized = false;
      },
    });

    // ── 4. Register tools (39 total) ─────────────────────────────────
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

    // ── 5. Register RPC methods (78 WS total) ────────────────────────
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
    registerPptRpc(registerMethod, pptService);           // 3 methods

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
      const { oauthInitiate } = require('./src/oauth/service');
      const provider = params.provider as string;
      if (!provider) throw new Error('provider is required');
      return oauthInitiate(provider);
    });
    registerMethod('rc.oauth.complete', async (params: Record<string, unknown>) => {
      const { oauthComplete } = require('./src/oauth/service');
      const stateId = params.state_id as string;
      const callbackUrl = params.callback_url as string;
      if (!stateId || !callbackUrl) throw new Error('state_id and callback_url are required');
      return oauthComplete(stateId, callbackUrl);
    });
    registerMethod('rc.oauth.status', (params: Record<string, unknown>) => {
      const { oauthStatus } = require('./src/oauth/service');
      const provider = params.provider as string;
      if (!provider) throw new Error('provider is required');
      return oauthStatus(provider);
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
          const destDir = destination || 'uploads';
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

    // ── 7. Register hooks (6) ────────────────────────────────────────

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

        return { prependContext: lines.join('\n') };
      } catch {
        return {};
      }
    });

    // Hook 2: Ensure DB is open and migrated on session start
    api.on('session_start', () => {
      if (dbManager?.isOpen()) {
        runMigrations(dbManager.db);
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

    api.on('before_tool_call', (event: unknown) => {
      const evt = event as { toolName?: string; params?: Record<string, unknown> } | undefined;
      if (!evt) return {};

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

    // Hook 5: Record agent run summary
    api.on('agent_end', () => {
      // Lightweight: future versions can log session summary to activity_log
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

    // Hook 8: Verify DB integrity + bootstrap heartbeat on gateway start
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

    // Hook 8: Redirect bootstrap file loading from workspace root to .ResearchClaw/ subdirectory.
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

    api.logger.info('Research-Claw Core registered (39 tools, 78 WS RPC + 1 HTTP = 79 interfaces, 8 hooks)');
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
