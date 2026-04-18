/**
 * Dual Model Supervisor — Configuration Parser
 *
 * Parses raw pluginConfig from openclaw.json into a typed SupervisorConfig.
 */

import { type SupervisorConfig, DEFAULT_CONFIG } from './types.js';

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
    appendReviewToChannelOutput: typeof raw.appendReviewToChannelOutput === 'boolean'
      ? raw.appendReviewToChannelOutput
      : DEFAULT_CONFIG.appendReviewToChannelOutput,
    memoryGuard: parseMemoryGuard(raw.memoryGuard),
    courseCorrection: parseCourseCorrection(raw.courseCorrection),
    highRiskTools: parseStringArray(raw.highRiskTools, DEFAULT_CONFIG.highRiskTools),
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

/** Parse a string array from unknown, returning a copy of `defaults` when not a valid array. */
function parseStringArray(raw: unknown, defaults: string[]): string[] {
  if (!Array.isArray(raw)) return [...defaults];
  return raw.filter((v): v is string => typeof v === 'string');
}

/**
 * Check if supervisor is effectively active (enabled + model configured + mode not off).
 */
export function isSupervisorActive(cfg: SupervisorConfig): boolean {
  return cfg.enabled && cfg.supervisorModel.length > 0 && cfg.reviewMode !== 'off';
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
