/**
 * Behavioral Parity Tests: Chat Send Flow
 *
 * Tests the message sending pipeline:
 *   MessageInput component -> chat store send() -> gateway RPC
 *
 * Verifies our dashboard sends chat.send RPC requests in the EXACT format
 * that OpenClaw's gateway expects, including attachment conversion,
 * user message content block construction, and state transitions.
 *
 * Reference files (OpenClaw source):
 *   - openclaw/ui/src/ui/controllers/chat.ts:152-243  (sendChatMessage)
 *   - openclaw/ui/src/ui/controllers/chat.ts:95-101   (dataUrlToBase64)
 *   - openclaw/src/gateway/server-methods/chat.ts:876-1025 (chat.send handler)
 *   - openclaw/src/gateway/server-methods/attachment-normalize.ts:10-32
 *   - openclaw/src/gateway/chat-attachments.ts:49-74  (normalizeAttachment)
 *   - openclaw/src/gateway/protocol/schema/logs-chat.ts:35-59 (ChatSendParamsSchema)
 *   - openclaw/ui/src/ui/ui-types.ts:1-5 (ChatAttachment client type)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChatStore } from '../../stores/chat';
import {
  TINY_PNG_B64,
  TINY_PNG_DATA_URL,
  TINY_JPEG_B64,
  TINY_JPEG_DATA_URL,
  CLIENT_ATTACHMENT_PNG,
  CLIENT_ATTACHMENT_JPEG,
  RPC_ATTACHMENT_PNG_WITH_FILENAME,
  USER_CONTENT_BLOCKS_TEXT_ONLY,
  USER_CONTENT_BLOCKS_WITH_IMAGE,
  USER_CONTENT_BLOCKS_MULTI_IMAGE,
  SEND_PARAMS_TEXT_ONLY,
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

// ─── Mock config store — vision capability for attachment tests ──
// The unified image pipeline (chat.ts:268-337) checks primaryModelSupportsVision()
// and hasImageModelConfigured() before sending attachments. Without this mock,
// send() returns early with an error and never calls chat.send.
vi.mock('../../stores/config', async () => {
  const { parityConfigStoreMock } = await import('./parity-config-mock');
  return parityConfigStoreMock();
});

/**
 * Find the chat.send RPC call from mock history.
 *
 * The unified image pipeline calls rc.ws.saveImage for each attachment BEFORE
 * chat.send, so we can't rely on mock.calls[0] being chat.send.
 */
function getChatSendCall() {
  return mockGatewayClient.request.mock.calls.find(
    (c: unknown[]) => c[0] === 'chat.send',
  );
}
function getChatSendParams() {
  const call = getChatSendCall();
  return call?.[1] as { idempotencyKey?: string; attachments?: Array<Record<string, unknown>>; [k: string]: unknown } | undefined;
}

describe('Chat send parity with OpenClaw native UI', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGatewayClient.isConnected = true;
    mockGatewayClient.request.mockResolvedValue({ runId: 'server-run-1' });
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

  // ════════════════════════════════════════════════════════════════
  // RPC params format
  // ════════════════════════════════════════════════════════════════

  describe('RPC params format — openclaw/src/gateway/protocol/schema/logs-chat.ts:35-59', () => {
    it('sends text-only message with required fields: message, sessionKey, idempotencyKey', async () => {
      // OpenClaw chat.ts:217-223: client.request("chat.send", { sessionKey, message, deliver, idempotencyKey, attachments })
      // Schema (logs-chat.ts:35-59): sessionKey (required), message (required), idempotencyKey (required NonEmptyString)
      await useChatStore.getState().send('Find papers about transformers');

      expect(mockGatewayClient.request).toHaveBeenCalledWith(
        'chat.send',
        expect.objectContaining({
          message: 'Find papers about transformers',
          sessionKey: 'main',
          idempotencyKey: expect.any(String),
        }),
      );

      // Verify idempotencyKey is non-empty (NonEmptyString in schema)
      const params = getChatSendParams()!;
      expect(params.idempotencyKey).toBeTruthy();
      expect(params.idempotencyKey!.length).toBeGreaterThan(0);
    });

    it('uses current sessionKey from store state', async () => {
      // OpenClaw chat.ts:218: sessionKey: state.sessionKey
      useChatStore.setState({ sessionKey: 'research-session-42' });
      await useChatStore.getState().send('hello');

      const params = getChatSendParams()!;
      expect(params.sessionKey).toBe('research-session-42');
    });

    it('omits attachments field when no attachments are provided', async () => {
      // OpenClaw chat.ts:222: attachments: apiAttachments (undefined when no attachments)
      // Schema: attachments is Type.Optional
      await useChatStore.getState().send('text only');

      const params = getChatSendParams()!;
      expect(params.attachments).toBeUndefined();
    });

    it('includes attachments array when attachments are provided', async () => {
      // OpenClaw chat.ts:200-214 + 222: builds apiAttachments from ChatAttachment[]
      await useChatStore.getState().send('What is this?', [CLIENT_ATTACHMENT_PNG]);

      const params = getChatSendParams()!;
      expect(params.attachments).toBeDefined();
      expect(params.attachments).toHaveLength(1);
    });

    it('generates a unique idempotencyKey per send', async () => {
      // OpenClaw chat.ts:194: const runId = generateUUID()
      // Used as idempotencyKey (chat.ts:221)
      await useChatStore.getState().send('first');
      await useChatStore.getState().send('second');

      const chatSendCalls = mockGatewayClient.request.mock.calls.filter(
        (c: unknown[]) => c[0] === 'chat.send',
      );
      const key1 = (chatSendCalls[0][1] as Record<string, unknown>).idempotencyKey;
      const key2 = (chatSendCalls[1][1] as Record<string, unknown>).idempotencyKey;
      expect(key1).not.toBe(key2);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // Attachment conversion: dataUrl -> raw base64
  // ════════════════════════════════════════════════════════════════

  describe('Attachment conversion — openclaw/ui/src/ui/controllers/chat.ts:199-214', () => {
    it('strips data URL prefix to get raw base64 content', async () => {
      // OpenClaw chat.ts:203: const parsed = dataUrlToBase64(att.dataUrl)
      // dataUrlToBase64 (chat.ts:95-101): regex /^data:([^;]+);base64,(.+)$/ -> { content: match[2], mimeType: match[1] }
      // Our impl (chat.ts:199): /^data:[^;]+;base64,(.+)$/ strips prefix
      await useChatStore.getState().send('check image', [CLIENT_ATTACHMENT_PNG]);

      const attachment = getChatSendParams()!.attachments![0];
      expect(attachment.content).toBe(TINY_PNG_B64);
      expect(attachment.content).not.toContain('data:');
      expect(attachment.content).not.toContain('base64,');
    });

    it('preserves mimeType from the ChatAttachment', async () => {
      // OpenClaw chat.ts:209: mimeType: parsed.mimeType
      // Gateway attachment-normalize.ts:16: mimeType: typeof a?.mimeType === "string" ? a.mimeType : undefined
      await useChatStore.getState().send('check image', [CLIENT_ATTACHMENT_PNG]);

      const attachment = getChatSendParams()!.attachments![0];
      expect(attachment.mimeType).toBe('image/png');
    });

    it('sets type to "image" for image attachments', async () => {
      // OpenClaw chat.ts:208: type: "image"
      // Gateway attachment-normalize.ts:15: type: typeof a?.type === "string" ? a.type : undefined
      await useChatStore.getState().send('check', [CLIENT_ATTACHMENT_PNG]);

      const attachment = getChatSendParams()!.attachments![0];
      expect(attachment.type).toBe('image');
    });

    it('handles JPEG attachments with correct mime and base64', async () => {
      await useChatStore.getState().send('check jpeg', [CLIENT_ATTACHMENT_JPEG]);

      const attachment = getChatSendParams()!.attachments![0];
      expect(attachment.content).toBe(TINY_JPEG_B64);
      expect(attachment.mimeType).toBe('image/jpeg');
      expect(attachment.type).toBe('image');
    });

    it('converts multiple attachments correctly', async () => {
      // OpenClaw chat.ts:201: attachments.map(...)
      await useChatStore.getState().send('compare', [
        CLIENT_ATTACHMENT_PNG,
        CLIENT_ATTACHMENT_JPEG,
      ]);

      const attachments = getChatSendParams()!.attachments!;
      expect(attachments).toHaveLength(2);
      expect(attachments[0].content).toBe(TINY_PNG_B64);
      expect(attachments[0].mimeType).toBe('image/png');
      expect(attachments[1].content).toBe(TINY_JPEG_B64);
      expect(attachments[1].mimeType).toBe('image/jpeg');
    });

    it('generates fileName with correct extension from MIME type', async () => {
      // Our addition (not in OpenClaw) — gateway accepts fileName:
      // openclaw/src/gateway/server-methods/attachment-normalize.ts:16
      // openclaw/src/gateway/chat-attachments.ts:56: att.fileName || att.type || `attachment-${idx + 1}`
      await useChatStore.getState().send('test', [CLIENT_ATTACHMENT_PNG]);

      const attachment = getChatSendParams()!.attachments![0];
      expect(attachment.fileName).toMatch(/\.png$/);
    });

    it('maps jpeg MIME to .jpg extension in fileName', async () => {
      // Our dashboard: att.mimeType.split('/')[1]?.replace('jpeg', 'jpg')
      await useChatStore.getState().send('test', [CLIENT_ATTACHMENT_JPEG]);

      const attachment = getChatSendParams()!.attachments![0];
      expect(attachment.fileName).toMatch(/\.jpg$/);
    });

    it('produces attachment format accepted by gateway normalizeAttachment', async () => {
      // Gateway chat-attachments.ts:49-73: normalizeAttachment expects
      //   - content: string (base64)
      //   - mimeType: string (optional but checked for image/)
      //   - fileName or type used as label
      // Gateway attachment-normalize.ts:19: typeof a?.content === "string" check
      await useChatStore.getState().send('test', [CLIENT_ATTACHMENT_PNG]);

      const attachment = getChatSendParams()!.attachments![0];
      // All fields must be strings (not undefined, not null, not objects)
      expect(typeof attachment.content).toBe('string');
      expect(typeof attachment.mimeType).toBe('string');
      expect(typeof attachment.type).toBe('string');
      // content must be raw base64 (gateway strips data URL prefix only if stripDataUrlPrefix=true,
      // but the UI client should already have stripped it — chat-attachments.ts:65-72)
      expect(attachment.content).not.toMatch(/^data:/);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // User message content blocks
  // ════════════════════════════════════════════════════════════════

  describe('User message content blocks — openclaw/ui/src/ui/controllers/chat.ts:168-191', () => {
    it('creates text-only content when no attachments', async () => {
      // OpenClaw chat.ts:170-172: if (msg) { contentBlocks.push({ type: "text", text: msg }) }
      // Text-only: content is undefined, text is set directly
      await useChatStore.getState().send('Find papers about transformers');

      const userMsg = useChatStore.getState().messages[0];
      expect(userMsg.role).toBe('user');
      expect(userMsg.text).toBe('Find papers about transformers');
      // Text-only messages have content: undefined in our impl
      expect(userMsg.content).toBeUndefined();
    });

    it('creates content blocks array with text + image when attachments present', async () => {
      // OpenClaw chat.ts:169: const contentBlocks = [];
      // chat.ts:170-172: push text block
      // chat.ts:174-181: push image blocks from attachments
      // chat.ts:183-190: state.chatMessages = [..., { role: "user", content: contentBlocks, timestamp }]
      await useChatStore.getState().send('What is in this image?', [CLIENT_ATTACHMENT_PNG]);

      const userMsg = useChatStore.getState().messages[0];
      expect(userMsg.role).toBe('user');
      expect(userMsg.content).toBeDefined();
      expect(Array.isArray(userMsg.content)).toBe(true);

      const blocks = userMsg.content as Array<{ type: string; text?: string; source?: unknown }>;
      expect(blocks).toHaveLength(2);

      // First block: text
      expect(blocks[0].type).toBe('text');
      expect(blocks[0].text).toBe('What is in this image?');

      // Second block: image
      expect(blocks[1].type).toBe('image');
    });

    it('stores image source with base64 type and media_type in content blocks', async () => {
      // OpenClaw chat.ts:177-180:
      //   { type: "image", source: { type: "base64", media_type: att.mimeType, data: att.dataUrl } }
      await useChatStore.getState().send('check', [CLIENT_ATTACHMENT_PNG]);

      const userMsg = useChatStore.getState().messages[0];
      const blocks = userMsg.content as Array<{ type: string; source?: Record<string, unknown> }>;
      const imageBlock = blocks[1];

      expect(imageBlock.type).toBe('image');
      const source = imageBlock.source as Record<string, unknown>;
      expect(source.type).toBe('base64');
      expect(source.media_type).toBe('image/png');
      // OpenClaw stores the full dataUrl for display purposes (chat.ts:178)
      expect(source.data).toBe(TINY_PNG_DATA_URL);
    });

    it('creates multiple image blocks for multiple attachments', async () => {
      // OpenClaw chat.ts:174-181: for (const att of attachments) { contentBlocks.push(...) }
      await useChatStore.getState().send('Compare these images', [
        CLIENT_ATTACHMENT_PNG,
        CLIENT_ATTACHMENT_JPEG,
      ]);

      const userMsg = useChatStore.getState().messages[0];
      const blocks = userMsg.content as Array<{ type: string; source?: Record<string, unknown> }>;
      expect(blocks).toHaveLength(3); // 1 text + 2 images

      expect(blocks[0].type).toBe('text');
      expect(blocks[1].type).toBe('image');
      expect(blocks[2].type).toBe('image');

      const src1 = blocks[1].source as Record<string, unknown>;
      const src2 = blocks[2].source as Record<string, unknown>;
      expect(src1.media_type).toBe('image/png');
      expect(src1.data).toBe(TINY_PNG_DATA_URL);
      expect(src2.media_type).toBe('image/jpeg');
      expect(src2.data).toBe(TINY_JPEG_DATA_URL);
    });

    it('adds user message to messages array BEFORE the RPC call', async () => {
      // OpenClaw chat.ts:183-190: state.chatMessages = [...state.chatMessages, { role: "user", ... }]
      // This happens BEFORE the try/await (chat.ts:216)
      let messagesAtRpcTime: number | undefined;
      mockGatewayClient.request.mockImplementation(() => {
        messagesAtRpcTime = useChatStore.getState().messages.length;
        return Promise.resolve({ runId: 'r1' });
      });

      await useChatStore.getState().send('hello');
      expect(messagesAtRpcTime).toBe(1);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // State transitions
  // ════════════════════════════════════════════════════════════════

  describe('State transitions — openclaw/ui/src/ui/controllers/chat.ts:192-243', () => {
    it('sets sending=true before RPC, then sending=false + streaming=true after success', async () => {
      // OpenClaw chat.ts:192: state.chatSending = true
      // chat.ts:241: state.chatSending = false (finally block)
      // Our impl transitions to streaming=true after successful response
      let sendingDuringRpc: boolean | undefined;
      mockGatewayClient.request.mockImplementation(() => {
        sendingDuringRpc = useChatStore.getState().sending;
        return Promise.resolve({ runId: 'r1' });
      });

      await useChatStore.getState().send('hello');

      expect(sendingDuringRpc).toBe(true);
      expect(useChatStore.getState().sending).toBe(false);
      expect(useChatStore.getState().streaming).toBe(true);
    });

    it('clears lastError on new send', async () => {
      // OpenClaw chat.ts:193: state.lastError = null
      useChatStore.setState({ lastError: 'previous error' });
      await useChatStore.getState().send('retry');

      // lastError is cleared regardless of success
      expect(useChatStore.getState().lastError).toBeNull();
    });

    it('clears streamText on new send', async () => {
      // OpenClaw chat.ts:196: state.chatStream = ""
      useChatStore.setState({ streamText: 'leftover partial' });
      await useChatStore.getState().send('new message');

      expect(useChatStore.getState().streamText).toBeNull();
    });

    it('sets runId BEFORE the RPC call (matches OC pattern)', async () => {
      // OpenClaw chat.ts:194-195: sets chatRunId = runId (local UUID) BEFORE request.
      // This eliminates the timing gap where early deltas could arrive with no matching runId.
      // The idempotencyKey IS the runId, set before the await.
      let runIdDuringRpc: string | null | undefined;
      mockGatewayClient.request.mockImplementation(() => {
        runIdDuringRpc = useChatStore.getState().runId;
        return Promise.resolve({});
      });

      await useChatStore.getState().send('hello');

      // runId was already set when RPC was called
      expect(runIdDuringRpc).toBeTruthy();
      expect(typeof runIdDuringRpc).toBe('string');
      // And still set after success
      expect(useChatStore.getState().runId).toBe(runIdDuringRpc);
    });

    it('uses idempotencyKey as local runId (matches OC pattern)', async () => {
      // OpenClaw chat.ts:194+221: const runId = generateUUID(); ... idempotencyKey: runId
      // The locally generated UUID is used as both chatRunId and idempotencyKey.
      await useChatStore.getState().send('hello');

      const params = getChatSendParams()!;
      expect(params.idempotencyKey).toBe(useChatStore.getState().runId);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // Error handling
  // ════════════════════════════════════════════════════════════════

  describe('Error handling — openclaw/ui/src/ui/controllers/chat.ts:225-243', () => {
    it('sets lastError from RPC failure message', async () => {
      // OpenClaw chat.ts:226: const error = String(err)
      // chat.ts:230: state.lastError = error
      mockGatewayClient.request.mockRejectedValue(new Error('Connection timeout'));
      await useChatStore.getState().send('hello');

      expect(useChatStore.getState().lastError).toBe('Connection timeout');
    });

    it('clears sending state on error', async () => {
      // OpenClaw chat.ts:241: state.chatSending = false (finally block)
      mockGatewayClient.request.mockRejectedValue(new Error('fail'));
      await useChatStore.getState().send('hello');

      expect(useChatStore.getState().sending).toBe(false);
    });

    it('clears runId and streaming on error (matches OC chat.ts:227-230)', async () => {
      // OpenClaw chat.ts:227-230: chatRunId = null, chatStream = null
      // runId was set before the RPC call, but must be cleared on failure.
      mockGatewayClient.request.mockRejectedValue(new Error('fail'));
      await useChatStore.getState().send('hello');

      expect(useChatStore.getState().streaming).toBe(false);
      expect(useChatStore.getState().streamText).toBeNull();
      expect(useChatStore.getState().runId).toBeNull();
    });

    it('returns early with lastError when not connected', async () => {
      // OpenClaw chat.ts:157-159: if (!state.client || !state.connected) { return null; }
      mockGatewayClient.isConnected = false;
      await useChatStore.getState().send('hello');

      expect(useChatStore.getState().lastError).toBe('未连接网关 — 请检查网关是否正在运行');
      expect(mockGatewayClient.request).not.toHaveBeenCalled();
    });

    it('uses generic error message for non-Error exceptions', async () => {
      // OpenClaw chat.ts:226: const error = String(err)
      // Our impl: err instanceof Error ? err.message : i18n.t('chat.sendFailed')
      mockGatewayClient.request.mockRejectedValue('string error');
      await useChatStore.getState().send('hello');

      expect(useChatStore.getState().lastError).toBe('发送失败 — 连接可能已中断，请尝试重新发送');
    });
  });

  // ════════════════════════════════════════════════════════════════
  // Guard conditions
  // ════════════════════════════════════════════════════════════════

  describe('Guard conditions — openclaw/ui/src/ui/controllers/chat.ts:157-164', () => {
    it('empty message is rejected at store level (matches OpenClaw controller guard)', async () => {
      // OpenClaw chat.ts:160-164:
      //   const msg = message.trim();
      //   const hasAttachments = attachments && attachments.length > 0;
      //   if (!msg && !hasAttachments) { return null; }
      //
      // Our store's send() now mirrors this guard: empty text + no attachments → silent return.
      // See: chat-empty-guard.parity.test.ts for full parity coverage.
      await useChatStore.getState().send('');

      expect(mockGatewayClient.request).not.toHaveBeenCalled();
      expect(useChatStore.getState().messages).toHaveLength(0);
      expect(useChatStore.getState().lastError).toBeNull();
    });

    it('does not send when client is disconnected', async () => {
      // OpenClaw chat.ts:157-159: if (!state.client || !state.connected) { return null; }
      mockGatewayClient.isConnected = false;
      await useChatStore.getState().send('hello');

      expect(mockGatewayClient.request).not.toHaveBeenCalled();
    });
  });

  // ════════════════════════════════════════════════════════════════
  // Image content blocks in sent message are renderable
  // ════════════════════════════════════════════════════════════════

  describe('Image content blocks renderability', () => {
    it('image source data is a valid data URL that can be used as img src', async () => {
      // The content blocks stored in messages are used by MessageBubble for rendering.
      // The data field must be a valid data URL for <img src={data}> to work.
      // OpenClaw chat.ts:178: data: att.dataUrl (stores the full dataUrl for display)
      await useChatStore.getState().send('check', [CLIENT_ATTACHMENT_PNG]);

      const userMsg = useChatStore.getState().messages[0];
      const blocks = userMsg.content as Array<{ type: string; source?: Record<string, unknown> }>;
      const imageBlock = blocks.find((b) => b.type === 'image');
      expect(imageBlock).toBeDefined();

      const data = (imageBlock!.source as Record<string, unknown>).data as string;
      // Must start with data: prefix to be renderable as img src
      expect(data).toMatch(/^data:image\/[a-z]+;base64,/);
      // Must contain actual base64 data after the prefix
      const b64Part = data.split(',')[1];
      expect(b64Part).toBeTruthy();
      expect(b64Part!.length).toBeGreaterThan(0);
    });

    it('content blocks preserve the same data URL used in attachment preview', async () => {
      // The preview strip in MessageInput uses att.dataUrl directly as <img src>.
      // The stored content blocks should use the same data URL for consistency.
      const att = CLIENT_ATTACHMENT_PNG;
      await useChatStore.getState().send('check', [att]);

      const userMsg = useChatStore.getState().messages[0];
      const blocks = userMsg.content as Array<{ type: string; source?: Record<string, unknown> }>;
      const imageBlock = blocks.find((b) => b.type === 'image');
      const storedData = (imageBlock!.source as Record<string, unknown>).data;

      expect(storedData).toBe(att.dataUrl);
    });
  });
});
