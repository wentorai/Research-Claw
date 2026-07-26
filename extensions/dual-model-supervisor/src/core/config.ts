/**
 * Dual Model Supervisor — Configuration Parser
 *
 * Parses raw pluginConfig from openclaw.json into a typed SupervisorConfig.
 */

import {
  type SupervisorConfig,
  DEFAULT_CONFIG,
  TOOL_REVIEW_GATE_MAX_MS,
  TOOL_REVIEW_GATE_MIN_MS,
} from './types.js';

/**
 * Parse raw pluginConfig (from openclaw.json) into a fully typed SupervisorConfig.
 * Missing or invalid fields fall back to DEFAULT_CONFIG values.
 */
export function parseConfig(raw: Record<string, unknown> | undefined): SupervisorConfig {
  if (!raw) return { ...DEFAULT_CONFIG };

  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_CONFIG.enabled,
    supervisorModel: typeof raw.supervisorModel === 'string' ? raw.supervisorModel : DEFAULT_CONFIG.supervisorModel,
    reviewMode: isValidReviewMode(raw.reviewMode) ? raw.reviewMode : DEFAULT_CONFIG.reviewMode,
    memoryGuard: parseMemoryGuard(raw.memoryGuard),
    courseCorrection: parseCourseCorrection(raw.courseCorrection),
    highRiskTools: parseStringArray(raw.highRiskTools, DEFAULT_CONFIG.highRiskTools),
    dangerousToolPolicy: raw.dangerousToolPolicy === 'approve' ? 'approve' : DEFAULT_CONFIG.dangerousToolPolicy,
    toolReviewGateMs: parseToolReviewGateMs(raw.toolReviewGateMs),
    grounding: parseGrounding(raw.grounding),
  };
}

/**
 * Parse `toolReviewGateMs`, clamping to the range the manifest declares.
 *
 * OpenClaw does enforce the manifest's `minimum`/`maximum` on the file, in two independent
 * places: config load validates every `plugins.entries[*].config` against the plugin's
 * configSchema and throws on a violation, and the plugin loader separately refuses to load
 * a plugin whose entry config fails that schema. A hand-edited openclaw.json therefore
 * never reaches this function with an out-of-range gate — the gateway refuses to start.
 *
 * What this closes is the plugin's own write path, which is subject to neither check.
 * `rc.supervisor.config` filters its params through an allowlist and hands them straight
 * to parseConfig; the result becomes the live gate via setActiveConfig and is written to
 * openclaw.json by persistConfig's bare fs.writeFileSync. Before this clamp a single RPC
 * call could both set the running gate to 999999999ms — every high-risk tool call waiting
 * ~11.6 days on the reviewer, since that value is still under setTimeout's 2^31-1 ceiling
 * and is not coerced down — and leave behind a config file that the next gateway start
 * would reject outright. Clamping here fixes both, because both effects flow through it.
 *
 * Every finite number is clamped, including 0 and negatives: the nearest legal gate is a
 * closer match to what was asked for than the default would be, and the substitution is
 * announced rather than silent (describeToolReviewGateOverride). Non-finite values take
 * the default instead — JSON cannot express NaN or Infinity, so they can only come from a
 * caller bug rather than an operator's intent, and NaN would survive Math.max/Math.min and
 * reach setTimeout, where Node coerces it to 1ms and the gate silently becomes ~0.
 */
function parseToolReviewGateMs(raw: unknown): number {
  const ms = finiteOr(raw, DEFAULT_CONFIG.toolReviewGateMs);
  return Math.round(Math.min(TOOL_REVIEW_GATE_MAX_MS, Math.max(TOOL_REVIEW_GATE_MIN_MS, ms)));
}

/**
 * Message to log when `raw`'s gate was overridden, or null when it was honoured.
 *
 * Clamping without saying so would swap one silent lie for another: the operator wrote
 * a number, a different one is in force, and until they reopen the Dashboard nothing
 * tells them. Callers own the logging so this stays a pure function; it returns null
 * for in-range and absent values so a legitimate setting never trains the warning away.
 *
 * The wrong-type and out-of-range cases get separate messages because they have different
 * fixes — a bad type is a caller bug, a bad range is an operator's setting. Calling `"2000"`
 * "outside the supported range" would send whoever reads the log hunting for a range
 * problem in a value that is in range.
 */
export function describeToolReviewGateOverride(raw: Record<string, unknown> | undefined): string | null {
  const requested = raw?.toolReviewGateMs;
  if (requested === undefined) return null;
  const applied = parseToolReviewGateMs(requested);
  if (typeof requested !== 'number' || !Number.isFinite(requested)) {
    return `toolReviewGateMs must be a finite number of milliseconds; got ${describeUnusableValue(requested)}, using ${applied}ms instead`;
  }
  // Range membership, not equality with the clamped result: 499.6 rounds to the floor and
  // so compares equal to it, but it was still out of range. Deciding on the rounded value
  // would put the warning's boundary half a millisecond away from the clamp's.
  if (requested >= TOOL_REVIEW_GATE_MIN_MS && requested <= TOOL_REVIEW_GATE_MAX_MS) return null;
  return `toolReviewGateMs ${requested} is outside the supported ${TOOL_REVIEW_GATE_MIN_MS}–${TOOL_REVIEW_GATE_MAX_MS}ms range; using ${applied}ms instead`;
}

/** Describe an unusable value without reflecting arbitrary RPC payloads into the log. */
function describeUnusableValue(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

/** Parse grounding sub-config. networkPolicy defaults to 'off' (zero external requests). */
function parseGrounding(raw: unknown): SupervisorConfig['grounding'] {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_CONFIG.grounding };
  const obj = raw as Record<string, unknown>;
  const networkPolicy: SupervisorConfig['grounding']['networkPolicy'] =
    obj.networkPolicy === 'identifiers-only' || obj.networkPolicy === 'full'
      ? obj.networkPolicy
      : 'off';
  return {
    networkPolicy,
    verdictMode: obj.verdictMode === 'info' ? 'info' : 'flag',
  };
}

/** Type-guard for the four valid reviewMode values. */
function isValidReviewMode(value: unknown): value is SupervisorConfig['reviewMode'] {
  return typeof value === 'string' && ['off', 'filter-only', 'correct', 'full'].includes(value);
}

/** Parse memoryGuard sub-config with fallback defaults. */
function parseMemoryGuard(raw: unknown): SupervisorConfig['memoryGuard'] {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_CONFIG.memoryGuard };
  const obj = raw as Record<string, unknown>;
  return {
    enabled: typeof obj.enabled === 'boolean' ? obj.enabled : DEFAULT_CONFIG.memoryGuard.enabled,
    keyCategories: parseStringArray(obj.keyCategories, DEFAULT_CONFIG.memoryGuard.keyCategories),
  };
}

/** Parse courseCorrection sub-config; clamps deviationThreshold to [0,1] and maxRegenerateAttempts to ≥1. */
function parseCourseCorrection(raw: unknown): SupervisorConfig['courseCorrection'] {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_CONFIG.courseCorrection };
  const obj = raw as Record<string, unknown>;
  return {
    enabled: typeof obj.enabled === 'boolean' ? obj.enabled : DEFAULT_CONFIG.courseCorrection.enabled,
    deviationThreshold: typeof obj.deviationThreshold === 'number'
      ? Math.min(1, Math.max(0, obj.deviationThreshold))
      : DEFAULT_CONFIG.courseCorrection.deviationThreshold,
    forceRegenerate: typeof obj.forceRegenerate === 'boolean' ? obj.forceRegenerate : DEFAULT_CONFIG.courseCorrection.forceRegenerate,
    maxRegenerateAttempts: typeof obj.maxRegenerateAttempts === 'number'
      ? Math.max(1, Math.round(obj.maxRegenerateAttempts))
      : DEFAULT_CONFIG.courseCorrection.maxRegenerateAttempts,
  };
}

/** `raw` when it is a number a clamp can act on, otherwise `fallback` (NaN and ±Infinity are not). */
function finiteOr(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

/** Parse a string array from unknown, returning a copy of `defaults` when not a valid array. */
function parseStringArray(raw: unknown, defaults: string[]): string[] {
  if (!Array.isArray(raw)) return [...defaults];
  return raw.filter((v): v is string => typeof v === 'string');
}

/**
 * Check if supervisor is effectively active (enabled + mode not off).
 *
 * Deliberately model-independent. `supervisorModel: ''` is the "inherit the main
 * model" marker the Dashboard saves by default, and the deterministic safety gate
 * (quick check + dangerousToolPolicy) needs no model at all — so requiring a
 * non-empty `supervisorModel` here would silently disable supervision for the
 * default configuration. Reviewer-model availability is a separate, observable
 * concern (see ReviewerClient.getReadiness / rc.supervisor.status.reviewerReady):
 * an unusable reviewer degrades deep review, it never opens the safety gate.
 */
export function isSupervisorActive(cfg: SupervisorConfig): boolean {
  return cfg.enabled && cfg.reviewMode !== 'off';
}

/**
 * Check if memory guard should be active.
 */
export function isMemoryGuardActive(cfg: SupervisorConfig): boolean {
  return isSupervisorActive(cfg) && cfg.reviewMode === 'full' && cfg.memoryGuard.enabled;
}

/**
 * Check if course correction should be active.
 */
export function isCourseCorrectionActive(cfg: SupervisorConfig): boolean {
  return isSupervisorActive(cfg) && (cfg.reviewMode === 'correct' || cfg.reviewMode === 'full') && cfg.courseCorrection.enabled;
}

/**
 * Check if force regeneration should be active.
 */
export function isForceRegenerateActive(cfg: SupervisorConfig): boolean {
  return isCourseCorrectionActive(cfg) && cfg.courseCorrection.forceRegenerate;
}

/**
 * Parse "provider/model" string into provider key and model id.
 */
export function parseModelRef(ref: string): { provider: string; modelId: string } | null {
  const slashIdx = ref.indexOf('/');
  if (slashIdx < 0) return null;
  return {
    provider: ref.slice(0, slashIdx),
    modelId: ref.slice(slashIdx + 1),
  };
}
