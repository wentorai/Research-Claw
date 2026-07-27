/**
 * Behavioral Parity Tests: chatAttachmentPrefill — 附件预填通道
 *
 * Verifies that the ui store's chatAttachmentPrefill field correctly drives
 * attachment injection into MessageInput's local attachments state:
 *
 *   setChatAttachmentPrefill([att])
 *     → MessageInput effect detects non-null value
 *     → setAttachments(prev => [...prev, ...prefill])   (append, not replace)
 *     → setChatAttachmentPrefill(null)                  (one-shot reset)
 *
 * Implementation refs (this codebase):
 *   - stores/ui.ts : chatAttachmentPrefill field + setChatAttachmentPrefill setter
 *   - components/chat/MessageInput.tsx : consuming useEffect (appended after chatInputPrefill effect)
 *   - gateway/types.ts:113-123 : ChatAttachment { id, dataUrl, mimeType, wsPath? }
 *
 * NOTE: These tests exercise the store layer only (store→store contract).
 * The UI rendering path (thumbnail in DOM) is covered by the render-level tests below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import { useUiStore } from '../../stores/ui';
import { useChatStore } from '../../stores/chat';
import type { ChatAttachment } from '../../gateway/types';
import MessageInput from '../../components/chat/MessageInput';

// ─── ChatAttachment fixtures ──────────────────────────────────────────────────
// Sourced from gateway/types.ts:113-123 — field names verbatim.

/** Fixture A — image from peripherals camera (wsPath present). */
const PERIPH_ATT_A: ChatAttachment = {
  id: 'periph-att-a',
  dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==',  // gateway/types.ts:113-116
  mimeType: 'image/jpeg',
  wsPath: 'periph/d1/photo.jpg',                            // gateway/types.ts:120-123 (wsPath field)
};

/** Fixture B — PNG without wsPath (inline only). */
const PERIPH_ATT_B: ChatAttachment = {
  id: 'periph-att-b',
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  mimeType: 'image/png',
  // wsPath intentionally absent — optional field per gateway/types.ts:120-123
};

// ─── Store-layer tests (no render) ───────────────────────────────────────────

describe('chatAttachmentPrefill store contract', () => {
  beforeEach(() => {
    useUiStore.setState({
      chatAttachmentPrefill: null,
    });
  });

  it('initialises to null', () => {
    expect(useUiStore.getState().chatAttachmentPrefill).toBeNull();
  });

  it('setChatAttachmentPrefill stores the attachment array', () => {
    act(() => {
      useUiStore.getState().setChatAttachmentPrefill([PERIPH_ATT_A]);
    });
    expect(useUiStore.getState().chatAttachmentPrefill).toEqual([PERIPH_ATT_A]);
  });

  it('setChatAttachmentPrefill(null) resets to null', () => {
    act(() => {
      useUiStore.getState().setChatAttachmentPrefill([PERIPH_ATT_A]);
    });
    act(() => {
      useUiStore.getState().setChatAttachmentPrefill(null);
    });
    expect(useUiStore.getState().chatAttachmentPrefill).toBeNull();
  });

  it('stored attachment has exact ChatAttachment shape (id, dataUrl, mimeType, wsPath)', () => {
    act(() => {
      useUiStore.getState().setChatAttachmentPrefill([PERIPH_ATT_A]);
    });
    const stored = useUiStore.getState().chatAttachmentPrefill![0];
    // Verify each field name matches gateway/types.ts:113-123 verbatim
    expect(stored.id).toBe('periph-att-a');
    expect(stored.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(stored.mimeType).toBe('image/jpeg');
    expect(stored.wsPath).toBe('periph/d1/photo.jpg');
  });

  it('stored attachment without wsPath is valid (wsPath is optional)', () => {
    act(() => {
      useUiStore.getState().setChatAttachmentPrefill([PERIPH_ATT_B]);
    });
    const stored = useUiStore.getState().chatAttachmentPrefill![0];
    expect(stored.id).toBe('periph-att-b');
    expect(stored.mimeType).toBe('image/png');
    expect(stored.wsPath).toBeUndefined();
  });

  it('chatInputPrefill is unaffected by setChatAttachmentPrefill', () => {
    act(() => {
      useUiStore.getState().setChatInputPrefill('hello world');
      useUiStore.getState().setChatAttachmentPrefill([PERIPH_ATT_A]);
    });
    // text prefill must survive attachment prefill setter
    expect(useUiStore.getState().chatInputPrefill).toBe('hello world');
  });
});

// ─── Render-level tests ───────────────────────────────────────────────────────
// Render MessageInput and drive attachments via the store.
// MessageInput has many dependencies; mock the minimum set.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
    i18n: { changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('../../stores/gateway', () => ({
  useGatewayStore: (selector: (s: unknown) => unknown) => {
    const state = { client: null, state: 'disconnected' };
    return typeof selector === 'function' ? selector(state) : state;
  },
}));

vi.mock('../../stores/config', () => {
  const configState = {
    gatewayConfig: null,
    systemPromptAppend: '',
  };
  // useConfigStore must be callable as a selector hook (zustand pattern)
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

// MessageInput now derives its attach-time vision hint from useVisionSupport()
// (§13.5: composer + send pipeline share one session-aware resolver). This test
// is about attachment prefill, not vision, so mock the hook to a stable
// image-capable verdict — mirrors the pre-change primaryModelSupportsVision()=>true
// mock so attachNoVisionModel stays false and no hint interferes with the render.
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

// Mock Ant Design's App.useApp (used for modal.confirm inside MessageInput)
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

describe('MessageInput consumes chatAttachmentPrefill — render-level', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('thumbnail appears in DOM after setChatAttachmentPrefill([att])', async () => {
    render(<MessageInput />);

    act(() => {
      useUiStore.getState().setChatAttachmentPrefill([PERIPH_ATT_A]);
    });

    // Attachment thumbnails render inside .chat-attachment-thumb as <img src={dataUrl}>
    await waitFor(() => {
      // Use querySelectorAll to avoid role="img" SVG icon collisions
      const thumb = document.querySelector<HTMLImageElement>(
        `.chat-attachment-thumb img[src="${CSS.escape(PERIPH_ATT_A.dataUrl)}"]`,
      ) ?? document.querySelector<HTMLImageElement>('.chat-attachment-thumb img');
      expect(thumb).not.toBeNull();
      if (thumb) expect(thumb.src).toBe(PERIPH_ATT_A.dataUrl);
    });
  });

  it('store field resets to null after effect consumes it (one-shot)', async () => {
    render(<MessageInput />);

    act(() => {
      useUiStore.getState().setChatAttachmentPrefill([PERIPH_ATT_A]);
    });

    await waitFor(() => {
      expect(useUiStore.getState().chatAttachmentPrefill).toBeNull();
    });
  });

  it('append semantics: second prefill adds to existing attachments, both visible', async () => {
    render(<MessageInput />);

    // Inject first attachment
    act(() => {
      useUiStore.getState().setChatAttachmentPrefill([PERIPH_ATT_A]);
    });
    await waitFor(() => {
      expect(useUiStore.getState().chatAttachmentPrefill).toBeNull();
    });

    // Inject second attachment — should APPEND, not replace
    act(() => {
      useUiStore.getState().setChatAttachmentPrefill([PERIPH_ATT_B]);
    });
    await waitFor(() => {
      // Both thumbnails must be present simultaneously — append semantics
      const thumbImgs = document.querySelectorAll<HTMLImageElement>('.chat-attachment-thumb img');
      const srcs = Array.from(thumbImgs).map((img) => img.src);
      expect(srcs).toContain(PERIPH_ATT_A.dataUrl);
      expect(srcs).toContain(PERIPH_ATT_B.dataUrl);
    });
  });

  it('chatInputPrefill still works independently after chatAttachmentPrefill (no regression)', async () => {
    render(<MessageInput />);

    act(() => {
      useUiStore.getState().setChatInputPrefill('hello from skill workshop');
    });

    await waitFor(() => {
      const textarea = screen.getByRole('textbox');
      expect((textarea as HTMLTextAreaElement).value).toBe('hello from skill workshop');
    });

    // chatAttachmentPrefill must still be null (unaffected)
    expect(useUiStore.getState().chatAttachmentPrefill).toBeNull();
  });
});
