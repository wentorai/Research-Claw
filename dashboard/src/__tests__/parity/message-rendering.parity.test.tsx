/**
 * Behavioral Parity Tests: Message Rendering
 *
 * These tests verify that our MessageBubble renders content
 * IDENTICALLY to OpenClaw's native Lit UI grouped-render.ts.
 *
 * Reference: openclaw/ui/src/ui/chat/grouped-render.ts
 *
 * CRITICAL: These tests use REAL gateway message formats (fixtures),
 * not hand-crafted mock data.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import MessageBubble from '../../components/chat/MessageBubble';
import {
  USER_MESSAGE_WITH_IMAGE,
  USER_MESSAGE_WITH_DATA_URL_IMAGE,
  USER_MESSAGE_WITH_IMAGE_URL,
  USER_MESSAGE_IMAGE_ONLY,
  HISTORY_MESSAGES,
  TINY_PNG_B64,
  HISTORY_ASSISTANT_WITH_WORKSPACE_IMAGE,
} from '../../__fixtures__/gateway-payloads/chat-events';
import { useGatewayStore } from '../../stores/gateway';

// Mock i18n (must include initReactI18next for i18n/index.ts import)
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'chat.you': 'You',
        'chat.assistant': 'Assistant',
      };
      return map[key] ?? key;
    },
    i18n: { changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

describe('Message rendering parity with OpenClaw native UI', () => {
  afterEach(() => {
    cleanup();
    useGatewayStore.setState({ client: null, state: 'disconnected' });
  });

  describe('Image extraction — openclaw/ui/src/ui/chat/grouped-render.ts:22-57', () => {
    it('renders base64 image from source object (sendChatMessage format)', () => {
      // OpenClaw behavior (grouped-render.ts:34-42):
      //   if (source?.type === "base64" && typeof source.data === "string")
      //     url = data.startsWith("data:") ? data : `data:${mediaType};base64,${data}`

      render(<MessageBubble message={USER_MESSAGE_WITH_IMAGE} />);

      const img = screen.getByAltText('Attached image');
      expect(img).toBeInTheDocument();
      expect(img.tagName).toBe('IMG');
      expect(img).toHaveAttribute('src', `data:image/png;base64,${TINY_PNG_B64}`);
    });

    it('renders image when data is already a data URL', () => {
      // OpenClaw behavior (grouped-render.ts:41):
      //   data.startsWith("data:") ? data : ...

      render(<MessageBubble message={USER_MESSAGE_WITH_DATA_URL_IMAGE} />);

      const img = screen.getByAltText('Attached image');
      expect(img).toBeInTheDocument();
      expect(img.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    });

    it('renders image from image_url format (OpenAI compatible)', () => {
      // OpenClaw behavior (grouped-render.ts:46-52):
      //   if (b.type === "image_url")
      //     imageUrl = b.image_url as Record<string, unknown>
      //     images.push({ url: imageUrl.url })

      render(<MessageBubble message={USER_MESSAGE_WITH_IMAGE_URL} />);

      const img = screen.getByAltText('Attached image');
      expect(img).toBeInTheDocument();
      expect(img.tagName).toBe('IMG');
    });

    it('renders image-only message (no text)', () => {
      // OpenClaw behavior: grouped-render.ts:265-267 allows images-only messages
      //   if (!markdown && !hasToolCards && !hasImages) return nothing;
      //   ← images-only IS rendered

      render(<MessageBubble message={USER_MESSAGE_IMAGE_ONLY} />);

      const img = screen.getByAltText('Attached image');
      expect(img).toBeInTheDocument();
      expect(img.tagName).toBe('IMG');
    });

    it('renders both text and image together', () => {
      render(<MessageBubble message={USER_MESSAGE_WITH_IMAGE} />);

      expect(screen.getByText('What is in this image?')).toBeInTheDocument();
      expect(screen.getByAltText('Attached image')).toBeInTheDocument();
    });

    it('renders message with no image content blocks (text-only)', () => {
      const textOnly = {
        role: 'user' as const,
        text: 'Hello world',
        timestamp: 1710400000000,
      };

      render(<MessageBubble message={textOnly} />);

      expect(screen.getByText('Hello world')).toBeInTheDocument();
      expect(screen.queryByAltText('Attached image')).toBeNull();
    });
  });

  describe('Recoverable workspace-image references', () => {
    it('retains the last successful image across a temporary missing read after reconnect', async () => {
      const firstRequest = vi.fn().mockResolvedValue({
        content: TINY_PNG_B64,
        encoding: 'base64',
        mime_type: 'image/png',
      });
      useGatewayStore.setState({ client: { request: firstRequest } as never, state: 'connected' });
      render(<MessageBubble message={HISTORY_ASSISTANT_WITH_WORKSPACE_IMAGE} />);

      const image = await screen.findByAltText('artifacts/figures/result.png');
      expect(image).toHaveAttribute('src', `data:image/png;base64,${TINY_PNG_B64}`);

      const missingRequest = vi.fn().mockRejectedValue(
        Object.assign(new Error('File not found: artifacts/figures/result.png'), { code: '-32002' }),
      );
      useGatewayStore.setState({ client: { request: missingRequest } as never });
      await waitFor(() => expect(missingRequest).toHaveBeenCalledWith(
        'rc.ws.read',
        { path: 'artifacts/figures/result.png' },
      ));

      expect(screen.getByAltText('artifacts/figures/result.png')).toHaveAttribute(
        'src',
        `data:image/png;base64,${TINY_PNG_B64}`,
      );
    });

    it('clears a cached image only after a successful read proves the marker is malformed', async () => {
      const binaryRequest = vi.fn().mockResolvedValue({
        content: TINY_PNG_B64,
        encoding: 'base64',
        mime_type: 'image/png',
      });
      useGatewayStore.setState({ client: { request: binaryRequest } as never, state: 'connected' });
      render(<MessageBubble message={HISTORY_ASSISTANT_WITH_WORKSPACE_IMAGE} />);
      await screen.findByAltText('artifacts/figures/result.png');

      const malformedRequest = vi.fn().mockResolvedValue({
        content: 'this is text, not an image',
        encoding: 'utf-8',
        mime_type: 'text/plain',
      });
      useGatewayStore.setState({ client: { request: malformedRequest } as never });

      await waitFor(() => {
        expect(screen.queryByAltText('artifacts/figures/result.png')).toBeNull();
      });
    });
  });

  describe('Text extraction', () => {
    it('uses text field when present (preferred over content)', () => {
      const msg = {
        role: 'assistant' as const,
        text: 'Preferred text',
        content: [{ type: 'text', text: 'Content text' }],
      };

      render(<MessageBubble message={msg} />);
      expect(screen.getByText('Preferred text')).toBeInTheDocument();
    });

    it('extracts text from content array when text field is absent', () => {
      const msg = {
        role: 'assistant' as const,
        content: [
          { type: 'text', text: 'First part. ' },
          { type: 'text', text: 'Second part.' },
        ],
      };

      render(<MessageBubble message={msg} />);
      expect(screen.getByText('First part. Second part.')).toBeInTheDocument();
    });

    it('handles string content field', () => {
      const msg = {
        role: 'assistant' as const,
        content: 'Plain string content',
      };

      render(<MessageBubble message={msg} />);
      expect(screen.getByText('Plain string content')).toBeInTheDocument();
    });
  });

  describe('User message prefix stripping', () => {
    it('strips [Research-Claw] context lines from user messages', () => {
      // History messages include before_prompt_build context
      const msg = {
        role: 'user' as const,
        text: '[Research-Claw] Library: 3 papers (1 unread)\n[Thu 2026-03-12 10:25 GMT+8] Find papers',
      };

      render(<MessageBubble message={msg} />);
      expect(screen.getByText('Find papers')).toBeInTheDocument();
      expect(screen.queryByText(/Research-Claw/)).toBeNull();
    });

    it('does NOT strip prefix from assistant messages', () => {
      const msg = {
        role: 'assistant' as const,
        text: '[Research-Claw] This is part of the response',
      };

      render(<MessageBubble message={msg} />);
      expect(screen.getByText(/Research-Claw/)).toBeInTheDocument();
    });
  });
});
