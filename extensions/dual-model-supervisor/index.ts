/**
 * Dual Model Supervisor — Plugin Entry Point
 *
 * Registers 7 hooks + 6 RPC methods for dual-model supervision:
 *   - Safety filtering (message_sending, before_tool_call)
 *   - Course correction (llm_output → session analysis, before_prompt_build, llm_input)
 *   - Memory guarding (before_compaction, after_compaction)
 *   - Audit logging (SQLite)
 *   - Dashboard RPC (rc.supervisor.*)
 */

import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import type {
  PluginApi,
  PluginDefinition,
  SupervisorConfig,
  SessionState,
  ModelsProviderEntry,
  ConfiguredProvider,
} from './src/core/types.js';
import { parseConfig, isSupervisorActive, isCourseCorrectionActive } from './src/core/config.js';
import { ReviewerClient } from './src/client/reviewer.js';
import { QuickChecker } from './src/hooks/quick-checker.js';
import { OutputReviewer } from './src/hooks/output-reviewer.js';
import { ToolReviewer } from './src/hooks/tool-reviewer.js';
import { MemoryGuardian } from './src/hooks/memory-guardian.js';
import { CourseCorrector } from './src/hooks/course-corrector.js';
import { ConsistencyChecker } from './src/hooks/consistency-checker.js';
import { GoalParser } from './src/hooks/goal-parser.js';
import { SummaryExtractor } from './src/hooks/summary-extractor.js';
import { AuditLogService } from './src/core/audit-log.js';
import { registerSupervisorRpc } from './src/rpc.js';
import { snapshotMessageSendingCtx, SUPERVISOR_REVIEW_SUMMARY_MARKER } from './src/hooks/hook-context.js';

// ── Module-level state (survives multiple register() calls) ──────────
let _initialized = false;
let _db: Database.Database | null = null;
let _auditLog: AuditLogService | null = null;
let _reviewerClient: ReviewerClient | null = null;
let _quickChecker: QuickChecker | null = null;
let _outputReviewer: OutputReviewer | null = null;
let _toolReviewer: ToolReviewer | null = null;
let _memoryGuardian: MemoryGuardian | null = null;
let _courseCorrector: CourseCorrector | null = null;
let _consistencyChecker: ConsistencyChecker | null = null;
let _goalParser: GoalParser | null = null;
let _summaryExtractor: SummaryExtractor | null = null;
let _activeConfig: SupervisorConfig | null = null;

/** OpenClaw `message_received` often omits `sessionId`; we mirror it from the latest `session_start`. */
let _hookActiveSessionId: string | null = null;

const _sessionStates = new Map<string, SessionState>();
let _hooksDone = false;

function getOrCreateSession(sessionId: string): SessionState {
  let state = _sessionStates.get(sessionId);
  if (!state) {
    state = {
      sessionId,
      targetConclusions: [],
      goalConfirmed: false,
      keyConclusions: [],
      userPreferences: [],
      methodologyDecisions: [],
      recentOutputs: [],
      recentSummaries: [],
      preCompactionMemory: [],
      regenerateAttempts: 0,
      regenerateHistory: [],
      pendingReviewFooter: undefined,
      pendingChannelReviewFooter: undefined,
      lastReviewReport: undefined,
    };
    _sessionStates.set(sessionId, state);
  }
  return state;
}

const DEFAULT_DB_PATH = path.join(os.homedir(), '.research-claw', 'supervisor.db');

/**
 * Gate static supervisor rules: OpenClaw may call `before_prompt_build` several times per user turn;
 * each return value is concatenated, which previously duplicated this block 2–3×.
 */
let _lastStaticSupervisorInjectAt = 0;
const STATIC_SUPERVISOR_DEBOUNCE_MS = 1500;

const STATIC_SUPERVISOR_RULES_BODY = [
  '[Supervisor] You are under dual-model supervision. Follow these rules:',
  '  - Do NOT fabricate citations, data, or experimental results',
  '  - Do NOT deviate from the current research topic',
  '  - If you have forgotten key information discussed earlier, explicitly state: "I may have lost context, please remind me"',
].join('\n');

function takeStaticSupervisorRulesBlock(reviewMode: string): string {
  if (reviewMode === 'off') return '';
  const now = Date.now();
  if (now - _lastStaticSupervisorInjectAt < STATIC_SUPERVISOR_DEBOUNCE_MS) {
    return '';
  }
  _lastStaticSupervisorInjectAt = now;
  return STATIC_SUPERVISOR_RULES_BODY;
}

/**
 * OpenClaw `llm_output` passes `assistantTexts` + `lastAssistant` (see gateway embedded run);
 * some paths may still set `response`.
 */
/**
 * Extract the main model's text output from an `llm_output` hook context.
 * Handles multiple context shapes across gateway versions: `response`, `assistantTexts`,
 * and `lastAssistant.content` (string or content block array).
 */
function extractLlmOutputText(raw: Record<string, unknown>): string | undefined {
  const direct = raw.response;
  if (typeof direct === 'string' && direct.trim().length > 0) return direct;

  const assistantTexts = raw.assistantTexts;
  if (Array.isArray(assistantTexts) && assistantTexts.length > 0) {
    const joined = assistantTexts.filter((t): t is string => typeof t === 'string').join('');
    if (joined.trim().length > 0) return joined;
  }

  const last = raw.lastAssistant;
  if (last && typeof last === 'object') {
    const c = (last as { content?: unknown }).content;
    if (typeof c === 'string' && c.trim().length > 0) return c;
    if (Array.isArray(c)) {
      const parts: string[] = [];
      for (const block of c) {
        if (block && typeof block === 'object' && 'text' in block && typeof (block as { text?: string }).text === 'string') {
          parts.push((block as { text: string }).text);
        }
      }
      const s = parts.join('');
      if (s.trim().length > 0) return s;
    }
  }

  return undefined;
}

function extractLlmInputMessages(ctx: unknown): Array<{ role: string; content: string }> | undefined {
  const c = ctx as Record<string, unknown>;
  const asMsgs = (v: unknown): Array<{ role: string; content: string }> | undefined => {
    if (!Array.isArray(v) || v.length === 0) return undefined;
    return v as Array<{ role: string; content: string }>;
  };
  let m = asMsgs(c.messages);
  if (m) return m;
  m = asMsgs(c.historyMessages);
  if (m) return m;
  const body = c.body as Record<string, unknown> | undefined;
  if (body) {
    m = asMsgs(body.messages);
    if (m) return m;
  }
  const req = c.request as Record<string, unknown> | undefined;
  if (req) {
    m = asMsgs(req.messages);
    if (m) return m;
  }
  return undefined;
}

function extractToolCallName(ctx: unknown): string | undefined {
  const c = ctx as { tool?: string; toolName?: string };
  if (typeof c.tool === 'string' && c.tool.length > 0) return c.tool;
  if (typeof c.toolName === 'string' && c.toolName.length > 0) return c.toolName;
  return undefined;
}

const plugin: PluginDefinition = {
  id: 'dual-model-supervisor',
  name: 'Dual Model Supervisor',
  description: 'Dual-model supervision: course correction, memory guarding, and safety filtering',
  version: '0.1.0',

  register(api: PluginApi) {
    const cfg = parseConfig(api.pluginConfig as Record<string, unknown> | undefined);
    _activeConfig = cfg;

    const globalCfg = api.config;
    const mergedProviders = _extractProviders(api.pluginConfig as Record<string, unknown> | undefined, globalCfg);

    api.logger.info(`Dual Model Supervisor initializing (enabled=${cfg.enabled}, mode=${cfg.reviewMode}, model=${cfg.supervisorModel || '(none)'})`);

    if (!_initialized) {
      _db = new Database(DEFAULT_DB_PATH);
      _db.pragma('journal_mode = WAL');
      _db.pragma('synchronous = FULL');

      _auditLog = new AuditLogService(_db, api.logger);

      _reviewerClient = new ReviewerClient({
        supervisorConfig: cfg,
        providers: mergedProviders,
        logger: api.logger,
      });

      _quickChecker = new QuickChecker(cfg, api.logger);
      _outputReviewer = new OutputReviewer(cfg, api.logger, _reviewerClient, _quickChecker, _auditLog);
      _toolReviewer = new ToolReviewer(cfg, api.logger, _reviewerClient, _quickChecker, _auditLog);
      _memoryGuardian = new MemoryGuardian(cfg, api.logger, _reviewerClient, _auditLog);
      _courseCorrector = new CourseCorrector(cfg, api.logger, _reviewerClient, _auditLog);
      _consistencyChecker = new ConsistencyChecker(cfg, api.logger, _reviewerClient, _auditLog);
      _goalParser = new GoalParser(cfg, api.logger, _reviewerClient, _auditLog);
      _summaryExtractor = new SummaryExtractor(cfg, api.logger, _reviewerClient, _auditLog);

      process.once('exit', () => {
        try {
          if (_db?.open) {
            _db.pragma('wal_checkpoint(TRUNCATE)');
            _db.close();
          }
        } catch { /* best-effort */ }
      });

      _initialized = true;
    } else {
      _reviewerClient!.updateProviders(mergedProviders);
      _reviewerClient!.updateSupervisorConfig(_activeConfig ?? cfg);
    }

    const reviewerClient = _reviewerClient!;
    const auditLog = _auditLog!;
    const outputReviewer = _outputReviewer!;
    const toolReviewer = _toolReviewer!;
    const memoryGuardian = _memoryGuardian!;
    const courseCorrector = _courseCorrector!;
    const consistencyChecker = _consistencyChecker!;
    const goalParser = _goalParser!;
    const summaryExtractor = _summaryExtractor!;

    // ── Register database lifecycle service ───────────────────────
    api.registerService({
      id: 'supervisor-db',
      start() {
        if (_db?.open) {
          const result = _db.pragma('integrity_check') as Array<{ integrity_check: string }>;
          if (result[0]?.integrity_check !== 'ok') {
            api.logger.warn('Supervisor database integrity check returned warnings');
          }
        }
      },
      stop() {
        if (_db?.open) {
          _db.pragma('wal_checkpoint(TRUNCATE)');
          _db.close();
          api.logger.info('Supervisor database closed');
        }
      },
    });

    // ── Register RPC methods ─────────────────────────────────────
    const registerMethod = (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
      api.registerGatewayMethod(method, async (opts: {
        params: Record<string, unknown>;
        respond: (ok: boolean, payload?: unknown, error?: { code: string; message: string }) => void;
      }) => {
        try {
          const result = await handler(opts.params);
          opts.respond(true, result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          api.logger.error(`RPC ${method} error: ${message}`);
          opts.respond(false, undefined, { code: 'SERVICE_ERROR', message });
        }
      });
    };

    registerSupervisorRpc(
      registerMethod,
      auditLog,
      () => _activeConfig ?? cfg,
      (newCfg: SupervisorConfig) => {
        _activeConfig = newCfg;
        reviewerClient.updateSupervisorConfig(newCfg);
        outputReviewer.updateConfig(newCfg);
        toolReviewer.updateConfig(newCfg);
        memoryGuardian.updateConfig(newCfg);
        courseCorrector.updateConfig(newCfg);
        consistencyChecker.updateConfig(newCfg);
        goalParser.updateConfig(newCfg);
        summaryExtractor.updateConfig(newCfg);
      },
      api.logger,
      () => _sessionStates,
      () => _extractConfiguredProviders(api.pluginConfig as Record<string, unknown> | undefined, globalCfg),
    );

    // ── Register hooks (guarded: only once across discovery + gateway passes) ──

    if (!_hooksDone) {

    api.on('session_start', (ctx: unknown) => {
      const c = ctx as { sessionId?: string };
      if (typeof c.sessionId === 'string' && c.sessionId.length > 0) {
        _hookActiveSessionId = c.sessionId;
      }
    });

    api.on('session_end', (ctx: unknown) => {
      const c = ctx as { sessionId?: string };
      if (typeof c.sessionId === 'string' && c.sessionId === _hookActiveSessionId) {
        _hookActiveSessionId = null;
      }
    });

    // before_prompt_build — inject supervisor rules + corrections + lost memory + research goal
    api.on('before_prompt_build', () => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return {};
      }

      const staticBlock = takeStaticSupervisorRulesBlock(activeCfg.reviewMode);

      const sessionIds = Array.from(_sessionStates.keys());
      const lastSession = sessionIds.length > 0 ? _sessionStates.get(sessionIds[sessionIds.length - 1]!) : null;

      if (lastSession) {
        const injection = courseCorrector.buildContextInjection(lastSession);

        // P1: Inject research goal + target conclusions into the main model's context
        const goalLines: string[] = [];
        if (lastSession.researchGoal && lastSession.goalConfirmed) {
          goalLines.push(`[Research Goal] ${lastSession.researchGoal}`);
          if (lastSession.targetConclusions.length > 0) {
            goalLines.push(`[Target Conclusions] You are expected to reach the following conclusions:`);
            for (const target of lastSession.targetConclusions) {
              goalLines.push(`  - ${target}`);
            }
          }
          if (lastSession.methodology) {
            goalLines.push(`[Methodology] ${lastSession.methodology}`);
          }
        }

        if (goalLines.length > 0) {
          const goalContext = goalLines.join('\n');
          const existingContext = injection.prependContext ?? '';
          const merged = [staticBlock, goalContext, existingContext].filter((s) => s.length > 0).join('\n\n');
          return { prependContext: merged };
        }

        const rest = injection.prependContext ?? '';
        const merged = [staticBlock, rest].filter((s) => s.length > 0).join('\n\n');
        return merged ? { prependContext: merged } : injection;
      }

      if (staticBlock.length > 0) {
        return { prependContext: staticBlock };
      }

      return {};
    });

    // message_received — track session and parse research goal via reviewer model
    api.on('message_received', (ctx: unknown) => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return {};
      }

      const context = ctx as { sessionId?: string; message?: string };
      const sessionId = context.sessionId ?? _hookActiveSessionId ?? undefined;
      if (sessionId) {
        const state = getOrCreateSession(sessionId);
        // P0: Use GoalParser instead of naive truncation
        if (!state.researchGoal && context.message && context.message.length > 10) {
          goalParser.parseGoal(context.message, sessionId, state);
        }
      }

      return {};
    });

    // llm_input — consistency check + inject corrective system message
    api.on('llm_input', async (ctx: unknown) => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return {};
      }

      const context = ctx as { sessionId?: string };
      const messages = extractLlmInputMessages(ctx);
      if (!messages || messages.length === 0) {
        return {};
      }

      const sessionId = context.sessionId ?? _hookActiveSessionId ?? 'default';
      const state = getOrCreateSession(sessionId);

      return consistencyChecker.checkConsistency(messages, sessionId, state);
    });

    // llm_output — record raw output, extract structured summary, run course correction.
    // Also triggers output review and caches the result in session state,
    // so `before_message_write` / `message_sending` can attach the review footer.
    api.on('llm_output', (ctx: unknown) => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return;
      }

      const context = ctx as Record<string, unknown>;
      const outputText = extractLlmOutputText(context);
      const sessionId = (context.sessionId as string | undefined) ?? _hookActiveSessionId ?? undefined;

      // Mirror sessionId so other hooks (before_message_write) can find it
      if (sessionId && sessionId !== _hookActiveSessionId) {
        _hookActiveSessionId = sessionId;
      }

      if (!sessionId || !outputText) {
        return;
      }

      try {
        const state = getOrCreateSession(sessionId);
        state.lastLlmOutput = outputText;
        summaryExtractor.extractSummary(outputText, sessionId, state);
        if (isCourseCorrectionActive(activeCfg)) {
          courseCorrector.analyzeSession(sessionId, state);
        }

        // Trigger output review and cache the channel footer for message_sending
        // Review always runs (to record results for Dashboard panel), footer only when channel delivery is enabled
        if (!outputText.includes(SUPERVISOR_REVIEW_SUMMARY_MARKER)) {
          const shouldAttachToChannel = activeCfg.appendReviewToChannelOutput;
          outputReviewer.reviewMessageSending(outputText, sessionId, state, {
            attachSummary: shouldAttachToChannel,
          }).then((modified) => {
            if (modified !== null) {
              // Cache for channel delivery in message_sending hook
              state.pendingChannelReviewFooter = modified;
            }
          }).catch((err) => {
            api.logger.error(`[Supervisor] llm_output async review failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      } catch (err) {
        api.logger.error(`[Supervisor] llm_output error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // message_sending — append review footer ONLY when delivering through external channels.
    // Dashboard users see review results in the Supervisor panel instead.
    // When delivering to Telegram/WeChat/Discord, the review footer is appended so
    // users who interact through IM channels receive the audit report directly.
    api.on('message_sending', async (ctx: unknown) => {
      const activeCfg = _activeConfig ?? cfg;
      const context = ctx as { sessionId?: string; message?: string };

      if (!isSupervisorActive(activeCfg)) {
        return {};
      }

      if (!context.message) {
        return {};
      }

      const snap = snapshotMessageSendingCtx(ctx);

      // Check if this is a channel delivery (Telegram/WeChat/Discord etc.)
      // Only append review footer when delivering through external channels
      const isChannelDelivery = snap.isChannelDelivery;

      if (snap.deferReview) {
        return {};
      }

      const sessionId = context.sessionId ?? _hookActiveSessionId ?? 'default';
      const state = getOrCreateSession(sessionId);

      // Only attach review footer when delivering through external channels
      if (!isChannelDelivery) {
        // Clear any cached footer to prevent stale data
        if (state.pendingChannelReviewFooter) {
          state.pendingChannelReviewFooter = undefined;
        }
        return {};
      }

      // Channel delivery — check for cached footer first
      if (state.pendingChannelReviewFooter) {
        const footer = state.pendingChannelReviewFooter;
        state.pendingChannelReviewFooter = undefined;
        return { message: footer };
      }

      // No cached footer — perform live review with footer for channel
      if (!activeCfg.appendReviewToChannelOutput) {
        return {};
      }

      const modified = await outputReviewer.reviewMessageSending(context.message, sessionId, state, {
        attachSummary: true,
      });

      if (modified !== null) {
        return { message: modified };
      }

      return {};
    });

    // before_message_write — synchronously prepare session state for the review
    // that will be completed asynchronously by the llm_output hook.
    // NOTE: The gateway treats this hook as SYNCHRONOUS — returning a Promise
    // (via `async`) causes the result to be silently ignored. All actual review
    // logic lives in `llm_output` which correctly supports async handlers.
    api.on('before_message_write', (ctx: unknown) => {
      const activeCfg = _activeConfig ?? cfg;
      const context = ctx as { sessionId?: string; message?: unknown };

      const msg = context.message;

      // Resolve sessionId: context.sessionId → _hookActiveSessionId → extract from message
      let sessionId = context.sessionId ?? _hookActiveSessionId;
      if (!sessionId && msg && typeof msg === 'object') {
        const msgObj = msg as Record<string, unknown>;
        if (typeof msgObj.sessionId === 'string') {
          sessionId = msgObj.sessionId;
        }
      }

      if (!sessionId) sessionId = 'default';

      if (!isSupervisorActive(activeCfg)) {
        return {};
      }

      // Ensure session state exists so llm_output's async callback can populate it
      getOrCreateSession(sessionId);

      // Always return empty — we don't modify the message content in before_message_write
      return {};
    });

    // before_tool_call — tool call review
    api.on('before_tool_call', async (ctx: unknown) => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return {};
      }

      const context = ctx as { sessionId?: string; params?: Record<string, unknown> };
      const tool = extractToolCallName(ctx);
      if (!tool) {
        return {};
      }

      const sessionId = context.sessionId ?? _hookActiveSessionId ?? 'default';
      const result = await toolReviewer.review(tool, context.params ?? {}, sessionId);

      if (result.block) {
        return { block: true, blockReason: result.blockReason };
      }
      if (result.params) {
        return { params: result.params };
      }

      return {};
    });

    // before_compaction — memory anchor injection
    api.on('before_compaction', async (ctx: unknown) => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return {};
      }

      const context = ctx as { sessionId?: string; messages?: Array<{ role: string; content: string }> };
      if (!context.messages) {
        return {};
      }

      const sessionId = context.sessionId ?? 'default';
      const state = getOrCreateSession(sessionId);

      return memoryGuardian.beforeCompaction(context.messages, sessionId, state);
    });

    // after_compaction — memory loss detection
    api.on('after_compaction', async (ctx: unknown) => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return;
      }

      const context = ctx as {
        sessionId?: string;
        original?: Array<{ role: string; content: string }>;
        compacted?: Array<{ role: string; content: string }>;
      };

      if (!context.original || !context.compacted) {
        return;
      }

      const sessionId = context.sessionId ?? 'default';
      const state = getOrCreateSession(sessionId);

      await memoryGuardian.afterCompaction(context.original, context.compacted, sessionId, state);
    });

    // session_end — output regeneration summary and cleanup session state
    api.on('session_end', (ctx: unknown) => {
      const context = ctx as { sessionId?: string };
      if (context.sessionId) {
        const state = _sessionStates.get(context.sessionId);
        if (state && state.regenerateHistory.length > 0) {
          const summary = courseCorrector.buildRegenerationSummary(state);
          if (summary) {
            auditLog.record({
              sessionId: context.sessionId,
              type: 'force_regenerate',
              action: 'info',
              details: summary,
              timestamp: Date.now(),
            });
            api.logger.info(`[Supervisor] Session ${context.sessionId} regeneration summary: ${state.regenerateAttempts} attempt(s)`);
          }
        }
        _sessionStates.delete(context.sessionId);
      }
    });

    _hooksDone = true;
    } // end _hooksDone guard

    api.logger.info('Dual Model Supervisor registered (7 hooks + 6 RPC methods)');
  },
};

/**
 * Merge provider maps: root `config.models.providers` (OpenClaw global) + plugin entry overrides.
 * Plugin-specific `providers` / `models.providers` win on key collision.
 */
function _extractProviders(
  pluginConfig?: Record<string, unknown>,
  globalConfig?: Record<string, unknown>,
): Record<string, ModelsProviderEntry> {
  const globalModels = globalConfig?.models as Record<string, unknown> | undefined;
  const fromGlobal = (globalModels?.providers as Record<string, ModelsProviderEntry> | undefined) ?? {};

  if (!pluginConfig) {
    return { ...fromGlobal };
  }

  const pluginProviders = pluginConfig.providers as Record<string, ModelsProviderEntry> | undefined;
  if (pluginProviders && Object.keys(pluginProviders).length > 0) {
    return { ...fromGlobal, ...pluginProviders };
  }

  const models = pluginConfig.models as Record<string, unknown> | undefined;
  const modelsProviders = models?.providers as Record<string, ModelsProviderEntry> | undefined;
  if (modelsProviders && Object.keys(modelsProviders).length > 0) {
    return { ...fromGlobal, ...modelsProviders };
  }

  return { ...fromGlobal };
}

/**
 * Extract configured provider list for RPC response.
 * Reads from models.providers in the openclaw config.
 */
function _extractConfiguredProviders(
  pluginConfig?: Record<string, unknown>,
  globalConfig?: Record<string, unknown>,
): ConfiguredProvider[] {
  const providers = _extractProviders(pluginConfig, globalConfig);
  const result: ConfiguredProvider[] = [];

  for (const [key, cfg] of Object.entries(providers)) {
    if (!cfg.baseUrl) continue;
    result.push({
      key,
      label: key, // Front-end will map to preset label
      hasApiKey: Boolean(cfg.apiKey),
      models: (cfg.models ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id })),
      baseUrl: cfg.baseUrl,
      api: cfg.api,
    });
  }

  return result;
}

export default plugin;
