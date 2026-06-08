/**
 * Behavioral Parity Tests: Empty Message Guard
 *
 * OpenClaw guards against empty messages at the CONTROLLER level
 * (sendChatMessage in controllers/chat.ts:160-164). Our dashboard
 * must do the same in the chat store's send() method, not just in
 * the MessageInput component.
 *
 * Without the store-level guard, programmatic calls to send() bypass
 * the component guard and reach the gateway, which rejects them
 * server-side — causing a bad UX (sending spinner then error).
 *
 * Reference: openclaw/ui/src/ui/controllers/chat.ts:152-164
 *
 *   export async function sendChatMessage(
 *     state: ChatState,
 *     message: string,
 *     attachments?: ChatAttachment[],
 *   ): Promise<string | null> {
 *     if (!state.client || !state.connected) {
 *       return null;
 *     }
 *     const msg = message.trim();
 *     const hasAttachments = attachments && attachments.length > 0;
 *     if (!msg && !hasAttachments) {
 *       return null;       // ← silent early return, no error, no state change
 *     }
 *     ...
 *   }
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChatStore } from '../../stores/chat';
import {
  CLIENT_ATTACHMENT_PNG,
} from '../../__fixtures__/gateway-payloads/chat-send';

// ─── Mock gateway store ──────────────────────────────────────────
const mockGatewayClient = {
  isConnected: true,
  request: vi.fn(),
};

vi.mock('../../stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({ client: mockGatewayClient, state: 'connected' }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}));

// Mock config store — vision capability for attachment tests
vi.mock('../../stores/config', async () => {
  const { parityConfigStoreMock } = await import('./parity-config-mock');
  return parityConfigStoreMock();
});

describe('Empty message guard parity — openclaw/ui/src/ui/controllers/chat.ts:160-164', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGatewayClient.isConnected = true;
    mockGatewayClient.request.mockResolvedValue({ runId: 'run-1' });
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
  });

  it('send("") with no attachments does NOT call gateway RPC — chat.ts:162-163', async () => {
    // OpenClaw: const msg = message.trim(); if (!msg && !hasAttachments) return null;
    // Empty string trims to "", which is falsy → early return, no RPC call.
    await useChatStore.getState().send('');

    expect(mockGatewayClient.request).not.toHaveBeenCalled();
  });

  it('send("  ") (whitespace only) with no attachments does NOT call gateway RPC — chat.ts:160,162', async () => {
    // OpenClaw: const msg = message.trim(); trims whitespace, resulting in ""
    // "" is falsy → early return, no RPC call.
    await useChatStore.getState().send('   ');

    expect(mockGatewayClient.request).not.toHaveBeenCalled();
  });

  it('empty text does NOT add a user message to the messages array — chat.ts:162-163', async () => {
    // OpenClaw: returns null BEFORE any state mutation (chat.ts:163 returns before line 166+)
    // No user message should be appended, no sending state set.
    await useChatStore.getState().send('');

    expect(useChatStore.getState().messages).toHaveLength(0);
  });

  it('empty text does NOT set sending state — chat.ts:162-163', async () => {
    // OpenClaw: return null happens before state.chatSending = true (chat.ts:192)
    await useChatStore.getState().send('');

    expect(useChatStore.getState().sending).toBe(false);
  });

  it('empty text does NOT set lastError — chat.ts:162-163', async () => {
    // OpenClaw: return null (not an error condition, just a no-op)
    await useChatStore.getState().send('');

    expect(useChatStore.getState().lastError).toBeNull();
  });

  it('send("") WITH attachments DOES call gateway RPC — chat.ts:161-162', async () => {
    // OpenClaw: const hasAttachments = attachments && attachments.length > 0;
    // if (!msg && !hasAttachments) → hasAttachments is true → guard does NOT trigger → RPC proceeds
    // This supports the vision model use case: image-only messages are valid.
    // Note: The unified image pipeline calls rc.ws.saveImage before chat.send,
    // so total request count is 2 (saveImage + chat.send).
    await useChatStore.getState().send('', [CLIENT_ATTACHMENT_PNG]);

    const chatSendCall = mockGatewayClient.request.mock.calls.find(
      (c: unknown[]) => c[0] === 'chat.send',
    );
    expect(chatSendCall).toBeDefined();
    expect(chatSendCall![1]).toEqual(
      expect.objectContaining({
        sessionKey: 'main',
      }),
    );
  });

  it('send("hello") proceeds normally — chat.ts:160,162', async () => {
    // OpenClaw: msg = "hello".trim() = "hello", which is truthy → guard passes → RPC call
    // Dashboard also syncs systemPromptAppend before chat.send.
    await useChatStore.getState().send('hello');

    const chatSendCall = mockGatewayClient.request.mock.calls.find(
      (c: unknown[]) => c[0] === 'chat.send',
    );
    expect(chatSendCall).toBeDefined();
    expect(chatSendCall![1]).toEqual(
      expect.objectContaining({
        message: 'hello',
        sessionKey: 'main',
      }),
    );
    expect(useChatStore.getState().messages).toHaveLength(1);
    expect(useChatStore.getState().messages[0].role).toBe('user');
  });

  it('whitespace-only text with attachments DOES call gateway RPC — chat.ts:160-162', async () => {
    // OpenClaw: msg = "  ".trim() = "", falsy BUT hasAttachments = true → guard passes
    // Note: rc.ws.saveImage + chat.send = 2 calls
    await useChatStore.getState().send('  ', [CLIENT_ATTACHMENT_PNG]);

    const chatSendCall = mockGatewayClient.request.mock.calls.find(
      (c: unknown[]) => c[0] === 'chat.send',
    );
    expect(chatSendCall).toBeDefined();
  });
});
