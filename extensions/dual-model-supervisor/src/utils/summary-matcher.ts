/**
 * Summary Matcher — Shared utility for matching assistant content to MessageSummary.
 *
 * Used by ConsistencyChecker and MemoryGuardian to replace duplicated
 * `_findMatchingSummary` / `_findSummaryForContent` implementations.
 */

import type { MessageSummary } from '../core/types.js';

const SNIPPET_LENGTH = 50;
const MIN_SNIPPET_LENGTH = 10;

/**
 * Check whether any text in the given array produces a snippet that appears in `content`.
 */
function anySnippetMatches(content: string, texts: string[]): boolean {
  for (const text of texts) {
    const snippet = text.slice(0, SNIPPET_LENGTH);
    if (snippet.length > MIN_SNIPPET_LENGTH && content.includes(snippet)) {
      return true;
    }
  }
  return false;
}

/**
 * Find a matching summary for the given plain-text content.
 * Uses a heuristic: if any snippet from claims/decisions/conditions/reasoning
 * appears in the content. Searches from most recent backwards; falls back to null
 * (no longer returns the most recent summary as a best guess to avoid mismatches).
 */
export function findMatchingSummary(
  content: string,
  summaries: MessageSummary[],
): MessageSummary | null {
  if (!content) return null;

  // Search from most recent backwards, checking multiple fields for better matching
  for (let i = summaries.length - 1; i >= 0; i--) {
    const summary = summaries[i];

    // Check claims (primary)
    if (anySnippetMatches(content, summary.claims)) return summary;

    // Check decisions (high-value — decisions are distinctive)
    if (anySnippetMatches(content, summary.decisions)) return summary;

    // Check conditions (preconditions are often referenced verbatim)
    if (summary.conditions && anySnippetMatches(content, summary.conditions)) return summary;

    // Check reasoning (key reasoning steps may be restated)
    if (summary.reasoning && anySnippetMatches(content, summary.reasoning)) return summary;

    // Check negations (explicit exclusions are distinctive markers)
    if (summary.negations && anySnippetMatches(content, summary.negations)) return summary;
  }

  // No match found — return null rather than a potentially unrelated summary
  return null;
}
