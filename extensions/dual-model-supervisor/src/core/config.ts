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
    reviewMode: parseReviewMode(raw.reviewMode),
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

/** Type-guard for the supported reviewMode values. */
function isValidReviewMode(value: unknown): value is SupervisorConfig['reviewMode'] {
  return typeof value === 'string' && ['off', 'filter-only', 'correct'].includes(value);
}

/**
 * Parse review mode. `full` existed only to enable the withdrawn Memory Guard;
 * preserving it as `correct` keeps legacy users supervised instead of silently
 * falling back to the default `off`.
 */
function parseReviewMode(raw: unknown): SupervisorConfig['reviewMode'] {
  if (raw === 'full') return 'correct';
  return isValidReviewMode(raw) ? raw : DEFAULT_CONFIG.reviewMode;
}

/**
 * Parse courseCorrection sub-config; clamps deviationThreshold to [0,1] and
 * maxRegenerateAttempts to ≥1.
 *
 * Unlike toolReviewGateMs, here the parser really is the only enforcement point. The
 * manifest declares deviationThreshold as a plain `number` whose *description* says
 * "(0-1)" but carries no `minimum`/`maximum`, and does not declare maxRegenerateAttempts
 * at all — so `deviationThreshold: 99` and `maxRegenerateAttempts: 0` both pass OpenClaw's
 * schema validation and arrive here intact. `maxRegenerateAttempts: 0` makes
 * `regenerateAttempts < maxAttempts` false on the first turn, so force-regenerate never
 * fires while the Dashboard still reports it enabled; the floor of 1 is what closes that.
 *
 * The threshold clamp does less than it looks like it does, and is documented here so the
 * next reader does not over-trust it. It normalises the value onto the documented range,
 * which is all: it cannot make 99 mean anything, and mapping 99 onto the maximum is only
 * safe because course-corrector.ts compares with `>=`. Under the strict `>` this code
 * shipped with, a threshold of exactly 1 could never be exceeded (deviation is itself
 * clamped to [0,1] by validateDeviationAnalysis), so clamping 99 landed the config on a
 * value that silently disabled correction just as thoroughly as 99 had. Range and
 * comparison are separate obligations; see course-correction-semantics.test.ts.
 *
 * The `finiteOr` guards are defensive only: NaN and ±Infinity cannot be expressed in JSON,
 * and both callers of parseConfig get their input from JSON. They are here because NaN
 * would survive Math.min/Math.max unchanged and would make every comparison against it
 * false — a dead switch by a route no clamp would catch — not because that has been observed.
 */
function parseCourseCorrection(raw: unknown): SupervisorConfig['courseCorrection'] {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_CONFIG.courseCorrection };
  const obj = raw as Record<string, unknown>;
  const threshold = finiteOr(obj.deviationThreshold, DEFAULT_CONFIG.courseCorrection.deviationThreshold);
  const attempts = finiteOr(obj.maxRegenerateAttempts, DEFAULT_CONFIG.courseCorrection.maxRegenerateAttempts);
  return {
    enabled: typeof obj.enabled === 'boolean' ? obj.enabled : DEFAULT_CONFIG.courseCorrection.enabled,
    deviationThreshold: Math.min(1, Math.max(0, threshold)),
    forceRegenerate: typeof obj.forceRegenerate === 'boolean' ? obj.forceRegenerate : DEFAULT_CONFIG.courseCorrection.forceRegenerate,
    maxRegenerateAttempts: Math.max(1, Math.round(attempts)),
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
 * Check if course correction should be active.
 */
export function isCourseCorrectionActive(cfg: SupervisorConfig): boolean {
  return isSupervisorActive(cfg) && cfg.reviewMode === 'correct' && cfg.courseCorrection.enabled;
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
