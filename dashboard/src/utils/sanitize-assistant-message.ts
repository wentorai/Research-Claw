/**
 * Unified message sanitization pipeline for assistant messages.
 *
 * LLM providers and the OpenClaw agent framework inject internal scaffolding
 * tags into assistant response text. The gateway's Pi handler strips some of
 * these during streaming, but the raw session transcript retains them. After
 * page refresh, chat.history returns the raw stored text and these tags leak
 * into the dashboard display.
 *
 * This module consolidates ALL assistant-side stripping logic that was
 * previously duplicated across chat.ts and MessageBubble.tsx into a single
 * pipeline. Adding new patterns here is the ONLY place needed.
 *
 * Counterpart to sanitize-message.ts (user messages, 13 patterns).
 *
 * Reference:
 *   - openclaw/src/shared/text/reasoning-tags.ts — <think>/<final> stripping
 *   - openclaw/src/shared/text/assistant-visible-text.ts — stripAssistantInternalScaffolding
 *   - openclaw/src/agents/pi-embedded-utils.ts:49-60 — model special tokens
 */

// ── Pattern Definitions ──

/**
 * Step 1: Reasoning/thinking tags — strip tags AND their content.
 * Matches: <think>, <thinking>, <thought>, <antthinking> (case-insensitive).
 * Source: openclaw/src/shared/text/reasoning-tags.ts:7 (THINKING_TAG_RE)
 *
 * We use a simpler regex approach than OpenClaw's full code-region-aware
 * state-machine since chat messages rarely contain code fences with these tags.
 */
const THINKING_TAG_RE = /<\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;

/**
 * Step 2: Final tags — strip tags but PRESERVE inner content.
 * Source: openclaw/src/shared/text/reasoning-tags.ts:6 (FINAL_TAG_RE)
 *
 * Some providers wrap the user-visible response in <final>...</final> tags.
 * The content IS the response — only the tag markers are removed.
 *
 * CRITICAL difference from thinking tags:
 *   <think>content</think>   → content is REMOVED (hidden reasoning)
 *   <final>content</final>   → content is PRESERVED (actual response)
 */
const FINAL_TAG_RE = /<\s*\/?\s*final\b[^<>]*>/gi;

/**
 * Step 3: Memory scaffolding tags — strip tags AND their content.
 * Matches: <relevant-memories>, <relevant_memories> (both variants, case-insensitive).
 * Source: openclaw/src/shared/text/assistant-visible-text.ts:4 (MEMORY_TAG_RE)
 *
 * OpenClaw's memory system injects <relevant-memories>...</relevant-memories>
 * blocks into assistant text containing internal memory context. These are
 * internal scaffolding and should never be shown to users.
 */
const MEMORY_TAG_RE = /<\s*(?:relevant[-_]memories)\b[^<>]*>[\s\S]*?<\s*\/\s*(?:relevant[-_]memories)\s*>/gi;
/** Quick check to avoid unnecessary regex processing. */
const MEMORY_TAG_QUICK_RE = /<\s*\/?\s*relevant[-_]memories\b/i;

/**
 * Step 4: Model special tokens — leaked internal delimiters.
 * Source: openclaw/src/agents/pi-embedded-utils.ts:49-60 (stripModelSpecialTokens)
 *
 * Models like GLM-5 and DeepSeek sometimes leak internal delimiters:
 *   - ASCII pipes: <|assistant|>, <|tool_call_result_begin|>, <|end|>
 *   - Full-width pipes: <｜begin▁of▁sentence｜> (U+FF5C, used by DeepSeek)
 */
const MODEL_SPECIAL_TOKEN_RE = /<[|｜][^|｜]*[|｜]>/g;

// ── Internal strip functions ──

function stripThinkingTags(text: string): string {
  THINKING_TAG_RE.lastIndex = 0;
  return text.replace(THINKING_TAG_RE, '');
}

function stripFinalTags(text: string): string {
  FINAL_TAG_RE.lastIndex = 0;
  if (!FINAL_TAG_RE.test(text)) return text;
  FINAL_TAG_RE.lastIndex = 0;
  return text.replace(FINAL_TAG_RE, '');
}

function stripMemoryTags(text: string): string {
  if (!MEMORY_TAG_QUICK_RE.test(text)) return text;
  MEMORY_TAG_RE.lastIndex = 0;
  return text.replace(MEMORY_TAG_RE, '');
}

function stripModelSpecialTokens(text: string): string {
  if (!MODEL_SPECIAL_TOKEN_RE.test(text)) return text;
  MODEL_SPECIAL_TOKEN_RE.lastIndex = 0;
  return text.replace(MODEL_SPECIAL_TOKEN_RE, ' ').replace(/  +/g, ' ');
}

// ── Exported Pipeline ──

/**
 * Sanitize assistant message text for display.
 * Strips ALL internal scaffolding in a fixed 4-step pipeline.
 *
 * Pipeline order matters:
 *   1. Thinking tags (remove tags + content) — most aggressive
 *   2. Final tags (remove tags, keep content) — unwrap response
 *   3. Memory tags (remove tags + content) — internal context
 *   4. Model special tokens (replace with space) — leaked delimiters
 *
 * Returns clean text suitable for rendering or "copy visible" action.
 */
export function sanitizeAssistantMessage(text: string): string {
  if (!text) return text;

  let result = text;
  result = stripThinkingTags(result);   // Step 1
  result = stripFinalTags(result);      // Step 2
  result = stripMemoryTags(result);     // Step 3
  result = stripModelSpecialTokens(result); // Step 4

  return result.trim();
}

/**
 * Sanitize assistant text for "copy raw" — preserves thinking tags,
 * strips all other internal scaffolding.
 *
 * Use case: user clicks "copy raw" to get the full thinking chain + answer.
 * Thinking content is useful here, but final/memory/model tokens are not.
 */
export function sanitizeAssistantRawCopy(text: string): string {
  if (!text) return text;

  let result = text;
  // Skip Step 1 (thinking tags preserved for raw copy)
  result = stripFinalTags(result);          // Step 2
  result = stripMemoryTags(result);         // Step 3
  result = stripModelSpecialTokens(result); // Step 4

  return result.trim();
}
