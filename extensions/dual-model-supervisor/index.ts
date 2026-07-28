/**
 * Dual Model Supervisor — Plugin Entry Point
 *
 * Registers 7 hooks + 10 RPC methods for dual-model supervision:
 *   - Safety gate (before_tool_call)
 *   - Course correction (llm_output → session analysis, before_prompt_build, llm_input)
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
import { parseConfig, isSupervisorActive, isCourseCorrectionActive } from './src/core/config.js';
import {
  ReviewerClient,
  describeEmptyReviewerResponseForUser,
  describeReviewerUnavailableForUser,
} from './src/client/reviewer.js';
import { QuickChecker } from './src/hooks/quick-checker.js';
import { OutputReviewer } from './src/hooks/output-reviewer.js';
import { ToolReviewer } from './src/hooks/tool-reviewer.js';
import { CourseCorrector } from './src/hooks/course-corrector.js';
import { ConsistencyChecker } from './src/hooks/consistency-checker.js';
import { GoalParser } from './src/hooks/goal-parser.js';
import { SummaryExtractor } from './src/hooks/summary-extractor.js';
import { GroundingChecker } from './src/hooks/grounding-checker.js';
import { ReviewStore, aggregateReview } from './src/core/review-store.js';
import { AuditLogService } from './src/core/audit-log.js';
import { registerSupervisorRpc } from './src/rpc.js';
import { hookSessionKey } from './src/oc/hook-types.js';
import type { PluginHookLlmOutputEvent, PluginHookLlmInputEvent } from './src/oc/hook-types.js';
import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';

// ── Module-level state (survives multiple register() calls) ──────────
let _initialized = false;
let _db: Database.Database | null = null;
let _auditLog: AuditLogService | null = null;
let _reviewerClient: ReviewerClient | null = null;
let _quickChecker: QuickChecker | null = null;
let _outputReviewer: OutputReviewer | null = null;
let _toolReviewer: ToolReviewer | null = null;
let _courseCorrector: CourseCorrector | null = null;
let _consistencyChecker: ConsistencyChecker | null = null;
let _goalParser: GoalParser | null = null;
let _summaryExtractor: SummaryExtractor | null = null;
let _groundingChecker: GroundingChecker | null = null;
let _reviewStore: ReviewStore | null = null;
let _activeConfig: SupervisorConfig | null = null;

interface SharedRuntimeConfigState {
  current: SupervisorConfig | null;
  broadcast: ((event: string, payload: unknown) => void) | null;
}

const RUNTIME_CONFIG_KEY = Symbol.for('research-claw.dual-model-supervisor.runtime-config.v1');
const runtimeGlobal = globalThis as typeof globalThis & {
  [RUNTIME_CONFIG_KEY]?: SharedRuntimeConfigState;
};
const _sharedRuntimeConfig = runtimeGlobal[RUNTIME_CONFIG_KEY] ?? {
  current: null,
  broadcast: null,
};
runtimeGlobal[RUNTIME_CONFIG_KEY] = _sharedRuntimeConfig;

interface SharedReviewerHealthState {
  byDatabasePath: Record<string, string>;
}

const REVIEWER_HEALTH_KEY = Symbol.for(
  'research-claw.dual-model-supervisor.reviewer-health.v1',
);
const reviewerHealthGlobal = globalThis as typeof globalThis & {
  [REVIEWER_HEALTH_KEY]?: SharedReviewerHealthState;
};
const _sharedReviewerHealth = reviewerHealthGlobal[REVIEWER_HEALTH_KEY] ?? {
  byDatabasePath: {},
};
reviewerHealthGlobal[REVIEWER_HEALTH_KEY] = _sharedReviewerHealth;

const _sessionStates = new Map<string, SessionState>();
/** Hook registration is scoped to the host PluginApi/registry instance.
 *  An in-process gateway restart can reuse this evaluated module with a fresh
 *  registry, which must receive its own complete hook set. */
const _hookRegistrationApis = new WeakSet<object>();
/** Fresh SessionState value (not stored). Used for both tracked sessions and
 *  ephemeral manual-review runs (which must NOT enter the session map). */
function newSessionState(sessionId: string): SessionState {
  return {
    sessionId,
    targetConclusions: [],
    goalConfirmed: false,
    keyConclusions: [],
    userPreferences: [],
    methodologyDecisions: [],
    recentOutputs: [],
    recentSummaries: [],
    regenerateAttempts: 0,
    regenerateHistory: [],
    lastReviewReport: undefined,
  };
}

/**
 * Report reviewer-model availability once per distinct state. Every state is logged;
 * only the UNAVAILABLE state also writes an audit row (a working reviewer is not an
 * event worth persisting). `rc.supervisor.status` exposes the same readiness object,
 * so the reported reason cannot drift from the reason a call actually fails.
 *
 * An unusable reviewer degrades DEEP review ONLY — the deterministic safety gate
 * (quick check + dangerousToolPolicy) has no model dependency and keeps running.
 * Saying that out loud is the point: the failure mode being fixed here is a
 * supervisor that turned itself off without telling anyone.
 */
function reportReviewerHealth(
  client: ReviewerClient,
  auditLog: AuditLogService,
  logger: PluginApi['logger'],
  cfg: SupervisorConfig,
  databasePath: string,
): void {
  const r = client.getReadiness();
  const key = `${cfg.enabled}|${cfg.reviewMode}|${r.ready}|${r.modelSource}|${r.effectiveModel}|${r.reason ?? ''}`;
  if (_sharedReviewerHealth.byDatabasePath[databasePath] === key) return;
  _sharedReviewerHealth.byDatabasePath[databasePath] = key;

  if (!isSupervisorActive(cfg)) {
    logger.info(`[Supervisor] supervision OFF (enabled=${cfg.enabled}, mode=${cfg.reviewMode})`);
    return;
  }

  if (r.ready) {
    const inherited = r.modelSource === 'inherited';
    logger.info(
      `[Supervisor] reviewer model ready: ${r.effectiveModel} (${r.modelSource}${inherited ? ' — deep review spends extra main-model tokens' : ''})`,
    );
    return;
  }

  const details = r.reason === 'reviewer runtime returned empty content'
    ? describeEmptyReviewerResponseForUser()
    : describeReviewerUnavailableForUser();
  logger.warn(`[Supervisor] ${details}`);
  auditLog.record({
    sessionId: 'supervisor',
    type: 'reviewer_health',
    action: 'warn',
    details,
    timestamp: Date.now(),
  });
}

/** Monotonic id for ephemeral manual reviews within this process. Namespaced by the
 *  persisted boot epoch so a per-process counter cannot collide across restarts. */
let _manualReviewSeq = 0;
/** Persisted, restart-monotonic epoch — namespaces reviewIds so restarts don't collide. */
let _bootEpoch = 0;

/**
 * OpenClaw can evaluate this plugin more than once in one process: one module
 * instance may own the serving hooks while another owns the gateway RPC handler.
 * Keep only the current config shared; every module retains and updates its own
 * service objects, DB handle and session map.
 */
function applyLocalRuntimeConfig(config: SupervisorConfig): void {
  if (_activeConfig === config) return;
  _activeConfig = config;
  _reviewerClient?.updateSupervisorConfig(config);
  _outputReviewer?.updateConfig(config);
  _toolReviewer?.updateConfig(config);
  _courseCorrector?.updateConfig(config);
  _consistencyChecker?.updateConfig(config);
  _goalParser?.updateConfig(config);
  _summaryExtractor?.updateConfig(config);
  _groundingChecker?.updateConfig(config);
}

function publishRuntimeConfig(config: SupervisorConfig): void {
  _sharedRuntimeConfig.current = config;
  applyLocalRuntimeConfig(config);
}

function currentRuntimeConfig(fallback: SupervisorConfig): SupervisorConfig {
  const config = _sharedRuntimeConfig.current ?? fallback;
  applyLocalRuntimeConfig(config);
  return config;
}

function getOrCreateSession(sessionId: string): SessionState {
  let state = _sessionStates.get(sessionId);
  if (!state) {
    state = newSessionState(sessionId);
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
export function extractLlmOutputText(event: PluginHookLlmOutputEvent): string | undefined {
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
 * used where a session must not be guessed.
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
  description: 'Dual-model supervision: course correction, safety filtering, and persistent audit',
  version: '0.2.0',

  register(api: PluginApi) {
    const cfg = parseConfig(api.pluginConfig as Record<string, unknown> | undefined);
    publishRuntimeConfig(cfg);

    const globalCfg = api.config;
    const mergedProviders = _extractProviders(api.pluginConfig as Record<string, unknown> | undefined, globalCfg);

    // Extract main model reference for fallback when supervisorModel is empty
    const mainModel = (globalCfg?.agents as Record<string, unknown>)?.defaults as Record<string, unknown>;
    const mainModelPrimary = (mainModel?.model as Record<string, unknown>)?.primary;
    const fallbackModel = typeof mainModelPrimary === 'string' ? mainModelPrimary : '';
    const supervisorDbPath = resolveSupervisorDbPath(
      api.pluginConfig as Record<string, unknown> | undefined,
    );

    api.logger.info(`Dual Model Supervisor initializing (enabled=${cfg.enabled}, mode=${cfg.reviewMode})`);

    // No gate-range warning here on purpose: OpenClaw validates plugins.entries[*].config
    // against the manifest's configSchema before the plugin loads, so on any OpenClaw-loaded
    // path api.pluginConfig cannot carry an out-of-range toolReviewGateMs — cold start, config
    // reload and runtime plugin reload all reject the file instead (the two createApi call
    // sites pass either {} or the loader-validated value). A warning here would be dead code
    // on every one of those paths; a non-OpenClaw host, such as this plugin's own test
    // harness, can still construct one, which is where the clamp is actually exercised.
    // The RPC write path is the one that bypasses OpenClaw; it warns in rpc.ts.

    if (!_initialized) {
      try {
        fs.mkdirSync(path.dirname(supervisorDbPath), { recursive: true });
        _db = new Database(supervisorDbPath);
        _db.pragma('journal_mode = WAL');
        _db.pragma('synchronous = FULL');
      } catch (dbErr) {
        api.logger.warn(`Supervisor DB init failed (audit logging disabled): ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
        _db = null;
      }

      _auditLog = new AuditLogService(_db, api.logger, (entry) => {
        _sharedRuntimeConfig.broadcast?.('plugin.supervisor.review.updated', {
          sessionId: entry.sessionId,
          type: entry.type,
          action: entry.action,
          timestamp: entry.timestamp,
          persisted: true,
        });
      });

      _reviewerClient = new ReviewerClient({
        supervisorConfig: cfg,
        providers: mergedProviders,
        logger: api.logger,
        fallbackModel,
        runtimeComplete: api.runtime.llm?.complete,
        onReadinessChanged: () => {
          if (!_reviewerClient || !_auditLog) return;
          reportReviewerHealth(
            _reviewerClient,
            _auditLog,
            api.logger,
            currentRuntimeConfig(cfg),
            supervisorDbPath,
          );
        },
      });

      _quickChecker = new QuickChecker(cfg, api.logger);
      _outputReviewer = new OutputReviewer(cfg, api.logger, _reviewerClient, _quickChecker, _auditLog);
      _toolReviewer = new ToolReviewer(cfg, api.logger, _reviewerClient, _quickChecker, _auditLog);
      _courseCorrector = new CourseCorrector(cfg, api.logger, _reviewerClient, _auditLog);
      _consistencyChecker = new ConsistencyChecker(cfg, api.logger, _reviewerClient, _auditLog);
      _goalParser = new GoalParser(cfg, api.logger, _reviewerClient, _auditLog);
      _summaryExtractor = new SummaryExtractor(cfg, api.logger, _reviewerClient, _auditLog);
      _groundingChecker = new GroundingChecker(cfg, api.logger, _auditLog);
      _reviewStore = new ReviewStore(_db, api.logger);
      // Restart-stable identity + orphan recovery: bump a PERSISTED epoch (so a
      // per-process manual counter cannot collide across restarts) and reclaim any
      // 'started' review left behind by a prior crash (→ 'timedout').
      _bootEpoch = _reviewStore.allocateBootEpoch();
      // Only sweep reviews older than well beyond the max review duration (grounding
      // timeout ~20s), so a restart overlapping an in-flight review never nukes a live one.
      const sweptOrphans = _reviewStore.sweepOrphans(Date.now(), { olderThanMs: 60_000 });
      if (sweptOrphans > 0) api.logger.warn(`[Supervisor] recovered ${sweptOrphans} orphaned 'started' review(s) → timedout`);

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
      _reviewerClient!.updateSupervisorConfig(currentRuntimeConfig(cfg));
      _reviewerClient!.updateFallbackModel(fallbackModel);
    }

    const reviewerClient = _reviewerClient!;
    const auditLog = _auditLog!;
    const outputReviewer = _outputReviewer!;
    const toolReviewer = _toolReviewer!;
    const courseCorrector = _courseCorrector!;
    const consistencyChecker = _consistencyChecker!;
    const goalParser = _goalParser!;
    const summaryExtractor = _summaryExtractor!;
    const groundingChecker = _groundingChecker!;
    const reviewStore = _reviewStore!;

    // Reviewer-model availability is reported now (and again on every config change),
    // never inferred from silence.
    reportReviewerHealth(
      reviewerClient,
      auditLog,
      api.logger,
      currentRuntimeConfig(cfg),
      supervisorDbPath,
    );

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
      api.registerGatewayMethod(method, async (opts: GatewayRequestHandlerOptions) => {
        _sharedRuntimeConfig.broadcast = opts.context.broadcast;
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
    const persistConfig = async (newCfg: SupervisorConfig): Promise<void> => {
      const result = await api.runtime.config.mutateConfigFile({
        afterWrite: { mode: 'auto' },
        mutate: (ocConfig) => {
          const plugins = (
            ocConfig.plugins && typeof ocConfig.plugins === 'object'
              ? ocConfig.plugins
              : {}
          ) as Record<string, unknown>;
          const entries = (
            plugins.entries && typeof plugins.entries === 'object'
              ? plugins.entries
              : {}
          ) as Record<string, unknown>;
          const pluginEntry = (
            entries['dual-model-supervisor']
            && typeof entries['dual-model-supervisor'] === 'object'
              ? entries['dual-model-supervisor']
              : {}
          ) as Record<string, unknown>;
          const existing = (
            pluginEntry.config && typeof pluginEntry.config === 'object'
              ? pluginEntry.config
              : {}
          ) as Record<string, unknown>;
          const {
            memoryGuard: _withdrawnMemoryGuard,
            appendReviewToChannelOutput: _withdrawnFooter,
            ...supportedExisting
          } = existing;

          pluginEntry.config = {
            ...supportedExisting, // preserve dbPath and other infrastructure keys
            enabled: newCfg.enabled,
            supervisorModel: newCfg.supervisorModel,
            reviewMode: newCfg.reviewMode,
            courseCorrection: newCfg.courseCorrection,
            highRiskTools: newCfg.highRiskTools,
            dangerousToolPolicy: newCfg.dangerousToolPolicy,
            toolReviewGateMs: newCfg.toolReviewGateMs,
            grounding: newCfg.grounding,
          };
          entries['dual-model-supervisor'] = pluginEntry;
          plugins.entries = entries;
          ocConfig.plugins = plugins;
        },
      });
      api.logger.info(`Supervisor config persisted: ${result.path}`);
    };

    registerSupervisorRpc(
      registerMethod,
      auditLog,
      () => currentRuntimeConfig(cfg),
      (newCfg: SupervisorConfig) => {
        publishRuntimeConfig(newCfg);
        reportReviewerHealth(
          reviewerClient,
          auditLog,
          api.logger,
          newCfg,
          supervisorDbPath,
        );
      },
      api.logger,
      () => _sessionStates,
      () => _extractConfiguredProviders(api.pluginConfig as Record<string, unknown> | undefined, globalCfg),
      persistConfig,
      () => reviewStore.isAvailable(),
      () => reviewerClient.getReadiness(),
    );

    // rc.supervisor.review — manual grounding check for arbitrary inline text.
    // Runs on an EPHEMERAL session state (never entered into _sessionStates), so
    // repeated/concurrent manual reviews do not accumulate sessions and cannot
    // delete a real session. Respects the grounding networkPolicy (off →
    // unverifiable/local-only). messageRef/workspacePath are reserved (explicit
    // unsupported error, never a silent no-op).
    registerMethod('rc.supervisor.review', async (params) => {
      const target = (params as { target?: unknown }).target;
      const inlineText =
        target && typeof target === 'object' && typeof (target as { inlineText?: unknown }).inlineText === 'string'
          ? (target as { inlineText: string }).inlineText
          : null;
      if (inlineText === null) {
        return { ok: false, error: 'unsupported target: only { inlineText } is supported in this version' };
      }
      // Epoch-namespaced id: `manual:e<epoch>:<seq>` cannot collide across restarts.
      const reviewId = `manual:e${_bootEpoch}:${++_manualReviewSeq}`;
      const beginRes = reviewStore.begin(reviewId, { sessionKey: reviewId, runId: null, kind: 'manual' }, Date.now());
      const ephemeral = newSessionState(reviewId); // NOT stored in _sessionStates
      try {
        const findings = await groundingChecker.runCheck(inlineText, reviewId, [], ephemeral);
        const agg = aggregateReview(findings);
        const finRes = reviewStore.finalize(reviewId, agg.state, { sessionKey: reviewId, runId: null, kind: 'manual', verdict: agg.verdict, findings }, Date.now());
        // `ok` reflects that the CHECK ran (findings are real + returned inline).
        // `persisted` tells the caller whether reviews.get(reviewId) will succeed later —
        // so a DB-unavailable run cannot be mistaken for durable.
        const persisted = beginRes.ok && finRes.ok;
        // Distinguish "no DB" from a transient write error: dbUnavailable is TRUE only
        // when a persistence step actually reported db_unavailable (not merely !isAvailable).
        const dbUnavailable =
          (!beginRes.ok && beginRes.reason === 'db_unavailable') ||
          (!finRes.ok && finRes.reason === 'db_unavailable');
        return { ok: true, reviewId, verdict: agg.verdict, findings, persisted, dbUnavailable };
      } catch (err) {
        // Guarantee terminalization (no dangling `started`), symmetric with the
        // auto path's .catch — independent of runCheck's internal error handling.
        reviewStore.finalize(reviewId, 'failed', { sessionKey: reviewId, runId: null, kind: 'manual', verdict: 'none', findings: [] }, Date.now());
        throw err;
      }
    });

    // rc.supervisor.reviews.* — persisted review recovery (snapshot / replay).
    // The DB is the truth source; these let a dashboard recover state after being
    // offline or reconnecting, independent of any broadcast notification.
    registerMethod('rc.supervisor.reviews.list', async (params) => {
      const p = params as { sessionKey?: string; runId?: string; sinceRevision?: number; limit?: number; offset?: number };
      return reviewStore.list(p);
    });
    registerMethod('rc.supervisor.reviews.get', async (params) => {
      const id = (params as { reviewId?: unknown }).reviewId;
      return { review: typeof id === 'string' ? reviewStore.get(id) : null };
    });

    // ── Register hooks once per host PluginApi/registry instance ──

    const hookRegistrationKey: object = api;
    if (!_hookRegistrationApis.has(hookRegistrationKey)) {

    // before_prompt_build — inject supervisor rules + corrections + lost memory + research goal.
    // ctx (PluginHookAgentContext) carries the canonical sessionKey; no global fallback.
    api.on('before_prompt_build', (_event, ctx) => {
      const activeCfg = currentRuntimeConfig(cfg);
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
      const activeCfg = currentRuntimeConfig(cfg);
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
      const activeCfg = currentRuntimeConfig(cfg);
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

    // llm_output — record raw output, extract structured summary, run course correction,
    // and run the async output review (audit + Dashboard panel only; never modifies output).
    api.on('llm_output', (event, ctx) => {
      const activeCfg = currentRuntimeConfig(cfg);
      if (!isSupervisorActive(activeCfg)) {
        return;
      }

      const outputText = extractLlmOutputText(event);
      const sessionKey = resolveSessionKey(ctx, event);

      if (!sessionKey || !outputText) {
        return;
      }

      try {
        const state = getOrCreateSession(sessionKey);
        state.lastLlmOutput = outputText;
        summaryExtractor.extractSummary(outputText, sessionKey, state);
        // Grounding: verify cited papers exist (fire-and-forget, never-block).
        // No-ops unless the operator opted into a network policy (default 'off').
        // The review lifecycle is PERSISTED (started → terminal) keyed by the
        // per-turn runId, so a dashboard can recover it later via RPC even if it
        // was offline — broadcast is only a notification, not the truth source.
        if (activeCfg.grounding.networkPolicy !== 'off') {
          const priorRefs = state.recentSummaries.flatMap((s) => s.references ?? []);
          const runId = event.runId;
          const reviewId = `auto:e${_bootEpoch}:${sessionKey}:${runId}`;
          reviewStore.begin(reviewId, { sessionKey, runId, kind: 'auto' }, Date.now());
          groundingChecker
            .runCheck(outputText, sessionKey, priorRefs, state)
            .then((findings) => {
              const agg = aggregateReview(findings);
              reviewStore.finalize(reviewId, agg.state, { sessionKey, runId, kind: 'auto', verdict: agg.verdict, findings }, Date.now());
            })
            .catch((err) => {
              reviewStore.finalize(reviewId, 'failed', { sessionKey, runId, kind: 'auto', verdict: 'none', findings: [] }, Date.now());
              api.logger.error(`[Supervisor] grounding review failed: ${err instanceof Error ? err.message : String(err)}`);
            });
        }
        if (isCourseCorrectionActive(activeCfg)) {
          courseCorrector.analyzeSession(sessionKey, state);
        }

        // Output review runs asynchronously (fire-and-forget, never-block) and ONLY
        // records an audit entry + the Dashboard panel report. It NEVER modifies or
        // blocks the outbound message: OC fires llm_output fire-and-forget and the
        // message is delivered before this resolves, so the review result is delivered
        // via the audit / panel / RPC path (the truth source), not appended to output.
        void outputReviewer.reviewOutput(outputText, sessionKey, state).catch((err) => {
          api.logger.error(`[Supervisor] llm_output async review failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      } catch (err) {
        api.logger.error(`[Supervisor] llm_output error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // before_message_write — synchronously prepare session state for the review
    // that will be completed asynchronously by the llm_output hook.
    // NOTE: The gateway treats this hook as SYNCHRONOUS — returning a Promise
    // (via `async`) causes the result to be silently ignored. All actual review
    // logic lives in `llm_output` which correctly supports async handlers.
    api.on('before_message_write', (_event, ctx) => {
      const activeCfg = currentRuntimeConfig(cfg);
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
      const activeCfg = currentRuntimeConfig(cfg);
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
      if (result.requireApproval) {
        // dangerousToolPolicy:'approve' — hand OC the human-in-the-loop request.
        return { requireApproval: result.requireApproval };
      }
      if (result.params) {
        return { params: result.params };
      }

      return {};
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

    _hookRegistrationApis.add(hookRegistrationKey);
    } // end per-PluginApi hook-registration guard

    api.logger.info('Dual Model Supervisor registered (7 hooks + 10 RPC methods)');
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
