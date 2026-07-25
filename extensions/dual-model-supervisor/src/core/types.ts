/**
 * Dual Model Supervisor — Core Type Definitions
 */

import type { PluginHookHandlerMap } from '../oc/hook-types.js';

// ── Configuration ──────────────────────────────────────────────────────

export interface MemoryGuardConfig {
  enabled: boolean;            // Whether memory guard is active
  keyCategories: string[];     // Categories of memory to protect (e.g., 'research_goal', 'key_conclusion')
}

export interface CourseCorrectionConfig {
  enabled: boolean;            // Whether course correction is active
  deviationThreshold: number;  // 0-1 threshold to trigger correction (0.5 = 50% deviation)
  forceRegenerate: boolean;    // Whether to force regeneration when deviation detected
  maxRegenerateAttempts: number; // Max regeneration attempts per session (default: 3)
}

/** Deterministic existence verdict for one extracted citation. */
export type GroundingVerdict = 'exists' | 'not_found' | 'unverifiable';

/** A cached grounding result for one citation. */
export interface GroundingFinding {
  raw: string;                 // Raw citation token (DOI / arXiv id / title)
  verdict: GroundingVerdict;
  via?: string;                // Which registry confirmed existence (openalex_doi, etc.) or 'local-only'
  /**
   * Per-registry outcome tokens ONLY (e.g. { openalex_doi: 'hit', crossref_doi: 'miss' }
   * or 'err:<code>'). NEVER the HTTP response body — just hit/miss/err so a persisted
   * finding is auditable without leaking content. Empty object when networkPolicy='off'.
   */
  sources?: Record<string, string>;
  /** Normalized identity of the citation (no response body) for dashboard/dedup. */
  identity?: { doi?: string; arxivId?: string; normTitle?: string };
}

export interface GroundingConfig {
  /**
   * Privacy switch for citation existence checking. Controls what (if anything)
   * is sent to external registries (OpenAlex / CrossRef / arXiv).
   *  - 'off'              : DEFAULT. Zero external requests; no automatic grounding.
   *                         Manual checks return `unverifiable` (local-only).
   *  - 'identifiers-only' : send only public identifiers (DOI / arXiv id). NEVER titles/text.
   *  - 'full'             : additionally allow title-search lookups (may reveal unpublished titles).
   */
  networkPolicy: 'off' | 'identifiers-only' | 'full';
  /**
   * How to report a citation no registry can find.
   *  - 'flag' : emit `not_found` (suspected fabrication) — default.
   *  - 'info' : soften `not_found` → `unverifiable` (never assert fabrication).
   */
  verdictMode: 'flag' | 'info';
}

export interface SupervisorConfig {
  enabled: boolean;                    // Whether supervisor is active
  supervisorModel: string;             // "provider/model" e.g. "openai/gpt-4o-mini"
  reviewMode: 'off' | 'filter-only' | 'correct' | 'full';  // Review depth level
  memoryGuard: MemoryGuardConfig;      // Memory protection settings
  courseCorrection: CourseCorrectionConfig;  // Course correction settings
  highRiskTools: string[];             // Tool names that require extra review
  /**
   * What to do with a confirmed-dangerous tool call:
   *  - 'block'   : hard block (agent gets a tool error). Default — unchanged behavior.
   *  - 'approve' : pause and ask the user (before_tool_call → requireApproval →
   *                OC's native approval flow). The tool runs only if allowed.
   */
  dangerousToolPolicy: 'block' | 'approve';
  /**
   * Max time (ms) the before_tool_call security gate waits for the deep reviewer on
   * a high-risk-but-not-determined-danger tool before failing OPEN. Bounds the wait
   * so a slow/queued reviewer never stalls tool execution (never-over-block). The
   * deep review still runs (and can block within this window); on timeout the tool
   * is allowed and an observable degrade is recorded. Default 10s.
   */
  toolReviewGateMs: number;
  /** Citation existence checking (grounding) — privacy-gated, best-effort, never-block. */
  grounding: GroundingConfig;
}

export const DEFAULT_CONFIG: SupervisorConfig = {
  enabled: false,
  supervisorModel: '',
  reviewMode: 'off',
  memoryGuard: {
    enabled: true,
    keyCategories: ['research_goal', 'key_conclusion', 'user_preference', 'methodology_decision'],
  },
  courseCorrection: {
    enabled: true,
    deviationThreshold: 0.5,
    forceRegenerate: false,
    maxRegenerateAttempts: 3,
  },
  highRiskTools: ['exec', 'write', 'edit', 'send_notification', 'browser'],
  dangerousToolPolicy: 'block',
  // How long a high-risk tool call waits for the deep review before proceeding. Every
  // high-risk tool pays this in the worst case, so it is tuned for interactive use, not
  // for review completeness: on timeout the deep pass is skipped (fail-open, audited)
  // while the deterministic danger rules — which need no model — still block instantly.
  toolReviewGateMs: 4000,
  grounding: {
    networkPolicy: 'off',   // zero external requests by default (privacy)
    verdictMode: 'flag',
  },
};

// ── Review Results ─────────────────────────────────────────────────────

/**
 * Verdict of an output review (llm_output). Every field is ADVISORY: the reviewed
 * message was already delivered, so nothing here withholds or rewrites it. The field
 * names say so deliberately — `blocked`/`corrected` would assert an enforcement this
 * path does not have (that belongs to `ToolReviewResult`, below).
 */
export interface ReviewResult {
  flagged: boolean;               // Reviewer flagged a serious violation (advisory — output already delivered)
  hasSuggestion: boolean;         // Reviewer supplied an improved version (never applied)
  suggestedVersion?: string;      // The improved output the reviewer would have written
  suggestionNote?: string;        // Explanation of what the reviewer would change
  warnings: string[];             // Safety or quality warnings
  memoryAlerts: string[];         // Alerts about memory inconsistencies or loss
  deviationScore: number;         // 0-1, how much the output deviates from expected trajectory
  qualityScore: number;           // 0-1, overall quality assessment
  reportText?: string;            // Natural-language review report from the supervisor model
}

export interface ToolReviewResult {
  blocked: boolean;               // Whether the tool call was blocked
  blockReason?: string;           // Reason for blocking (if blocked)
  correctedParams?: Record<string, unknown>;  // Corrected parameters (if correction applied)
  warnings: string[];             // Warnings about tool usage
}

export interface ConsistencyCheckResult {
  hasIssue: boolean;              // Whether inconsistency was detected
  correction?: string;            // Suggested correction for inconsistency
  details: string[];              // Detailed descriptions of inconsistencies
}

export interface MemoryLossItem {
  category: string;               // Category of lost memory (e.g., 'research_goal')
  content: string;                // The actual content that was lost
  importance: 'critical' | 'high' | 'medium';  // Importance level of lost memory
}

export interface MemoryItem {
  category: string;               // Memory category for organization
  summary: string;                // Concise summary of the memory
  source: string;                 // Source of the memory (e.g., message_id, tool_call_id)
  timestamp: number;              // When the memory was created/recorded
}

// ── Audit Log ──────────────────────────────────────────────────────────

export type AuditLogType =
  | 'tool_review'         // Review of tool calls
  | 'output_review'       // Review of model outputs
  | 'consistency_check'   // Check for reasoning consistency
  | 'memory_guard'        // Memory protection actions
  | 'course_correction'   // Course correction interventions
  | 'force_regenerate'    // Force regeneration on deviation
  | 'approval'            // Human-in-the-loop approval lifecycle (requested → allowed/denied/timeout/cancelled)
  | 'grounding'           // Citation existence check (exists / not_found / unverifiable)
  | 'session_analysis'    // End-of-session analysis
  | 'reviewer_health';    // Reviewer model availability at startup / config change (deep review degraded)

export interface AuditLogEntry {
  id?: number;                    // Database primary key (auto-increment)
  sessionId: string;              // Unique identifier for the conversation session
  type: AuditLogType;             // Category of audit event
  action: 'pass' | 'block' | 'correct' | 'warn' | 'info';  // Outcome of the review
  details: string;                // Human-readable description of the event
  metadata?: string;              // JSON string with additional structured data
  timestamp: number;              // Unix timestamp in milliseconds
}

// ── Session State ──────────────────────────────────────────────────────

export interface MessageSummary {
  claims: string[];                // Key claims or assertions made in this message
  decisions: string[];             // Decisions or conclusions reached
  references: string[];            // External references cited (papers, URLs, etc.)
  conditions: string[];            // Preconditions, assumptions, or caveats for claims/decisions
  reasoning: string[];             // Key reasoning steps or logical chains that led to conclusions
  limitations: string[];           // Limitations, edge cases, or known gaps acknowledged
  negations: string[];             // Explicit exclusions, disclaimers, or things ruled out
  nextSteps: string[];             // Planned next actions, open questions, or future work items
}

export interface TaskParsingResult {
  researchGoal: string;            // Parsed research goal from user's initial message
  targetConclusions: string[];     // Expected conclusions or outcomes to achieve
  methodology?: string;            // Suggested methodology or approach
}

export interface RegenerateHistoryEntry {
  attempt: number;                 // Which course correction (1, 2, 3, ...)
  timestamp: number;               // When the correction was queued
  deviationScore: number;          // The deviation score that triggered the correction
  originalOutputPreview: string;   // First 200 chars of the drifted output
  correctionInstruction: string;   // The correction instruction that was injected
  // The ONLY observable outcome. The drifted output was already delivered, and whether the
  // model then honored the queued correction is never measured — so 'corrected' is not a
  // state this plugin can truthfully record.
  result: 'correction_queued';
}

export interface SessionState {
  sessionId: string;               // Unique identifier for the conversation
  researchGoal?: string;           // The main research goal identified for this session
  targetConclusions: string[];     // Expected conclusions/outcomes to achieve (P2)
  methodology?: string;            // Planned methodology or approach
  goalConfirmed: boolean;          // Whether the reviewer model has confirmed the goal
  keyConclusions: string[];        // Important conclusions reached during research
  userPreferences: string[];       // User preferences or constraints noted
  methodologyDecisions: string[];  // Decisions about research methodology
  recentOutputs: string[];         // Recent model outputs (for consistency checking)
  recentSummaries: MessageSummary[];  // Structured summaries of recent messages (P1)
  lastLlmOutput?: string;          // The most recent raw LLM output (before correction)
  pendingCourseCorrection?: string;  // Course correction pending injection in next prompt
  pendingForceRegenerate?: {       // Force regeneration pending injection
    deviationScore: number;
    correctionInstruction: string;
    originalOutputPreview: string;
  };
  regenerateAttempts: number;      // Number of regeneration attempts in this session
  regenerateHistory: RegenerateHistoryEntry[];  // History of regeneration attempts
  lostMemorySummary?: string;      // Summary of memories lost during conversation compression
  preCompactionMemory: MemoryItem[];  // Memory snapshots before conversation compaction
  lastReviewReport?: string;       // Most recent review report text (for Dashboard panel display)
  lastStaticSupervisorInjectAt?: number;  // Per-session debounce for static rules injection
  groundingFindings?: GroundingFinding[]; // Cached citation existence results (deduped by raw)
}

// ── models.providers.* (aligned with Dashboard GatewayModelDef / openclaw.json) ──

/** API protocols the dual-model reviewer client implements (non-streaming completion). */
export const SUPPORTED_REVIEWER_APIS = ['openai-completions', 'anthropic-messages'] as const;
export type SupportedReviewerApi = (typeof SUPPORTED_REVIEWER_APIS)[number];

/**
 * Where the reviewer model comes from:
 *  - 'explicit'    — `supervisorModel` is configured;
 *  - 'inherited'   — `supervisorModel` is empty, so the MAIN model is used (deep review
 *                    therefore spends extra main-model tokens);
 *  - 'unavailable' — no usable reviewer model; deep review is degraded while the
 *                    deterministic safety gate keeps running.
 */
export type ReviewerModelSource = 'explicit' | 'inherited' | 'unavailable';

/** Reviewer-model readiness — one truth source for status/audit/logs. */
export interface ReviewerReadiness {
  /**
   * Whether a deep-review call can be ATTEMPTED: the model reference resolves, its
   * provider exists, the protocol is supported and credentials are present. This is a
   * static config check, not a liveness probe — the endpoint can still reject the call
   * (that failure is logged per call and fails open).
   */
  ready: boolean;
  modelSource: ReviewerModelSource;
  /** `supervisorModel || mainModel`, re-resolved on every config/provider/main-model change; '' when neither is set. */
  effectiveModel: string;
  /** Why deep review cannot run. Present iff `ready` is false. */
  reason?: string;
}

/** One element of `models.providers.*.models[]` — same fields as main-model catalog. */
export interface ModelsProviderModelDef {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * One entry in `config.models.providers` (same shape as the main model stack).
 * Reviewer resolves `supervisorModel` → this entry + matching `models[]` row.
 */
export interface ModelsProviderEntry {
  /** HTTP POST URL for this provider as stored in config (reviewer uses it verbatim, aside from trimming trailing `/`). */
  baseUrl?: string;
  apiKey?: string;
  /** When used as reviewer model, must be `openai-completions` or `anthropic-messages` (see SUPPORTED_REVIEWER_APIS). */
  api?: SupportedReviewerApi | (string & {});
  models?: ModelsProviderModelDef[];
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

// ── Configured Provider (for RPC) ──────────────────────────────────────

export interface ConfiguredProvider {
  /** Provider key (e.g. 'moonshot-cn', 'minimax') */
  key: string;
  /** Display label */
  label: string;
  /** Whether an API key is configured */
  hasApiKey: boolean;
  /** Available models for this provider */
  models: Array<{ id: string; name: string }>;
  /** API base URL */
  baseUrl: string;
  /** API protocol (reviewer supports SUPPORTED_REVIEWER_APIS only) */
  api?: SupportedReviewerApi | (string & {});
}

// ── Plugin API Types ───────────────────────────────────────────────────

export interface PluginLogger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface PluginApi {
  id: string;
  name: string;
  config?: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  resolvePath: (input: string) => string;
  registerTool: (tool: unknown) => void;
  registerGatewayMethod: (method: string, handler: unknown) => void;
  registerHttpRoute: (params: {
    path: string;
    handler: (req: unknown, res: unknown) => Promise<boolean | void> | boolean | void;
    auth: 'gateway' | 'plugin';
    match?: 'exact' | 'prefix';
  }) => void;
  registerService: (service: {
    id: string;
    start: (ctx: { stateDir: string; logger: PluginLogger }) => void | Promise<void>;
    stop?: (ctx: { stateDir: string; logger: PluginLogger }) => void | Promise<void>;
  }) => void;
  /**
   * Register a hook handler. Typed by the REAL OpenClaw PluginHookHandlerMap so
   * that each handler's (event, ctx) and return type are inferred per hook name —
   * an OC contract change (renamed field, changed arg count) breaks compilation
   * here instead of silently degrading at runtime. This is the compile-time gate
   * the single-arg / wrong-field bug slipped through when `on` was untyped.
   */
  on: <K extends keyof PluginHookHandlerMap>(
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: { priority?: number },
  ) => void;
}

export interface PluginDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  register?: (api: PluginApi) => void | Promise<void>;
}

// ── RPC Types ──────────────────────────────────────────────────────────

export interface SupervisorStatus {
  enabled: boolean;        // Whether supervisor is currently active
  reviewMode: string;      // Current review mode (off/filter-only/correct/full)
  supervisorModel: string; // Currently configured supervisor model
  stats: {
    total: number;         // Total number of review operations performed
    // Both counters come from the audit `action` column, and only the before_tool_call
    // path can produce those actions — output review is advisory and always lands on
    // 'warn'/'pass'. So neither counter ever includes a delivered assistant message.
    blocked: number;       // Tool calls blocked (incl. denied approvals)
    corrected: number;     // Tool calls whose parameters were rewritten before execution
    warnings: number;      // Number of warnings issued
  };
}

export type RegisterMethod = (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => void;
