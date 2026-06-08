/**
 * Behavioral Parity Tests: ChatView Message Filtering & Display
 *
 * These tests verify that ChatView component correctly filters and renders
 * messages matching OpenClaw's native Lit UI behavior.
 *
 * Reference files:
 *   - openclaw/ui/src/ui/chat/grouped-render.ts (renderGroupedMessage: lines 225-288)
 *   - openclaw/ui/src/ui/chat/message-normalizer.ts (normalizeRoleForGrouping: lines 72-94)
 *   - openclaw/ui/src/ui/controllers/chat.ts (handleChatEvent: lines 262-336)
 *
 * CRITICAL: These tests use REAL gateway message formats (fixtures),
 * not hand-crafted mock data.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import ChatView from '../../components/chat/ChatView';
import { useChatStore } from '../../stores/chat';
import { useStagedWritingStore } from '../../stores/staged-writing';
import { buildInitialStageStates } from '../../utils/staged-writing-stages';
import {
  USER_MSG,
  ASSISTANT_MSG,
  ASSISTANT_EMPTY_TEXT_MSG,
  ASSISTANT_IMAGE_ONLY_MSG,
  TOOL_RESULT_MSG,
  ASSISTANT_WHITESPACE_ONLY_MSG,
  MIXED_HISTORY,
} from '../../__fixtures__/gateway-payloads/ui-events';

// ── Mock react-i18next ──────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'chat.empty': 'Start a conversation',
        'chat.you': 'You',
        'chat.assistant': 'Assistant',
        'chat.thinking': 'Thinking...',
        'chat.newMessages': 'New messages',
        'chat.dismiss': 'Dismiss',
      };
      return map[key] ?? key;
    },
    i18n: { changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

// ── Mock gateway store ──────────────────────────────────────────────

vi.mock('../../stores/gateway', () => ({
  useGatewayStore: (selector: Function) => {
    const state = { client: null, state: 'disconnected' };
    return selector(state);
  },
}));

// ── Reset store between tests ───────────────────────────────────────

beforeEach(() => {
  useChatStore.setState({
    messages: [],
    sending: false,
    streaming: false,
    streamText: null,
    runId: null,
    sessionKey: 'main',
    lastError: null,
    tokensIn: 0,
    tokensOut: 0,
  });
  useStagedWritingStore.setState({ job: null, restored: false });
});

// ── Tests ───────────────────────────────────────────────────────────

describe('ChatView message filtering — parity with grouped-render.ts:225-288', () => {
  it('keeps staged-writing progress anchored after the request that started it', () => {
    useChatStore.setState({
      messages: [
        { role: 'user', text: '请根据资料生成一篇完整小论文', timestamp: 1000 },
        { role: 'user', text: '你现在是什么基座模型', timestamp: 3000 },
        { role: 'assistant', text: '当前基座模型是 deepseek。', timestamp: 4000 },
      ],
      sessionKey: 'main',
    });
    useStagedWritingStore.setState({
      job: {
        id: 'writing-1',
        sessionKey: 'main',
        slug: 'paper-writing1',
        topic: '请根据资料生成一篇完整小论文',
        contextText: '',
        sourcePaths: [],
        venue: '',
        locale: 'zh-CN',
        outputDir: 'outputs/drafts/paper-writing1',
        startedAtMs: 1100,
        status: 'running',
        currentStageIndex: 0,
        stages: buildInitialStageStates('outputs/drafts/paper-writing1'),
        lastError: null,
      },
    });

    render(<ChatView />);

    const writingRequest = screen.getByText('请根据资料生成一篇完整小论文').closest('.chat-turn');
    const timeline = screen.getByText('stagedWriting.builtInTitle').closest('.staged-writing-timeline');
    const laterQuestion = screen.getByText('你现在是什么基座模型').closest('.chat-turn');

    expect(writingRequest).not.toBeNull();
    expect(timeline).not.toBeNull();
    expect(laterQuestion).not.toBeNull();
    expect(writingRequest!.compareDocumentPosition(timeline!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(timeline!.compareDocumentPosition(laterQuestion!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('reconstructs a missing staged-writing request from the persisted job topic', () => {
    useChatStore.setState({ messages: [], sessionKey: 'main' });
    useStagedWritingStore.setState({
      job: {
        id: 'writing-legacy',
        sessionKey: 'main',
        slug: 'paper-legacy',
        topic: '根据资料完成一篇完整小论文',
        contextText: '',
        sourcePaths: [],
        venue: '',
        locale: 'zh-CN',
        outputDir: 'outputs/drafts/paper-legacy',
        startedAtMs: 1000,
        status: 'completed',
        currentStageIndex: 6,
        stages: buildInitialStageStates('outputs/drafts/paper-legacy').map((stage) => ({
          ...stage,
          status: 'done' as const,
        })),
        lastError: null,
      },
    });

    render(<ChatView />);

    expect(screen.getByText('根据资料完成一篇完整小论文')).toBeInTheDocument();
    expect(screen.getByText('stagedWriting.builtInTitle')).toBeInTheDocument();
  });

  /**
   * OpenClaw behavior: all user messages are always rendered.
   * grouped-render.ts renders message groups where normalizeRoleForGrouping
   * returns 'user' for role 'user' (message-normalizer.ts:75-77).
   *
   * Our ChatView.tsx (line 40):
   *   if (m.role === 'user') return true;
   */
  it('renders all user messages', () => {
    useChatStore.setState({
      messages: [USER_MSG, { ...USER_MSG, text: 'Second question', timestamp: 1710400010000 }],
    });

    render(<ChatView />);

    expect(screen.getByText('Search for papers on quantum computing')).toBeInTheDocument();
    expect(screen.getByText('Second question')).toBeInTheDocument();
  });

  /**
   * OpenClaw behavior (grouped-render.ts:247-249):
   *   const markdownBase = extractedText?.trim() ? extractedText : null;
   *   const markdown = markdownBase;
   *   // If markdown is present, render the bubble with text
   *
   * Our ChatView.tsx (lines 41-42):
   *   if (m.role !== 'assistant') return false;
   *   return extractVisibleText(m).trim().length > 0 || hasImageContent(m);
   */
  it('renders assistant messages with text', () => {
    useChatStore.setState({ messages: [ASSISTANT_MSG] });

    render(<ChatView />);

    expect(screen.getByText(/I found 12 papers/)).toBeInTheDocument();
  });

  /**
   * OpenClaw behavior (grouped-render.ts:265-267):
   *   if (!markdown && !hasToolCards && !hasImages) {
   *     return nothing; // Empty messages are hidden
   *   }
   *
   * Our ChatView.tsx (line 42):
   *   return extractVisibleText(m).trim().length > 0 || hasImageContent(m);
   *   // Empty text + no images → filtered out
   */
  it('filters out assistant messages with empty text (no images)', () => {
    useChatStore.setState({ messages: [ASSISTANT_EMPTY_TEXT_MSG] });

    render(<ChatView />);

    // Should show empty state since the only message is filtered out
    expect(screen.getByText('Start a conversation')).toBeInTheDocument();
  });

  it('filters out assistant messages with whitespace-only text (no images)', () => {
    useChatStore.setState({ messages: [ASSISTANT_WHITESPACE_ONLY_MSG] });

    render(<ChatView />);

    // Should show empty state
    expect(screen.getByText('Start a conversation')).toBeInTheDocument();
  });

  /**
   * OpenClaw behavior (grouped-render.ts:241-242, 265-267):
   *   const images = extractImages(message);
   *   const hasImages = images.length > 0;
   *   // ...
   *   if (!markdown && !hasToolCards && !hasImages) {
   *     return nothing;
   *   }
   *   // IMPORTANT: images-only messages ARE rendered (line 269+)
   *
   * Our ChatView.tsx (lines 28-31, 42):
   *   function hasImageContent(msg: ChatMessage): boolean {
   *     return msg.content.some((c) => c.type === 'image' || c.type === 'image_url');
   *   }
   *   // ...
   *   return extractVisibleText(m).trim().length > 0 || hasImageContent(m);
   */
  it('shows assistant messages with images but no text', () => {
    useChatStore.setState({ messages: [ASSISTANT_IMAGE_ONLY_MSG] });

    render(<ChatView />);

    // Should NOT show empty state (image-only message is visible)
    expect(screen.queryByText('Start a conversation')).not.toBeInTheDocument();
    // Should render the assistant label
    expect(screen.getByText('Assistant')).toBeInTheDocument();
  });

  /**
   * OpenClaw behavior: toolResult messages are rendered as tool cards in a sidebar,
   * NOT in the main chat bubbles. See grouped-render.ts:261-262:
   *   if (!markdown && hasToolCards && isToolResult) {
   *     return html`${toolCards.map(...)}`;
   *   }
   *
   * Our ChatView.tsx does not render toolResult at all (filtered by role check).
   */
  it('does not render toolResult messages', () => {
    useChatStore.setState({ messages: [USER_MSG, TOOL_RESULT_MSG, ASSISTANT_MSG] });

    render(<ChatView />);

    // User and assistant visible, toolResult filtered
    expect(screen.getByText('Search for papers on quantum computing')).toBeInTheDocument();
    expect(screen.getByText(/I found 12 papers/)).toBeInTheDocument();
    // toolResult text should NOT be visible
    expect(screen.queryByText(/Quantum Paper/)).not.toBeInTheDocument();
  });

  it('renders mixed history with correct filtering', () => {
    useChatStore.setState({ messages: MIXED_HISTORY });

    render(<ChatView />);

    // USER_MSG is visible
    expect(screen.getByText('Search for papers on quantum computing')).toBeInTheDocument();
    // ASSISTANT_MSG is visible
    expect(screen.getByText(/I found 12 papers/)).toBeInTheDocument();
    // TOOL_RESULT_MSG is NOT visible
    expect(screen.queryByText(/Quantum Paper/)).not.toBeInTheDocument();
    // ASSISTANT_EMPTY_TEXT_MSG is NOT visible (no text, no images)
    // ASSISTANT_IMAGE_ONLY_MSG IS visible (has image)
    // Count "Assistant" labels — should be 2 (text + image messages)
    const assistantLabels = screen.getAllByText('Assistant');
    expect(assistantLabels).toHaveLength(2);
  });
});

describe('ChatView streaming display — parity with grouped-render.ts:74-106', () => {
  /**
   * OpenClaw behavior (grouped-render.ts:74-106):
   *   export function renderStreamingGroup(text, startedAt, ...) {
   *     return html`
   *       <div class="chat-group assistant">
   *         ${renderGroupedMessage({ role: "assistant", content: [...], ... },
   *           { isStreaming: true, ... })}
   *       </div>
   *     `;
   *   }
   *
   * Our ChatView.tsx (lines 144-148):
   *   {streaming && streamText && (
   *     <MessageBubble
   *       message={{ role: 'assistant', text: streamText, timestamp: Date.now() }}
   *       isStreaming
   *     />
   *   )}
   */
  it('shows streaming indicator during active stream', () => {
    useChatStore.setState({
      streaming: true,
      streamText: 'I am thinking about your question...',
    });

    render(<ChatView />);

    expect(screen.getByText('I am thinking about your question...')).toBeInTheDocument();
    expect(screen.getByText('Assistant')).toBeInTheDocument();
  });

  it('does not show streaming indicator when streamText is null', () => {
    useChatStore.setState({
      streaming: true,
      streamText: null,
    });

    render(<ChatView />);

    // Should show empty state since no messages and no streamText
    expect(screen.queryByText('Assistant')).not.toBeInTheDocument();
  });

  it('does not show streaming indicator when not streaming', () => {
    useChatStore.setState({
      streaming: false,
      streamText: 'leftover text',
    });

    render(<ChatView />);

    // Should not render the streaming bubble
    expect(screen.queryByText('leftover text')).not.toBeInTheDocument();
  });

  /**
   * Our ChatView.tsx (lines 152-159):
   *   {sending && (
   *     <div ...>
   *       <Spin size="small" />
   *       <Text ...>{t('chat.thinking')}</Text>
   *     </div>
   *   )}
   */
  it('shows "sending" spinner during send', () => {
    useChatStore.setState({ sending: true });

    render(<ChatView />);

    expect(screen.getByText('Thinking...')).toBeInTheDocument();
  });

  it('does not show "sending" spinner when not sending', () => {
    useChatStore.setState({ sending: false });

    render(<ChatView />);

    expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();
  });
});

describe('ChatView empty state — parity with native UI', () => {
  /**
   * Our ChatView.tsx (line 121):
   *   {messages.length === 0 && !streaming && (
   *     <div ...> ... empty state ... </div>
   *   )}
   */
  it('shows empty state when no messages and not streaming', () => {
    useChatStore.setState({ messages: [], streaming: false, streamText: null });

    render(<ChatView />);

    expect(screen.getByText('Start a conversation')).toBeInTheDocument();
  });

  it('does not show empty state when streaming', () => {
    useChatStore.setState({
      messages: [],
      streaming: true,
      streamText: 'Processing...',
    });

    render(<ChatView />);

    expect(screen.queryByText('Start a conversation')).not.toBeInTheDocument();
    expect(screen.getByText('Processing...')).toBeInTheDocument();
  });

  it('does not show empty state when messages exist', () => {
    useChatStore.setState({ messages: [USER_MSG], streaming: false });

    render(<ChatView />);

    expect(screen.queryByText('Start a conversation')).not.toBeInTheDocument();
    expect(screen.getByText('Search for papers on quantum computing')).toBeInTheDocument();
  });
});

describe('ChatView error banner', () => {
  it('shows error banner when lastError is set', () => {
    useChatStore.setState({ lastError: 'Connection lost' });

    render(<ChatView />);

    expect(screen.getByText('Connection lost')).toBeInTheDocument();
  });

  it('does not show error banner when lastError is null', () => {
    useChatStore.setState({ lastError: null });

    render(<ChatView />);

    expect(screen.queryByText('Connection lost')).not.toBeInTheDocument();
  });
});
