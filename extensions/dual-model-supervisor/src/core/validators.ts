/**
 * Dual Model Supervisor — Reviewer Response Validators
 *
 * Narrow shape-validators for LLM JSON responses.
 * Each validator returns a sanitized object or null if the shape is invalid.
 */

import type { ReviewResult, ToolReviewResult, ConsistencyCheckResult, MessageSummary } from './types.js';

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && !isNaN(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((item): item is string => typeof item === 'string');
}

function clamp01(v: unknown): number {
  if (!isNumber(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/**
 * Validate and sanitize a ReviewResult from the reviewer model.
 * Returns null if the response is fundamentally invalid.
 */
export function validateReviewResult(raw: unknown): ReviewResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  // `blocked` must be boolean — if not, fail-safe to not-blocked
  const blocked = isBoolean(r.blocked) ? r.blocked : false;
  const corrected = isBoolean(r.corrected) ? r.corrected : false;

  return {
    blocked,
    corrected,
    correctedVersion: isString(r.correctedVersion) ? r.correctedVersion : undefined,
    correctionNote: isString(r.correctionNote) ? r.correctionNote : undefined,
    warnings: asStringArray(r.warnings),
    memoryAlerts: asStringArray(r.memoryAlerts),
    deviationScore: clamp01(r.deviationScore),
    qualityScore: clamp01(r.qualityScore),
    reportText: isString(r.reportText) ? r.reportText : undefined,
  };
}

/**
 * Validate a ToolReviewResult. Extra security: correctedParams keys must be
 * a subset of the original tool parameters to prevent parameter injection.
 */
export function validateToolReviewResult(
  raw: unknown,
  originalParamKeys: string[],
): ToolReviewResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const blocked = isBoolean(r.blocked) ? r.blocked : false;

  let correctedParams: Record<string, unknown> | undefined;
  if (r.correctedParams && typeof r.correctedParams === 'object' && !Array.isArray(r.correctedParams)) {
    // Only accept keys that exist in the original params
    const filtered: Record<string, unknown> = {};
    const cp = r.correctedParams as Record<string, unknown>;
    let hasValidKey = false;
    for (const key of Object.keys(cp)) {
      if (originalParamKeys.includes(key)) {
        filtered[key] = cp[key];
        hasValidKey = true;
      }
    }
    correctedParams = hasValidKey ? filtered : undefined;
  }

  return {
    blocked,
    blockReason: isString(r.blockReason) ? r.blockReason : undefined,
    correctedParams,
    warnings: asStringArray(r.warnings),
  };
}

/**
 * Validate a ConsistencyCheckResult.
 */
export function validateConsistencyResult(raw: unknown): ConsistencyCheckResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  return {
    hasIssue: isBoolean(r.hasIssue) ? r.hasIssue : false,
    correction: isString(r.correction) ? r.correction : undefined,
    details: asStringArray(r.details),
  };
}

/**
 * Validate a TaskParsingResult (goal parser response).
 */
export function validateTaskParsingResult(raw: unknown): { researchGoal: string; targetConclusions: string[]; methodology?: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const researchGoal = isString(r.researchGoal) ? r.researchGoal.trim() : '';
  if (!researchGoal) return null; // Goal is required

  return {
    researchGoal,
    targetConclusions: asStringArray(r.targetConclusions),
    methodology: isString(r.methodology) && r.methodology.trim() ? r.methodology.trim() : undefined,
  };
}

/**
 * Validate a MessageSummary (summary extractor response).
 */
export function validateMessageSummary(raw: unknown): MessageSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  return {
    claims: asStringArray(r.claims),
    decisions: asStringArray(r.decisions),
    references: asStringArray(r.references),
    conditions: asStringArray(r.conditions),
    reasoning: asStringArray(r.reasoning),
    limitations: asStringArray(r.limitations),
    negations: asStringArray(r.negations),
    nextSteps: asStringArray(r.nextSteps),
  };
}

/**
 * Validate memory loss items from after_compaction review.
 */
export function validateMemoryLossItems(raw: unknown): Array<{ category: string; content: string; importance: string }> {
  if (!raw || typeof raw !== 'object') return [];
  const r = raw as Record<string, unknown>;
  const items = r.lostItems;
  if (!Array.isArray(items)) return [];

  return items
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .filter((item) => isString(item.category) && isString(item.content))
    .map((item) => ({
      category: item.category as string,
      content: item.content as string,
      importance: isString(item.importance) ? item.importance : 'medium',
    }));
}

/**
 * Validate key memory items from before_compaction review.
 */
export function validateKeyMemoryItems(raw: unknown): Array<{ category: string; summary: string; source: string; timestamp: number }> {
  if (!raw || typeof raw !== 'object') return [];
  const r = raw as Record<string, unknown>;
  const items = r.keyItems;
  if (!Array.isArray(items)) return [];

  return items
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .filter((item) => isString(item.category) && isString(item.summary))
    .map((item) => ({
      category: item.category as string,
      summary: item.summary as string,
      source: isString(item.source) ? item.source : '',
      timestamp: isNumber(item.timestamp) ? item.timestamp : 0,
    }));
}

/**
 * Validate course correction / deviation analysis response.
 */
export function validateDeviationAnalysis(raw: unknown): {
  deviation: number;
  memoryLoss: boolean;
  qualityScore: number;
  courseCorrection: string;
  summary: string;
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  return {
    deviation: clamp01(r.deviation),
    memoryLoss: isBoolean(r.memoryLoss) ? r.memoryLoss : false,
    qualityScore: clamp01(r.qualityScore),
    courseCorrection: isString(r.courseCorrection) ? r.courseCorrection : '',
    summary: isString(r.summary) ? r.summary : '',
  };
}
