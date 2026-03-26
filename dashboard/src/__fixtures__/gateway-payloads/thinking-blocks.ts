/**
 * Realistic gateway payloads for thinking/reasoning block extraction.
 *
 * These fixtures cover the TWO formats thinking content can appear in:
 *
 * 1. Content blocks with `type: 'thinking'` — Anthropic extended thinking format.
 *    Source: openclaw/ui/src/ui/chat/message-extract.ts:46-54
 *      if (item.type === "thinking" && typeof item.thinking === "string")
 *
 * 2. `<think>...</think>` XML tags in text — Some providers wrap reasoning in these.
 *    Source: openclaw/ui/src/ui/chat/message-extract.ts:65-68
 *      rawText.matchAll(/<\s*think(?:ing)?\s*>([\s\S]*?)<\s*\/\s*think(?:ing)?\s*>/gi)
 *
 * Update these when OpenClaw protocol changes.
 */

import type { ChatStreamEvent, ChatMessage } from '../../gateway/types';

// ─── Anthropic format: type: 'thinking' content blocks ──────────────

/**
 * Message with a thinking content block + text block.
 * Source: message-extract.ts:46-54 — `item.type === "thinking" && typeof item.thinking === "string"`
 * Source: message-extract.ts:92-100 — extractRawText only joins type: 'text' blocks
 */
export const MSG_THINKING_BLOCK_AND_TEXT: ChatMessage = {
  role: 'assistant',
  content: [
    {
      type: 'thinking',
      thinking: 'Let me analyze the paper structure. The methodology section uses a transformer architecture with multi-head attention.',
    },
    {
      type: 'text',
      text: 'The paper uses a transformer-based architecture with multi-head attention for sequence modeling.',
    },
  ],
  timestamp: 1710400000000,
};

/**
 * Message with ONLY thinking blocks — no visible text after extraction.
 * Edge case: extractRawText returns null because no type:'text' blocks exist.
 */
export const MSG_THINKING_ONLY: ChatMessage = {
  role: 'assistant',
  content: [
    {
      type: 'thinking',
      thinking: 'I need to consider what tools to use here. The user wants a literature search.',
    },
  ],
  timestamp: 1710400001000,
};

/**
 * Message with multiple thinking blocks interleaved with text blocks.
 * Source: message-extract.ts:44-58 — parts are joined with "\n"
 */
export const MSG_MULTIPLE_THINKING_BLOCKS: ChatMessage = {
  role: 'assistant',
  content: [
    {
      type: 'thinking',
      thinking: 'First, I should search for papers on attention mechanisms.',
    },
    {
      type: 'text',
      text: 'I found three relevant papers. ',
    },
    {
      type: 'thinking',
      thinking: 'The user might also want to know about the citation counts.',
    },
    {
      type: 'text',
      text: 'Here are the details with citation counts.',
    },
  ],
  timestamp: 1710400002000,
};

// ─── Provider format: <think>...</think> tags in text ───────────────

/**
 * Message with <think>...</think> tags wrapping reasoning in text content.
 * Source: message-extract.ts:65-68 — regex: /<\s*think(?:ing)?\s*>([\s\S]*?)<\s*\/\s*think(?:ing)?\s*>/gi
 * Source: format.ts:58-60 → stripThinkingTags → stripAssistantInternalScaffolding
 * Source: reasoning-tags.ts:7 — THINKING_TAG_RE handles think, thinking, thought, antthinking
 */
export const MSG_THINK_TAGS_IN_TEXT: ChatMessage = {
  role: 'assistant',
  content: [
    {
      type: 'text',
      text: '<think>I should analyze the methodology carefully before responding.</think>The methodology uses a novel approach to self-attention.',
    },
  ],
  timestamp: 1710400003000,
};

/**
 * Message with <thinking>...</thinking> tags (alternate tag name).
 * Source: message-extract.ts:66 — regex matches both `think` and `thinking`
 */
export const MSG_THINKING_TAGS_IN_TEXT: ChatMessage = {
  role: 'assistant',
  content: [
    {
      type: 'text',
      text: '<thinking>The user is asking about scaling laws. Let me recall the key findings from Kaplan et al.</thinking>Scaling laws suggest that model performance follows a power law with respect to compute, dataset size, and model parameters.',
    },
  ],
  timestamp: 1710400004000,
};

/**
 * Message with multiple <think> blocks in text.
 */
export const MSG_MULTIPLE_THINK_TAGS: ChatMessage = {
  role: 'assistant',
  content: [
    {
      type: 'text',
      text: '<think>First consideration: the paper is from 2017.</think>The paper was published in 2017. <think>Second consideration: it has over 100k citations.</think>It has become one of the most cited papers in machine learning.',
    },
  ],
  timestamp: 1710400005000,
};

/**
 * Message with text field (not content array) containing think tags.
 * Tests the text-field fallback path.
 */
export const MSG_THINK_TAGS_IN_TEXT_FIELD: ChatMessage = {
  role: 'assistant',
  text: '<think>Planning my response about BERT.</think>BERT is a bidirectional transformer model pre-trained on masked language modeling.',
  timestamp: 1710400006000,
};

// ─── Streaming deltas with thinking ────────────────────────────────

/**
 * Streaming delta that contains think tags mid-stream.
 * The displayed stream text should NOT show the raw thinking tags.
 */
export const DELTA_WITH_THINK_TAGS: ChatStreamEvent = {
  runId: 'run-think-001',
  sessionKey: 'main',
  state: 'delta',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: '<think>Let me search for relevant papers first.</think>I found several papers on attention mechanisms.',
      },
    ],
  },
};

/**
 * Streaming delta with thinking content block (Anthropic format).
 */
export const DELTA_WITH_THINKING_BLOCK: ChatStreamEvent = {
  runId: 'run-think-002',
  sessionKey: 'main',
  state: 'delta',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'thinking',
        thinking: 'Searching the literature database...',
      },
      {
        type: 'text',
        text: 'Searching for papers...',
      },
    ],
  },
};

/**
 * Final message with thinking block — what handleChatEvent receives at the end.
 */
export const FINAL_WITH_THINKING: ChatStreamEvent = {
  runId: 'run-think-001',
  sessionKey: 'main',
  state: 'final',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'thinking',
        thinking: 'The user wants a summary of transformer papers. I should focus on the key innovations.',
      },
      {
        type: 'text',
        text: 'Here is a summary of the key transformer papers and their innovations.',
      },
    ],
    stopReason: 'end_turn',
    timestamp: 1710400010000,
  },
  usage: { input: 200, output: 55, total: 255 },
};

/**
 * Final message with think tags in text (provider format).
 */
export const FINAL_WITH_THINK_TAGS: ChatStreamEvent = {
  runId: 'run-think-003',
  sessionKey: 'main',
  state: 'final',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: '<think>I need to provide a comprehensive answer about BERT pre-training.</think>BERT uses masked language modeling and next sentence prediction for pre-training.',
      },
    ],
    stopReason: 'end_turn',
    timestamp: 1710400011000,
  },
  usage: { input: 180, output: 30, total: 210 },
};

// ─── Provider format: <final>...</final> tags in text ────────────────

/**
 * Message with <final>...</final> tags wrapping the user-visible response.
 * Source: reasoning-tags.ts:6 — FINAL_TAG_RE = /<\s*\/?\s*final\b[^<>]*>/gi
 * Source: reasoning-tags.ts:37-55 — strips <final> tags but PRESERVES inner content
 *
 * CRITICAL difference from <think> tags:
 *   <think>content</think> → content is REMOVED (hidden reasoning)
 *   <final>content</final> → content is PRESERVED (actual response)
 */
export const MSG_FINAL_TAGS_IN_TEXT: ChatMessage = {
  role: 'assistant',
  content: [
    {
      type: 'text',
      text: '<final>不客气！如果有任何需要帮忙的，随时告诉我。</final>',
    },
  ],
  timestamp: 1710400012000,
};

/**
 * Message with <final> tags and surrounding whitespace.
 * OpenClaw trims after stripping — reasoning-tags.ts:91 applyTrim.
 */
export const MSG_FINAL_TAGS_WITH_WHITESPACE: ChatMessage = {
  role: 'assistant',
  content: [
    {
      type: 'text',
      text: '<final>\n\nHello there\n\n</final>',
    },
  ],
  timestamp: 1710400013000,
};

/**
 * Message with text field (not content array) containing final tags.
 * Tests the text-field fallback path.
 */
export const MSG_FINAL_TAGS_IN_TEXT_FIELD: ChatMessage = {
  role: 'assistant',
  text: '<final>Here is your analysis of the paper.</final>',
  timestamp: 1710400014000,
};

/**
 * Streaming delta with <final> tags.
 */
export const DELTA_WITH_FINAL_TAGS: ChatStreamEvent = {
  runId: 'run-final-001',
  sessionKey: 'main',
  state: 'delta',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: '<final>I found several relevant papers on this topic.</final>',
      },
    ],
  },
};

/**
 * Final event with <final> tags.
 */
export const FINAL_WITH_FINAL_TAGS: ChatStreamEvent = {
  runId: 'run-final-002',
  sessionKey: 'main',
  state: 'final',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: '<final>The transformer architecture revolutionized NLP.</final>',
      },
    ],
    stopReason: 'end_turn',
    timestamp: 1710400015000,
  },
  usage: { input: 150, output: 25, total: 175 },
};

// ─── Memory scaffolding: <relevant-memories>/<relevant_memories> ──────

/**
 * Message with <relevant-memories> block injected by OpenClaw memory system.
 * Source: assistant-visible-text.ts:4 (MEMORY_TAG_RE)
 * Source: assistant-visible-text.test.ts:10-19
 *
 * These blocks contain internal memory context and should be fully hidden.
 */
export const MSG_RELEVANT_MEMORIES_BLOCK: ChatMessage = {
  role: 'assistant',
  content: [
    {
      type: 'text',
      text: '<relevant-memories>\nThe following memories may be relevant:\n- User prefers dark mode\n- Last discussed paper: attention mechanisms\n</relevant-memories>\n\nBased on your previous interest, here are related papers.',
    },
  ],
  timestamp: 1710400016000,
};

/**
 * Message with underscore variant: <relevant_memories>.
 * Source: assistant-visible-text.test.ts:22-29
 */
export const MSG_RELEVANT_MEMORIES_UNDERSCORE: ChatMessage = {
  role: 'assistant',
  content: [
    {
      type: 'text',
      text: '<relevant_memories>\nInternal memory note about user preferences\n</relevant_memories>\nHere is your summary.',
    },
  ],
  timestamp: 1710400017000,
};

// ─── Combined: multiple scaffolding types in one message ─────────────

/**
 * Message with thinking + final + memory tags all present.
 * Tests the full pipeline ordering.
 */
export const MSG_COMBINED_ALL_SCAFFOLDING: ChatMessage = {
  role: 'assistant',
  content: [
    {
      type: 'text',
      text: '<think>Let me analyze this carefully.</think><relevant-memories>\nUser is a data scientist\n</relevant-memories>\n<final>The analysis shows a significant correlation between the variables.</final>',
    },
  ],
  timestamp: 1710400018000,
};

/**
 * Message with model special tokens + final tags.
 * Tests pipeline interaction between token stripping and tag stripping.
 */
export const MSG_MODEL_TOKENS_AND_FINAL: ChatMessage = {
  role: 'assistant',
  content: [
    {
      type: 'text',
      text: '<|assistant|><final>Here is the answer to your question.</final><|end|>',
    },
  ],
  timestamp: 1710400019000,
};
