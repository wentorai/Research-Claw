/**
 * Behavioral parity: the composer must preserve browser-owned IME preedit text.
 *
 * Upstream reference (OpenClaw 2026.6.1):
 *   - openclaw/ui/src/ui/views/chat.ts: ComposerDraftMirror keeps the visible
 *     draft local to the textarea while the host draft is unchanged.
 *   - openclaw/ui/src/ui/views/chat.test.ts:
 *     "preserves local draft input across unrelated rerenders".
 *
 * Real failure fixture:
 *   Chrome + ToDesk + Sogou Pinyin on macOS can expose the native preedit value
 *   before React receives an input/change event. A controlled textarea then
 *   writes its stale state back during any unrelated render, preventing the
 *   first compositionstart/input sequence from bootstrapping.
 */
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MessageInput from '../../components/chat/MessageInput';
import { useChatStore } from '../../stores/chat';
import { useUiStore } from '../../stores/ui';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
    i18n: { changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('../../stores/gateway', () => ({
  useGatewayStore: (selector: (s: unknown) => unknown) => {
    const state = { client: null, state: 'connected' };
    return typeof selector === 'function' ? selector(state) : state;
  },
}));

vi.mock('../../stores/config', () => {
  const configState = { gatewayConfig: null, systemPromptAppend: '' };
  const useConfigStore = (selector: (s: typeof configState) => unknown) => selector(configState);
  useConfigStore.getState = () => configState;
  return {
    useConfigStore,
    primaryModelSupportsVision: vi.fn(() => true),
    imageModelSupportsVision: vi.fn(() => true),
  };
});

vi.mock('../../stores/sessions', () => ({
  useSessionsStore: {
    getState: () => ({
      activeSessionStale: false,
      staleSendAcknowledgedKey: null,
      acknowledgeStaleSessionSend: vi.fn(),
    }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}));

vi.mock('../../hooks/useVisionSupport', () => ({
  useVisionSupport: () => ({ supportsImage: true, source: 'config', modelRef: null }),
}));

vi.mock('../../stores/tool-stream', () => ({
  useToolStreamStore: {
    getState: () => ({ clearAll: vi.fn() }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}));

vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return {
    ...actual,
    App: {
      ...actual.App,
      useApp: () => ({
        modal: { confirm: vi.fn() },
        message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
        notification: { open: vi.fn() },
      }),
    },
  };
});

function resetStores() {
  localStorage.clear();
  useUiStore.setState({
    chatAttachmentPrefill: null,
    chatInputPrefill: null,
  });
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
}

describe('MessageInput IME preedit parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('preserves native IME preedit text across an unrelated render before input fires', () => {
    const { container } = render(<MessageInput />);
    const textarea = container.querySelector<HTMLTextAreaElement>('.chat-composer-input');
    expect(textarea).not.toBeNull();

    fireEvent.compositionStart(textarea!);
    // Chrome/ToDesk/Sogou has already put preedit text in the native control,
    // but React has not received the corresponding input event yet.
    textarea!.value = 'ni';

    act(() => {
      useChatStore.setState({ streaming: true });
    });

    expect(textarea!.value).toBe('ni');
  });

  it('commits the final composition value so later renders preserve it', () => {
    const { container } = render(<MessageInput />);
    const textarea = container.querySelector<HTMLTextAreaElement>('.chat-composer-input');
    expect(textarea).not.toBeNull();

    fireEvent.compositionStart(textarea!);
    textarea!.value = '你好';
    fireEvent.compositionEnd(textarea!, { data: '你好' });

    act(() => {
      useChatStore.setState({ streaming: true });
    });

    expect(textarea!.value).toBe('你好');
    expect(localStorage.getItem('rc-chat-draft:main')).toBe('你好');
  });
});
