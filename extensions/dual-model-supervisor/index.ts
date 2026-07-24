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

import * as fs from 'node:fs';
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
import { parseConfig, isSupervisorActive, isCourseCorrectionActive, isMemoryGuardActive } from './src/core/config.js';
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
import { hookSessionKey } from './src/oc/hook-types.js';
import type { PluginHookLlmOutputEvent, PluginHookLlmInputEvent } from './src/oc/hook-types.js';

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

/** Resolve supervisor DB path: pluginConfig.dbPath > DEFAULT_DB_PATH. */
function resolveSupervisorDbPath(pluginConfig: Record<string, unknown> | undefined): string {
  const raw = typeof pluginConfig?.dbPath === 'string' ? pluginConfig.dbPath : '';
  if (!raw) return DEFAULT_DB_PATH;
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return path.isAbsolute(raw) ? raw : path.resolve(raw);
}

/**
 * Gate static supervisor rules: OpenClaw may call `before_prompt_build` several times per user turn;
 * each return value is concatenated, which previously duplicated this block 2–3×.
 */
const STATIC_SUPERVISOR_DEBOUNCE_MS = 1500;

const STATIC_SUPERVISOR_RULES_BODY = [
  '[Supervisor] You are under dual-model supervision. Follow these rules:',
  '  - Do NOT fabricate citations, data, or experimental results',
  '  - Do NOT deviate from the current research topic',
  '  - If you have forgotten key information discussed earlier, explicitly state: "I may have lost context, please remind me"',
].join('\n');

function takeStaticSupervisorRulesBlock(reviewMode: string, state: SessionState | null): string {
  if (reviewMode === 'off') return '';
  const now = Date.now();
  const lastInject = state?.lastStaticSupervisorInjectAt ?? 0;
  if (now - lastInject < STATIC_SUPERVISOR_DEBOUNCE_MS) {
    return '';
  }
  if (state) {
    state.lastStaticSupervisorInjectAt = now;
  }
  return STATIC_SUPERVISOR_RULES_BODY;
}

/**
 * Extract the main model's text output from the REAL `llm_output` event
 * (PluginHookLlmOutputEvent). Reads only fields that exist on the current OC
 * 2026.6.1 contract: `assistantTexts: string[]` (authoritative) and
 * `lastAssistant` (typed `unknown` → runtime-guarded). No phantom `response`
 * fallback — reading a field not on the typed event would fail tsc.
 */
function extractLlmOutputText(event: PluginHookLlmOutputEvent): string | undefined {
  const { assistantTexts, lastAssistant } = event;
  if (Array.isArray(assistantTexts) && assistantTexts.length > 0) {
    const joined = assistantTexts.filter((t): t is string => typeof t === 'string').join('');
    if (joined.trim().length > 0) return joined;
  }

  if (lastAssistant && typeof lastAssistant === 'object') {
    const c = (lastAssistant as { content?: unknown }).content;
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

/**
 * Extract prior-turn messages from the REAL `llm_input` event
 * (PluginHookLlmInputEvent). The messages live in `historyMessages: unknown[]`
 * (NOT `messages`/`body`/`request` — those are phantom on the current contract).
 * Elements are runtime-guarded to the {role, content} shape the consumer needs.
 */
function extractLlmInputMessages(event: PluginHookLlmInputEvent): Array<{ role: string; content: string }> | undefined {
  const raw = event.historyMessages;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const msgs = raw.filter(
    (m): m is { role: string; content: string } =>
      !!m &&
      typeof m === 'object' &&
      typeof (m as { role?: unknown }).role === 'string' &&
      typeof (m as { content?: unknown }).content === 'string',
  );
  return msgs.length > 0 ? msgs : undefined;
}

/**
 * Session key for a hook, resolved from its OWN (event, ctx) with a fallback
 * chain — the real OpenClaw contract puts the canonical key on `ctx.sessionKey`.
 * NEVER falls back to a process-global "last active session" (that leaked one
 * session's output to another). Structural best-effort for hooks whose ctx also
 * carries sessionId; the strict, type-checked path is `hookSessionKey(ctx)`,
 * used where a session must not be guessed (message_sending).
 */
function resolveSessionKey(
  ctx: { sessionKey?: string; sessionId?: string } | undefined,
  event?: { sessionKey?: string; sessionId?: string } | undefined,
): string | undefined {
  for (const v of [ctx?.sessionKey, ctx?.sessionId, event?.sessionKey, event?.sessionId]) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
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

    // Extract main model reference for fallback when supervisorModel is empty
    const mainModel = (globalCfg?.agents as Record<string, unknown>)?.defaults as Record<string, unknown>;
    const mainModelPrimary = (mainModel?.model as Record<string, unknown>)?.primary;
    const fallbackModel = typeof mainModelPrimary === 'string' ? mainModelPrimary : '';

    api.logger.info(`Dual Model Supervisor initializing (enabled=${cfg.enabled}, mode=${cfg.reviewMode}, model=${cfg.supervisorModel || `(inherit: ${fallbackModel})` || '(none)'})`);

    if (!_initialized) {
      try {
        const dbPath = resolveSupervisorDbPath(api.pluginConfig as Record<string, unknown> | undefined);
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        _db = new Database(dbPath);
        _db.pragma('journal_mode = WAL');
        _db.pragma('synchronous = FULL');
      } catch (dbErr) {
        api.logger.warn(`Supervisor DB init failed (audit logging disabled): ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
        _db = null;
      }

      _auditLog = new AuditLogService(_db, api.logger);

      _reviewerClient = new ReviewerClient({
        supervisorConfig: cfg,
        providers: mergedProviders,
        logger: api.logger,
        fallbackModel,
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
      _reviewerClient!.updateFallbackModel(fallbackModel);
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
        // Checkpoint only — do not close. Gateway plugin reload calls stop() then
        // register() again in-process; closing here leaves a stale handle while
        // _initialized stays true (rc.supervisor.status → "database is not open").
        if (_db?.open) {
          _db.pragma('wal_checkpoint(TRUNCATE)');
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

    // ── Config persistence callback ────────────────────────────────
    const configPath = path.join(process.cwd(), 'config', 'openclaw.json');
    const persistConfig = (newCfg: SupervisorConfig): void => {
      try {
        if (!fs.existsSync(configPath)) return;
        const raw = fs.readFileSync(configPath, 'utf8');
        const ocConfig = JSON.parse(raw);
        if (!ocConfig.plugins) ocConfig.plugins = {};
        if (!ocConfig.plugins.entries) ocConfig.plugins.entries = {};
        if (!ocConfig.plugins.entries['dual-model-supervisor']) {
          ocConfig.plugins.entries['dual-model-supervisor'] = {};
        }
        const existing = ocConfig.plugins.entries['dual-model-supervisor'].config || {};
        ocConfig.plugins.entries['dual-model-supervisor'].config = {
          ...existing,  // preserve dbPath and other infra keys
          enabled: newCfg.enabled,
          supervisorModel: newCfg.supervisorModel,
          reviewMode: newCfg.reviewMode,
          appendReviewToChannelOutput: newCfg.appendReviewToChannelOutput,
          memoryGuard: newCfg.memoryGuard,
          courseCorrection: newCfg.courseCorrection,
          highRiskTools: newCfg.highRiskTools,
        };
        const tmpPath = configPath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(ocConfig, null, 2) + '\n', 'utf8');
        fs.renameSync(tmpPath, configPath);
        api.logger.info('Supervisor config persisted to openclaw.json');
      } catch (err) {
        api.logger.warn(`Failed to persist supervisor config: ${err instanceof Error ? err.message : String(err)}`);
      }
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
      persistConfig,
    );

    // ── Register hooks (guarded: only once across discovery + gateway passes) ──

    if (!_hooksDone) {

    // before_prompt_build — inject supervisor rules + corrections + lost memory + research goal.
    // ctx (PluginHookAgentContext) carries the canonical sessionKey; no global fallback.
    api.on('before_prompt_build', (_event, ctx) => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return {};
      }

      const sessionKey = resolveSessionKey(ctx);
      const lastSession = sessionKey ? _sessionStates.get(sessionKey) ?? null : null;

      const staticBlock = takeStaticSupervisorRulesBlock(activeCfg.reviewMode, lastSession);

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

    // message_received — parse research goal. Inbound text is `event.content`;
    // canonical session key is on ctx (or the event), never a global fallback.
    api.on('message_received', (event, ctx) => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return;
      }

      const sessionKey = resolveSessionKey(ctx, event);
      if (!sessionKey) return;
      const text = event.content; // typed PluginHookMessageReceivedEvent.content
      const state = getOrCreateSession(sessionKey);
      if (!state.researchGoal && text.length > 10) {
        goalParser.parseGoal(text, sessionKey, state);
      }
    });

    // llm_input — llm_input is a void hook (its return is discarded by OC), so the
    // consistency injection cannot take effect here; retained best-effort for
    // detection only, resolving the session from ctx.
    api.on('llm_input', (event, ctx) => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return;
      }

      const messages = extractLlmInputMessages(event);
      if (!messages || messages.length === 0) {
        return;
      }

      const sessionKey = resolveSessionKey(ctx, event);
      if (!sessionKey) return;
      const state = getOrCreateSession(sessionKey);
      void consistencyChecker.checkConsistency(messages, sessionKey, state);
    });

    // llm_output — record raw output, extract structured summary, run course correction.
    // Also triggers output review and caches the result in session state,
    // so `before_message_write` / `message_sending` can attach the review footer.
    api.on('llm_output', (event, ctx) => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return;
      }

      const outputText = extractLlmOutputText(event);
      // Key by the canonical sessionKey so the footer cached here is found by
      // message_sending (which resolves the SAME ctx.sessionKey).
      const sessionKey = resolveSessionKey(ctx, event);

      if (!sessionKey || !outputText) {
        return;
      }

      try {
        const state = getOrCreateSession(sessionKey);
        state.lastLlmOutput = outputText;
        summaryExtractor.extractSummary(outputText, sessionKey, state);
        if (isCourseCorrectionActive(activeCfg)) {
          courseCorrector.analyzeSession(sessionKey, state);
        }

        // Trigger output review and cache the channel footer for message_sending
        // Review always runs (to record results for Dashboard panel), footer only when channel delivery is enabled
        if (!outputText.includes(SUPERVISOR_REVIEW_SUMMARY_MARKER)) {
          const shouldAttachToChannel = activeCfg.appendReviewToChannelOutput;
          outputReviewer.reviewMessageSending(outputText, sessionKey, state, {
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
    api.on('message_sending', async (event, ctx) => {
      const activeCfg = _activeConfig ?? cfg;

      if (!isSupervisorActive(activeCfg)) {
        return {};
      }

      // Outgoing text is `event.content` (typed PluginHookMessageSendingEvent);
      // the result field is `content` (PluginHookMessageSendingResult). Typed
      // access — reading a phantom field (e.g. event.sessionId) fails tsc.
      const text = event.content;
      if (!text) {
        return {};
      }

      // Channel-delivery + streaming detection reads the EVENT (metadata lives there).
      const snap = snapshotMessageSendingCtx(event);
      if (snap.deferReview) {
        return {};
      }

      // Canonical session key ONLY — message_sending has no sessionId anywhere and
      // must NEVER guess a session (that leaked one user's review to another).
      // hookSessionKey is typed to the OC ctx, so a sessionKey rename fails tsc.
      const sessionKey = hookSessionKey(ctx);
      if (!sessionKey) {
        return {};
      }
      const state = _sessionStates.get(sessionKey);

      // Only attach review footer when delivering through external channels
      if (!snap.isChannelDelivery) {
        if (state?.pendingChannelReviewFooter) {
          state.pendingChannelReviewFooter = undefined;
        }
        return {};
      }

      // Channel delivery — prefer the footer cached by llm_output (consume once).
      if (state?.pendingChannelReviewFooter) {
        const footer = state.pendingChannelReviewFooter;
        state.pendingChannelReviewFooter = undefined;
        return { content: footer };
      }

      // No cached footer — perform live review with footer for channel.
      if (!activeCfg.appendReviewToChannelOutput) {
        return {};
      }

      const liveState = getOrCreateSession(sessionKey);
      const modified = await outputReviewer.reviewMessageSending(text, sessionKey, liveState, {
        attachSummary: true,
      });

      if (modified !== null) {
        return { content: modified };
      }

      return {};
    });

    // before_message_write — synchronously prepare session state for the review
    // that will be completed asynchronously by the llm_output hook.
    // NOTE: The gateway treats this hook as SYNCHRONOUS — returning a Promise
    // (via `async`) causes the result to be silently ignored. All actual review
    // logic lives in `llm_output` which correctly supports async handlers.
    api.on('before_message_write', (_event, ctx) => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return {};
      }

      // ctx is { agentId?, sessionKey? }. Ensure session state exists so
      // llm_output's async callback can populate it; no global fallback.
      const sessionKey = resolveSessionKey(ctx, _event);
      if (sessionKey) {
        getOrCreateSession(sessionKey);
      }

      return {};
    });

    // before_tool_call — safety gate. tool name + params are on the EVENT. The
    // review runs regardless of session (safety is never skipped); the session
    // key is used only for the audit record.
    api.on('before_tool_call', async (event, ctx) => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return {};
      }

      // Typed PluginHookBeforeToolCallEvent: toolName + params are required fields.
      const tool = event.toolName;
      if (!tool) {
        return {};
      }

      const sessionKey = resolveSessionKey(ctx) ?? 'unknown-session';
      const result = await toolReviewer.review(tool, event.params ?? {}, sessionKey);

      if (result.block) {
        return { block: true, blockReason: result.blockReason };
      }
      if (result.params) {
        return { params: result.params };
      }

      return {};
    });

    // before_compaction — memory anchor injection (memory-guard business →
    // gated by the memory-guard switch, per invariant: no memory work when off).
    api.on('before_compaction', async (event, ctx) => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isMemoryGuardActive(activeCfg)) {
        return;
      }

      // Typed PluginHookBeforeCompactionEvent.messages is `unknown[]` — read the
      // real field and runtime-guard elements to the {role, content} shape.
      const raw = event.messages;
      if (!Array.isArray(raw) || raw.length === 0) {
        return;
      }
      const messages = raw.filter(
        (m): m is { role: string; content: string } =>
          !!m &&
          typeof m === 'object' &&
          typeof (m as { role?: unknown }).role === 'string' &&
          typeof (m as { content?: unknown }).content === 'string',
      );
      if (messages.length === 0) {
        return;
      }

      const sessionKey = resolveSessionKey(ctx);
      if (!sessionKey) return;
      const state = getOrCreateSession(sessionKey);

      // NOTE (dead-path, surfaced by the typed hook gate): OC types before_compaction
      // as a VOID hook — a modifying return is discarded. The memory-guard anchor
      // injection here cannot take effect via the return value; retained for its
      // state side-effects only. Real injection must move to a live channel
      // (before_prompt_build) — tracked for the memory-guard remediation.
      await memoryGuardian.beforeCompaction(messages, sessionKey, state);
    });

    // after_compaction — memory-loss detection.
    //
    // CONTRACT-VERIFIED (OC 2026.6.1 PluginHookAfterCompactionEvent):
    // the event carries ONLY { messageCount, tokenCount?, compactedCount,
    // sessionFile? } — NOT the before/after message arrays. Content-based
    // memory-loss detection is therefore IMPOSSIBLE from the event alone.
    //
    // The previous code read phantom `event.original` / `event.compacted` (via an
    // `as` cast that invented the fields), so `MemoryGuardian.afterCompaction`
    // NEVER ran — a SILENT dead path. It is disabled here and made OBSERVABLE:
    // we record that compaction happened + why detection is unavailable. Wiring
    // real detection requires parsing `event.sessionFile` — tracked for the
    // memory-guard remediation (not P1). `void memoryGuardian` keeps the
    // dependency wired for that follow-up.
    api.on('after_compaction', (event, ctx) => {
      const activeCfg = _activeConfig ?? cfg;
      // Feature switch first: no memory_guard business audit when the guard is
      // OFF (invariant: observability must not override the feature switch).
      if (!isMemoryGuardActive(activeCfg)) {
        return;
      }
      const sessionKey = resolveSessionKey(ctx);
      if (!sessionKey) return;
      void memoryGuardian;
      auditLog.record({
        sessionId: sessionKey,
        type: 'memory_guard',
        action: 'info',
        details: `compaction observed (messageCount=${event.messageCount}, compactedCount=${event.compactedCount}); content-diff memory-loss detection unavailable from event — needs sessionFile parsing`,
        timestamp: Date.now(),
      });
    });

    // session_end — output regeneration summary and cleanup session state
    api.on('session_end', (event, ctx) => {
      const sessionKey = resolveSessionKey(ctx, event);
      if (!sessionKey) return;
      const state = _sessionStates.get(sessionKey);
      if (state && state.regenerateHistory.length > 0) {
        const summary = courseCorrector.buildRegenerationSummary(state);
        if (summary) {
          auditLog.record({
            sessionId: sessionKey,
            type: 'force_regenerate',
            action: 'info',
            details: summary,
            timestamp: Date.now(),
          });
          api.logger.info(`[Supervisor] Session ${sessionKey} regeneration summary: ${state.regenerateAttempts} attempt(s)`);
        }
      }
      _sessionStates.delete(sessionKey);
    });

    _hooksDone = true;
    } // end _hooksDone guard

    api.logger.info('Dual Model Supervisor registered (10 hooks + 6 RPC methods)');
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

/**
 * TEST-ONLY, read-only accessor for deterministic test synchronization — lets a
 * harness poll whether a session's channel footer has been cached by the async
 * `llm_output` review (a real state condition, not a fixed sleep). Never called
 * in production; performs no mutation.
 */
export function __peekSessionChannelFooter(sessionKey: string): string | undefined {
  return _sessionStates.get(sessionKey)?.pendingChannelReviewFooter;
}

export default plugin;
