/**
 * Research-Claw Core Plugin — Entry Point
 *
 * Registers all tools, RPC methods, hooks, services, and HTTP routes
 * for the literature library, task system, and workspace tracking.
 *
 * Registration totals:
 *   - 36 agent tools (17 literature + 9 task + 7 workspace + 3 radar)
 *   - 68 WS RPC methods + 1 HTTP route = 69 interface methods
 *     (33 rc.lit.* + 11 rc.task.* + 7 rc.cron.* + 2 rc.notifications.* + 11 rc.ws.* + 4 rc.radar.* = 68 WS; POST /rc/upload = 1 HTTP)
 *   - 7 hooks (before_prompt_build, session_start, session_end, before_tool_call, agent_end, after_tool_call, gateway_start)
 *   - 1 service (research-claw-db lifecycle)
 */

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
import { WorkspaceService, type WorkspaceConfig } from './src/workspace/service.js';
import { createWorkspaceTools } from './src/workspace/tools.js';
import { registerWorkspaceRpc } from './src/workspace/rpc.js';
import { registerRadarRpc } from './src/radar/rpc.js';
import { createRadarTools } from './src/radar/tools.js';
import type { RegisterMethod } from './src/types.js';

// ── Plugin config shape ────────────────────────────────────────────────

interface PluginConfig {
  dbPath?: string;
  autoTrackGit?: boolean;
  defaultCitationStyle?: string;
  heartbeatDeadlineWarningHours?: number;
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
}

interface PluginDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  register?: (api: PluginApi) => void | Promise<void>;
}

// ── Plugin definition ──────────────────────────────────────────────────

const plugin: PluginDefinition = {
  id: 'research-claw-core',
  name: 'Research-Claw Core',
  description: 'Literature library, task management, and workspace tracking for academic research',
  version: '0.4.3',

  register(api) {
    const cfg = (api.pluginConfig ?? {}) as PluginConfig;
    const dbPath = api.resolvePath(cfg.dbPath ?? '.research-claw/library.db');
    const deadlineWarningHours = cfg.heartbeatDeadlineWarningHours ?? 48;

    api.logger.info(`Research-Claw Core initializing (db: ${dbPath})`);

    // ── 1. Initialize database ───────────────────────────────────────
    let dbManager: DatabaseManager | null = createDatabaseManager(dbPath);
    runMigrations(dbManager.db);

    // ── 2. Initialize services ───────────────────────────────────────
    const litService = new LiteratureService(dbManager.db);
    const taskService = new TaskService(dbManager.db);

    const wsConfig: WorkspaceConfig = {
      root: api.resolvePath(cfg.workspace?.root ?? 'workspace'),
      autoTrackGit: cfg.autoTrackGit ?? true,
      commitDebounceMs: cfg.workspace?.commitDebounceMs ?? 5000,
      maxGitFileSize: cfg.workspace?.maxGitFileSize ?? 10_485_760,
      maxUploadSize: cfg.workspace?.maxUploadSize ?? 0, // 0 = unlimited (local tool, no need to restrict)
      gitAuthorName: cfg.workspace?.gitAuthorName ?? 'Research-Claw',
      gitAuthorEmail: cfg.workspace?.gitAuthorEmail ?? 'research-claw@wentor.ai',
    };
    const wsService = new WorkspaceService(wsConfig);

    // Fire-and-forget: scaffold directories + git tracker in background.
    // MUST NOT await here — OpenClaw's plugin loader does not support async
    // register(). The gateway snapshots pluginRegistry.gatewayHandlers via
    // spread operator BEFORE an async register() resolves, so all RPC
    // methods would be "unknown". Completing within ~100ms, well before
    // any dashboard connection (~18s after startup).
    wsService.init().catch((err) => {
      api.logger.error(`Workspace init failed: ${err instanceof Error ? err.message : String(err)}`);
    });

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
        if (dbManager?.isOpen()) {
          // Checkpoint WAL before closing to ensure all data is flushed to the main DB file
          dbManager.db.pragma('wal_checkpoint(TRUNCATE)');
          dbManager.close();
          dbManager = null;
          api.logger.info('Research-Claw database closed');
        }
      },
    });

    // ── 4. Register tools (36 total) ─────────────────────────────────
    for (const tool of createLiteratureTools(litService)) {
      api.registerTool(tool);
    }
    for (const tool of createTaskTools(taskService)) {
      api.registerTool(tool);
    }
    for (const tool of createWorkspaceTools(wsService)) {
      api.registerTool(tool);
    }
    for (const tool of createRadarTools(dbManager.db)) {
      api.registerTool(tool);
    }

    // ── 5. Register RPC methods (68 WS total) ────────────────────────
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
    registerRadarRpc(registerMethod, dbManager.db);       // 3 methods

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

        // Cron schedule management guidance — only inject when presets exist
        const presets = taskService.cronPresetsList();
        const activePresets = presets.filter((p: { enabled: boolean }) => p.enabled);
        if (activePresets.length > 0) {
          lines.push(`[Research-Claw] ${activePresets.length} active cron preset(s). To change schedules, use cron_update_schedule(preset_id, schedule). Do NOT use native cron tools.`);
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

    // Hook 7: Verify DB integrity on gateway start
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
    });

    api.logger.info('Research-Claw Core registered (36 tools, 68 WS RPC + 1 HTTP = 69 interfaces, 7 hooks)');
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
