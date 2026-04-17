/**
 * Dual Model Supervisor — Core Type Definitions
 */

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

export interface SupervisorConfig {
  enabled: boolean;                    // Whether supervisor is active
  supervisorModel: string;             // "provider/model" e.g. "openai/gpt-4o-mini"
  reviewMode: 'off' | 'filter-only' | 'correct' | 'full';  // Review depth level
  /** Append review report to output only when message is delivered through an external channel (Telegram, WeChat, etc.). Dashboard users see review results in the Supervisor panel instead. */
  appendReviewToChannelOutput: boolean;
  memoryGuard: MemoryGuardConfig;      // Memory protection settings
  courseCorrection: CourseCorrectionConfig;  // Course correction settings
  highRiskTools: string[];             // Tool names that require extra review
}

export const DEFAULT_CONFIG: SupervisorConfig = {
  enabled: false,
  supervisorModel: '',
  reviewMode: 'off',
  appendReviewToChannelOutput: true,     // Only append review footer when delivering via external channel
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
};

// ── Review Results ─────────────────────────────────────────────────────

export interface ReviewResult {
  blocked: boolean;               // Whether the output was blocked entirely
  corrected: boolean;             // Whether correction was applied
  correctedVersion?: string;      // The corrected version of the output (if corrected)
  correctionNote?: string;        // Explanation of what was corrected
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
  | 'session_analysis';   // End-of-session analysis

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
  attempt: number;                 // Which regeneration attempt (1, 2, 3, ...)
  timestamp: number;               // When the regeneration was triggered
  deviationScore: number;          // The deviation score that triggered regeneration
  originalOutputPreview: string;   // First 200 chars of the deviated output
  correctionInstruction: string;   // The correction instruction that was injected
  result: 'regenerating' | 'corrected' | 'max_reached';  // Outcome of this attempt
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
  pendingReviewFooter?: string;    // Cached review footer from llm_output (deprecated: for backward compat)
  pendingChannelReviewFooter?: string; // Cached channel-only review footer, waiting to be attached in message_sending when delivering to external channel
  lastReviewReport?: string;       // Most recent review report text (for Dashboard panel display)
  needsRetroactivePatch?: boolean; // Flag: before_message_write fired before async review completed
  retroactiveOriginalMessage?: string; // Original message saved for retroactive patch
}

// ── models.providers.* (aligned with Dashboard GatewayModelDef / openclaw.json) ──

/** API protocols the dual-model reviewer client implements (non-streaming completion). */
export const SUPPORTED_REVIEWER_APIS = ['openai-completions', 'anthropic-messages'] as const;
export type SupportedReviewerApi = (typeof SUPPORTED_REVIEWER_APIS)[number];

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
  on: (hookName: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }) => void;
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
    blocked: number;       // Number of outputs/tools blocked
    corrected: number;     // Number of outputs/tools corrected
    warnings: number;      // Number of warnings issued
  };
}

export type RegisterMethod = (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => void;
