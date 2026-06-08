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
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import MessageBubble from '../../components/chat/MessageBubble';
import {
  USER_MESSAGE_WITH_IMAGE,
  USER_MESSAGE_WITH_DATA_URL_IMAGE,
  USER_MESSAGE_WITH_IMAGE_URL,
  USER_MESSAGE_IMAGE_ONLY,
  HISTORY_MESSAGES,
  TINY_PNG_B64,
} from '../../__fixtures__/gateway-payloads/chat-events';

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
