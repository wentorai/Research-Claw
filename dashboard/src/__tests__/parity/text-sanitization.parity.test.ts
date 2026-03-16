/**
 * Text sanitization parity tests — openclaw/src/agents/pi-embedded-utils.ts
 *
 * Verifies that Research-Claw strips leaked model control tokens from
 * assistant text BEFORE display, matching OpenClaw's stripModelSpecialTokens().
 *
 * Source: openclaw/src/agents/pi-embedded-utils.ts:49-60
 * Test ref: openclaw/src/agents/pi-embedded-utils.strip-model-special-tokens.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../../stores/chat';
import {
  DELTA_WITH_CONTROL_TOKENS,
  DELTA_WITH_FULLWIDTH_TOKENS,
  FINAL_WITH_CONTROL_TOKENS,
  DELTA_WITH_NORMAL_ANGLES,
} from '../../__fixtures__/gateway-payloads/chat-events';

describe('Model control token sanitization — pi-embedded-utils.ts:49-60', () => {
  // Reset store before each test
  beforeEach(() => {
    useChatStore.setState({
      messages: [],
      streaming: false,
      streamText: null,
      runId: null,
      lastError: null,
    });
  });

  it('strips ASCII pipe delimiters <|...|> from delta streaming text', () => {
    // GLM-5 style tokens: <|user|>, <|assistant|>
    useChatStore.getState().handleChatEvent(DELTA_WITH_CONTROL_TOKENS);
    const text = useChatStore.getState().streamText;
    expect(text).not.toContain('<|');
    expect(text).not.toContain('|>');
    expect(text).toContain('Question');
    expect(text).toContain('Here is the answer');
  });

  it('strips full-width pipe delimiters <｜...｜> from delta streaming text', () => {
    // DeepSeek style tokens (U+FF5C)
    useChatStore.getState().handleChatEvent(DELTA_WITH_FULLWIDTH_TOKENS);
    const text = useChatStore.getState().streamText;
    expect(text).not.toContain('｜');
    expect(text).toBe('Hello there');
  });

  it('strips control tokens from final message text', () => {
    // Set up runId to match the event
    useChatStore.setState({ runId: 'run-ctrl-001' });
    useChatStore.getState().handleChatEvent(FINAL_WITH_CONTROL_TOKENS);
    const lastMsg = useChatStore.getState().messages.at(-1);
    expect(lastMsg).toBeDefined();
    expect(lastMsg!.text).not.toContain('<|');
    expect(lastMsg!.text).not.toContain('|>');
    expect(lastMsg!.text).toContain('The paper discusses attention mechanisms.');
  });

  it('preserves normal angle brackets (a < b && c > d)', () => {
    useChatStore.getState().handleChatEvent(DELTA_WITH_NORMAL_ANGLES);
    const text = useChatStore.getState().streamText;
    expect(text).toBe('a < b && c > d');
  });

  it('preserves HTML-like tags (<div>hello</div>)', () => {
    useChatStore.setState({ runId: 'run-html-001' });
    useChatStore.getState().handleChatEvent({
      runId: 'run-html-001',
      sessionKey: 'main',
      state: 'delta',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '<div>hello</div>' }],
      },
    });
    const text = useChatStore.getState().streamText;
    expect(text).toBe('<div>hello</div>');
  });

  it('collapses multiple spaces after token removal', () => {
    useChatStore.getState().handleChatEvent({
      runId: 'run-spaces-001',
      sessionKey: 'main',
      state: 'delta',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello <|pad|> <|pad|> world' }],
      },
    });
    const text = useChatStore.getState().streamText;
    // Tokens replaced with spaces, then collapsed
    expect(text).not.toContain('<|');
    expect(text).not.toMatch(/  /); // no double spaces
  });
});
