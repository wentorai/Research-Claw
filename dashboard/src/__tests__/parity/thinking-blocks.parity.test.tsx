/**
 * Behavioral Parity Tests: Thinking/Reasoning Block Extraction
 *
 * These tests verify that our dashboard handles thinking/reasoning content
 * IDENTICALLY to OpenClaw's native Lit UI.
 *
 * OpenClaw reference implementation:
 *   - message-extract.ts:extractThinking (lines 41-69) — extracts thinking from content blocks + <think> tags
 *   - message-extract.ts:extractText (lines 18-26) — strips thinking tags from displayed text via processMessageText
 *   - message-extract.ts:extractRawText (lines 85-109) — only joins type:'text' blocks (NOT type:'thinking')
 *   - format.ts:stripThinkingTags (line 58-60) — delegates to stripAssistantInternalScaffolding
 *   - reasoning-tags.ts:stripReasoningTagsFromText — state-machine that strips <think>/<thinking>/<thought>/<antthinking> tags
 *   - grouped-render.ts:275-277 — renders thinking in a `chat-thinking` div, BEFORE the main text
 *   - grouped-render.ts:246 — only extracts thinking for assistant role
 *   - format.ts:formatReasoningMarkdown (lines 111-122) — formats as italic lines with "_Reasoning:_" header
 *
 * CRITICAL: These tests use REAL gateway message formats (fixtures),
 * not hand-crafted mock data.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import MessageBubble from '../../components/chat/MessageBubble';
import { useChatStore } from '../../stores/chat';
import {
  MSG_THINKING_BLOCK_AND_TEXT,
  MSG_THINKING_ONLY,
  MSG_MULTIPLE_THINKING_BLOCKS,
  MSG_THINK_TAGS_IN_TEXT,
  MSG_THINKING_TAGS_IN_TEXT,
  MSG_MULTIPLE_THINK_TAGS,
  MSG_THINK_TAGS_IN_TEXT_FIELD,
  DELTA_WITH_THINK_TAGS,
  DELTA_WITH_THINKING_BLOCK,
  FINAL_WITH_THINKING,
  FINAL_WITH_THINK_TAGS,
  MSG_FINAL_TAGS_IN_TEXT,
  MSG_FINAL_TAGS_WITH_WHITESPACE,
  MSG_FINAL_TAGS_IN_TEXT_FIELD,
  DELTA_WITH_FINAL_TAGS,
  FINAL_WITH_FINAL_TAGS,
  MSG_RELEVANT_MEMORIES_BLOCK,
  MSG_RELEVANT_MEMORIES_UNDERSCORE,
  MSG_COMBINED_ALL_SCAFFOLDING,
  MSG_MODEL_TOKENS_AND_FINAL,
} from '../../__fixtures__/gateway-payloads/thinking-blocks';

// Mock i18n
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'chat.you': 'You',
        'chat.assistant': 'Assistant',
        'chat.thinkingLabel': 'Thinking',
      };
      return map[key] ?? key;
    },
    i18n: { changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

describe('Thinking block parity with OpenClaw native UI', () => {
  describe('extractText STRIPS thinking — message-extract.ts:10-11, format.ts:58-60', () => {
    /**
     * OpenClaw behavior (message-extract.ts:10-11):
     *   if (role === "assistant") return stripThinkingTags(text);
     *
     * stripThinkingTags → stripAssistantInternalScaffolding → stripReasoningTagsFromText
     * which removes all <think>/<thinking> tags and their content from the displayed text.
     */
    it('strips <think>...</think> tags from displayed assistant text', () => {
      render(<MessageBubble message={MSG_THINK_TAGS_IN_TEXT} />);

      // The answer text should appear
      expect(screen.getByText(/The methodology uses a novel approach/)).toBeInTheDocument();

      // The raw thinking content should NOT appear in the main text area (.markdown-body)
      // It may exist in a hidden thinking section, but NOT in the answer text.
      const mainTextElements = document.querySelectorAll('.markdown-body');
      for (const el of mainTextElements) {
        expect(el.textContent).not.toContain('I should analyze the methodology carefully');
      }

      // The raw <think> tag itself should definitely not appear
      expect(screen.queryByText(/<think>/)).toBeNull();
      expect(screen.queryByText(/<\/think>/)).toBeNull();
    });

    it('strips <thinking>...</thinking> tags from displayed assistant text', () => {
      render(<MessageBubble message={MSG_THINKING_TAGS_IN_TEXT} />);

      // The answer text should appear
      expect(screen.getByText(/Scaling laws suggest that model performance/)).toBeInTheDocument();

      // The raw thinking content should NOT appear mixed with the answer
      // (it may appear in a separate thinking section, but not in the main markdown body)
      const mainTextElements = document.querySelectorAll('.markdown-body');
      for (const el of mainTextElements) {
        expect(el.textContent).not.toContain('The user is asking about scaling laws');
      }
    });

    it('strips multiple <think> blocks from displayed text', () => {
      render(<MessageBubble message={MSG_MULTIPLE_THINK_TAGS} />);

      // Both answer parts should be visible
      expect(screen.getByText(/The paper was published in 2017/)).toBeInTheDocument();

      // Raw thinking content should not appear in the main text
      const mainTextElements = document.querySelectorAll('.markdown-body');
      for (const el of mainTextElements) {
        expect(el.textContent).not.toContain('First consideration');
        expect(el.textContent).not.toContain('Second consideration');
      }
    });
  });

  describe('extractText with content blocks — message-extract.ts:85-109', () => {
    /**
     * OpenClaw behavior (message-extract.ts:92-100):
     *   extractRawText only joins content blocks where item.type === "text"
     *   Blocks with type === "thinking" are IGNORED by extractRawText.
     *
     * This means the displayed text naturally excludes thinking content blocks.
     */
    it('does NOT include type:"thinking" blocks in displayed text', () => {
      render(<MessageBubble message={MSG_THINKING_BLOCK_AND_TEXT} />);

      // The text block content should appear
      expect(
        screen.getByText(/The paper uses a transformer-based architecture/),
      ).toBeInTheDocument();

      // The thinking block content should NOT appear in the main text
      const mainTextElements = document.querySelectorAll('.markdown-body');
      for (const el of mainTextElements) {
        expect(el.textContent).not.toContain('Let me analyze the paper structure');
      }
    });

    it('handles message with ONLY thinking blocks gracefully', () => {
      // When there are only thinking blocks and no text blocks,
      // extractRawText returns null → no visible text to display.
      // The component should not crash and should handle this gracefully.
      const { container } = render(<MessageBubble message={MSG_THINKING_ONLY} />);

      // Should not crash — component should render without error
      expect(container).toBeTruthy();
    });
  });

  describe('Thinking extraction — message-extract.ts:41-69', () => {
    /**
     * OpenClaw behavior (message-extract.ts:41-69):
     *   1. First checks content blocks for type === "thinking" (Anthropic format)
     *   2. Falls back to regex extraction from <think>/<thinking> tags in text
     *   3. Extracted thinking is rendered in a separate collapsible section
     *
     * grouped-render.ts:275-277:
     *   html`<div class="chat-thinking">...</div>`
     */
    it('renders thinking content in a distinct section for Anthropic thinking blocks', () => {
      render(<MessageBubble message={MSG_THINKING_BLOCK_AND_TEXT} />);

      // There should be a thinking section with the thinking content
      const thinkingSection = document.querySelector('[data-testid="thinking-section"]');
      expect(thinkingSection).not.toBeNull();
      expect(thinkingSection!.textContent).toContain(
        'Let me analyze the paper structure',
      );
    });

    it('renders thinking content in a distinct section for <think> tag format', () => {
      render(<MessageBubble message={MSG_THINK_TAGS_IN_TEXT} />);

      const thinkingSection = document.querySelector('[data-testid="thinking-section"]');
      expect(thinkingSection).not.toBeNull();
      expect(thinkingSection!.textContent).toContain(
        'I should analyze the methodology carefully',
      );
    });

    it('joins multiple thinking blocks with newline — message-extract.ts:57', () => {
      /**
       * OpenClaw behavior (message-extract.ts:56-58):
       *   if (parts.length > 0) return parts.join("\n");
       */
      render(<MessageBubble message={MSG_MULTIPLE_THINKING_BLOCKS} />);

      const thinkingSection = document.querySelector('[data-testid="thinking-section"]');
      expect(thinkingSection).not.toBeNull();
      // Both thinking blocks should be present
      expect(thinkingSection!.textContent).toContain('search for papers');
      expect(thinkingSection!.textContent).toContain('citation counts');
    });

    it('shows thinking section for text field with think tags', () => {
      render(<MessageBubble message={MSG_THINK_TAGS_IN_TEXT_FIELD} />);

      const thinkingSection = document.querySelector('[data-testid="thinking-section"]');
      expect(thinkingSection).not.toBeNull();
      expect(thinkingSection!.textContent).toContain('Planning my response about BERT');
    });

    it('does NOT show thinking section for assistant messages without thinking', () => {
      const noThinking: typeof MSG_THINKING_BLOCK_AND_TEXT = {
        role: 'assistant',
        content: [{ type: 'text', text: 'Just a normal response.' }],
        timestamp: 1710400000000,
      };

      render(<MessageBubble message={noThinking} />);

      const thinkingSection = document.querySelector('[data-testid="thinking-section"]');
      expect(thinkingSection).toBeNull();
    });

    it('does NOT extract thinking from user messages — grouped-render.ts:246', () => {
      /**
       * OpenClaw behavior (grouped-render.ts:246):
       *   opts.showReasoning && role === "assistant" ? extractThinkingCached(message) : null
       *
       * Only assistant messages get thinking extraction.
       */
      const userMsg: typeof MSG_THINKING_BLOCK_AND_TEXT = {
        role: 'user',
        content: [
          { type: 'text', text: '<think>user thinking</think>Hello' },
        ],
        timestamp: 1710400000000,
      };

      render(<MessageBubble message={userMsg} />);

      const thinkingSection = document.querySelector('[data-testid="thinking-section"]');
      expect(thinkingSection).toBeNull();
    });
  });

  describe('Streaming deltas strip thinking — chat store extractText', () => {
    /**
     * OpenClaw behavior (message-extract.ts:10-11):
     *   For assistant role, extractText calls stripThinkingTags on the raw text.
     *   This means streaming deltas should NOT show raw thinking content.
     *
     * Our chat store's extractText function is used in handleChatEvent (delta case)
     * to produce streamText. The streamText should NOT contain <think> tags.
     */
    beforeEach(() => {
      useChatStore.setState({
        messages: [],
        streaming: false,
        streamText: null,
        runId: 'run-think-001',
        sessionKey: 'main',
        lastError: null,
        tokensIn: 0,
        tokensOut: 0,
        sending: false,
      });
    });

    it('strips <think> tags from streaming delta text', () => {
      useChatStore.getState().handleChatEvent(DELTA_WITH_THINK_TAGS);

      const { streamText } = useChatStore.getState();
      expect(streamText).not.toBeNull();
      // streamText should contain the answer, NOT the thinking tags
      expect(streamText).toContain('I found several papers');
      expect(streamText).not.toContain('<think>');
      expect(streamText).not.toContain('</think>');
      expect(streamText).not.toContain('Let me search for relevant papers');
    });

    it('excludes thinking content blocks from streaming delta text', () => {
      useChatStore.setState({ runId: 'run-think-002' });
      useChatStore.getState().handleChatEvent(DELTA_WITH_THINKING_BLOCK);

      const { streamText } = useChatStore.getState();
      expect(streamText).not.toBeNull();
      expect(streamText).toContain('Searching for papers');
      expect(streamText).not.toContain('Searching the literature database');
    });

    it('stores clean text (no thinking) in final message', () => {
      // Need to mock the dependent stores to avoid errors during panel refresh
      vi.mock('../../stores/library', () => ({
        useLibraryStore: { getState: () => ({ loadPapers: vi.fn(), loadTags: vi.fn() }) },
      }));
      vi.mock('../../stores/tasks', () => ({
        useTasksStore: { getState: () => ({ loadTasks: vi.fn() }) },
      }));
      vi.mock('../../stores/sessions', () => ({
        useSessionsStore: { getState: () => ({ loadSessions: vi.fn() }) },
      }));
      vi.mock('../../stores/cron', () => ({
        useCronStore: { getState: () => ({ loadPresets: vi.fn() }) },
      }));
      vi.mock('../../stores/ui', () => ({
        useUiStore: {
          getState: () => ({
            triggerWorkspaceRefresh: vi.fn(),
            checkNotifications: vi.fn(),
            addNotification: vi.fn(),
          }),
        },
      }));

      useChatStore.getState().handleChatEvent(FINAL_WITH_THINK_TAGS);

      const { messages } = useChatStore.getState();
      const lastMsg = messages[messages.length - 1];
      expect(lastMsg).toBeDefined();
      // The stored text should NOT contain raw think tags
      expect(lastMsg.text).not.toContain('<think>');
      expect(lastMsg.text).not.toContain('</think>');
      expect(lastMsg.text).toContain('BERT uses masked language modeling');
    });
  });

  describe('<final> tag stripping — reasoning-tags.ts:37-55', () => {
    /**
     * <final> tags are stripped but inner content is PRESERVED.
     * Bug: After page refresh, <final> tags leaked into displayed text.
     */
    it('strips <final>...</final> tags but preserves inner content', () => {
      render(<MessageBubble message={MSG_FINAL_TAGS_IN_TEXT} />);

      expect(screen.getByText(/不客气！如果有任何需要帮忙的，随时告诉我。/)).toBeInTheDocument();

      const mainTextElements = document.querySelectorAll('.markdown-body');
      for (const el of mainTextElements) {
        expect(el.textContent).not.toContain('<final>');
        expect(el.textContent).not.toContain('</final>');
      }
    });

    it('strips <final> tags and trims surrounding whitespace', () => {
      render(<MessageBubble message={MSG_FINAL_TAGS_WITH_WHITESPACE} />);

      expect(screen.getByText(/Hello there/)).toBeInTheDocument();

      const mainTextElements = document.querySelectorAll('.markdown-body');
      for (const el of mainTextElements) {
        expect(el.textContent).not.toContain('<final>');
        expect(el.textContent).not.toContain('</final>');
      }
    });

    it('strips <final> tags from text field (not content array)', () => {
      render(<MessageBubble message={MSG_FINAL_TAGS_IN_TEXT_FIELD} />);

      expect(screen.getByText(/Here is your analysis of the paper/)).toBeInTheDocument();
      expect(screen.queryByText(/<final>/)).toBeNull();
    });
  });

  describe('<relevant-memories> tag stripping — assistant-visible-text.ts:7-41', () => {
    it('strips <relevant-memories> blocks (entire content hidden)', () => {
      render(<MessageBubble message={MSG_RELEVANT_MEMORIES_BLOCK} />);

      expect(screen.getByText(/Based on your previous interest/)).toBeInTheDocument();

      const mainTextElements = document.querySelectorAll('.markdown-body');
      for (const el of mainTextElements) {
        expect(el.textContent).not.toContain('relevant-memories');
        expect(el.textContent).not.toContain('User prefers dark mode');
      }
    });

    it('strips <relevant_memories> (underscore variant)', () => {
      render(<MessageBubble message={MSG_RELEVANT_MEMORIES_UNDERSCORE} />);

      expect(screen.getByText(/Here is your summary/)).toBeInTheDocument();

      const mainTextElements = document.querySelectorAll('.markdown-body');
      for (const el of mainTextElements) {
        expect(el.textContent).not.toContain('relevant_memories');
        expect(el.textContent).not.toContain('Internal memory note');
      }
    });
  });

  describe('combined scaffolding — full pipeline', () => {
    it('strips thinking + memory + final in one message', () => {
      render(<MessageBubble message={MSG_COMBINED_ALL_SCAFFOLDING} />);

      // Only the <final> content should be visible
      expect(screen.getByText(/significant correlation/)).toBeInTheDocument();

      const mainTextElements = document.querySelectorAll('.markdown-body');
      for (const el of mainTextElements) {
        expect(el.textContent).not.toContain('<think>');
        expect(el.textContent).not.toContain('analyze this carefully');
        expect(el.textContent).not.toContain('relevant-memories');
        expect(el.textContent).not.toContain('data scientist');
        expect(el.textContent).not.toContain('<final>');
      }
    });

    it('strips model tokens + final tags together', () => {
      render(<MessageBubble message={MSG_MODEL_TOKENS_AND_FINAL} />);

      expect(screen.getByText(/Here is the answer to your question/)).toBeInTheDocument();

      const mainTextElements = document.querySelectorAll('.markdown-body');
      for (const el of mainTextElements) {
        expect(el.textContent).not.toContain('<|assistant|>');
        expect(el.textContent).not.toContain('<|end|>');
        expect(el.textContent).not.toContain('<final>');
      }
    });
  });

  describe('Streaming deltas strip <final> tags — chat store extractText', () => {
    beforeEach(() => {
      useChatStore.setState({
        messages: [],
        streaming: false,
        streamText: null,
        runId: 'run-final-001',
        sessionKey: 'main',
        lastError: null,
        tokensIn: 0,
        tokensOut: 0,
        sending: false,
      });
    });

    it('strips <final> tags from streaming delta text', () => {
      useChatStore.getState().handleChatEvent(DELTA_WITH_FINAL_TAGS);

      const { streamText } = useChatStore.getState();
      expect(streamText).not.toBeNull();
      expect(streamText).toContain('I found several relevant papers');
      expect(streamText).not.toContain('<final>');
      expect(streamText).not.toContain('</final>');
    });

    it('stores clean text (no final tags) in final message', () => {
      useChatStore.setState({ runId: 'run-final-002' });
      useChatStore.getState().handleChatEvent(FINAL_WITH_FINAL_TAGS);

      const { messages } = useChatStore.getState();
      const lastMsg = messages[messages.length - 1];
      expect(lastMsg).toBeDefined();
      expect(lastMsg.text).not.toContain('<final>');
      expect(lastMsg.text).not.toContain('</final>');
      expect(lastMsg.text).toContain('transformer architecture revolutionized NLP');
    });
  });
});
