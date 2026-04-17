/**
 * Session Context — Shared utility for building session context strings.
 *
 * Extracted from ConsistencyChecker, CourseCorrector, and OutputReviewer
 * which all built similar "researchGoal + targetConclusions + methodology + keyConclusions" strings.
 */

import type { SessionState } from '../core/types.js';

/**
 * Build an array of context lines from common session state fields.
 * Callers can join these with their preferred separator.
 */
export function buildSessionContextLines(sessionState: SessionState): string[] {
  const lines: string[] = [];

  if (sessionState.researchGoal) {
    lines.push(`Research goal: ${sessionState.researchGoal}`);
  }
  if (sessionState.targetConclusions.length > 0) {
    lines.push(`Target conclusions: ${sessionState.targetConclusions.join('; ')}`);
  }
  if (sessionState.methodology) {
    lines.push(`Methodology: ${sessionState.methodology}`);
  }
  if (sessionState.keyConclusions.length > 0) {
    lines.push(`Key conclusions reached: ${sessionState.keyConclusions.join('; ')}`);
  }

  return lines;
}
