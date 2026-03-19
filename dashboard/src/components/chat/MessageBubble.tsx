import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Typography, Image } from 'antd';
import { CopyOutlined, CheckOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import type { ChatMessage } from '../../gateway/types';
import { useGatewayStore } from '../../stores/gateway';
import CodeBlock from './CodeBlock';

const { Text } = Typography;

interface ImageBlock {
  url: string;
  alt?: string;
}

/** Pattern for workspace image markers embedded by chat.send image routing. */
const RC_IMAGE_RE = /\[rc-image:([\w./_-]+)\]/g;

/**
 * Extract image blocks from message content array.
 * Matches OpenClaw native UI's extractImages() in grouped-render.ts.
 * Handles both source-object format (from sendChatMessage) and image_url format (OpenAI).
 */
function extractImages(message: ChatMessage): ImageBlock[] {
  const content = message.content;
  const images: ImageBlock[] = [];

  if (!Array.isArray(content)) return images;

  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;

    if (block.type === 'image') {
      const source = block.source as Record<string, unknown> | undefined;
      if (source?.type === 'base64' && typeof source.data === 'string') {
        const data = source.data;
        const mediaType = (source.media_type as string) || 'image/png';
        const url = data.startsWith('data:') ? data : `data:${mediaType};base64,${data}`;
        images.push({ url });
      } else if (typeof block.url === 'string') {
        images.push({ url: block.url });
      }
    } else if (block.type === 'image_url') {
      const imageUrl = block.image_url as Record<string, unknown> | undefined;
      if (typeof imageUrl?.url === 'string') {
        images.push({ url: imageUrl.url });
      }
    }
  }

  return images;
}

/**
 * Strip context metadata injected by Research-Claw's before_prompt_build hook.
 * History messages from the gateway include lines like:
 *   [Research-Claw] Library: 0 papers (0 unread)
 *   [Thu 2026-03-12 10:25 GMT+8] actual message
 * We extract only the user's original text.
 */
function stripUserMetaPrefix(raw: string): string {
  const lines = raw.split('\n');
  const cleaned: string[] = [];
  for (const line of lines) {
    // Skip [Research-Claw] context lines
    if (/^\[Research-Claw\]/.test(line.trim())) continue;
    // Strip leading timestamp tag: [Thu 2026-03-12 10:25 GMT+8]
    const tsMatch = line.match(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s+GMT[+-]\d+\]\s*(.*)/);
    if (tsMatch) {
      if (tsMatch[1].length > 0) cleaned.push(tsMatch[1]);
      continue;
    }
    // Skip empty lines that were between meta lines
    if (line.trim() === '' && cleaned.length === 0) continue;
    cleaned.push(line);
  }
  return cleaned.join('\n').trim();
}

/**
 * Strip leaked model control tokens from assistant text.
 * Source: openclaw/src/agents/pi-embedded-utils.ts:49-60 (stripModelSpecialTokens)
 */
const MODEL_SPECIAL_TOKEN_RE = /<[|｜][^|｜]*[|｜]>/g;

function stripModelSpecialTokens(text: string): string {
  if (!text) return text;
  if (!MODEL_SPECIAL_TOKEN_RE.test(text)) return text;
  MODEL_SPECIAL_TOKEN_RE.lastIndex = 0;
  return text.replace(MODEL_SPECIAL_TOKEN_RE, ' ').replace(/  +/g, ' ').trim();
}

/**
 * Regex matching `<think>`, `<thinking>`, `<thought>`, `<antthinking>` tags and their content.
 * Source: openclaw/src/shared/text/reasoning-tags.ts:7 (THINKING_TAG_RE)
 * Source: openclaw/ui/src/ui/chat/message-extract.ts:66
 */
const THINK_TAG_RE = /<\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;

/**
 * Regex for extracting thinking content from `<think>` tags (captures inner content).
 * Source: openclaw/ui/src/ui/chat/message-extract.ts:65-68
 *   rawText.matchAll(/<\s*think(?:ing)?\s*>([\s\S]*?)<\s*\/\s*think(?:ing)?\s*>/gi)
 */
const THINK_EXTRACT_RE = /<\s*think(?:ing)?\s*>([\s\S]*?)<\s*\/\s*think(?:ing)?\s*>/gi;

/**
 * Strip thinking/reasoning tags from text, returning clean text for display.
 * Source: openclaw/ui/src/ui/chat/message-extract.ts:10-11
 *   if (role === "assistant") return stripThinkingTags(text);
 */
function stripThinkingTags(text: string): string {
  THINK_TAG_RE.lastIndex = 0;
  return text.replace(THINK_TAG_RE, '').trimStart();
}

/**
 * Extract thinking content from a message.
 * Matches OpenClaw behavior in message-extract.ts:41-69 (extractThinking).
 *
 * Two sources:
 * 1. Content blocks with type: 'thinking' — Anthropic format (lines 46-54)
 * 2. <think>/<thinking> tags in text — provider format (lines 65-68)
 *
 * Only extracts from assistant messages (grouped-render.ts:246).
 */
function extractThinking(message: ChatMessage): string | null {
  if (message.role !== 'assistant') return null;

  const content = message.content;
  const parts: string[] = [];

  // Source 1: Content blocks with type: 'thinking' (message-extract.ts:46-54)
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      if (
        block.type === 'thinking' &&
        typeof (block as Record<string, unknown>).thinking === 'string'
      ) {
        const cleaned = ((block as Record<string, unknown>).thinking as string).trim();
        if (cleaned) {
          parts.push(cleaned);
        }
      }
    }
  }

  if (parts.length > 0) {
    // message-extract.ts:56-58: return parts.join("\n")
    return parts.join('\n');
  }

  // Source 2: <think>/<thinking> tags in text (message-extract.ts:60-69)
  const rawText =
    message.text ??
    (typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((c) => c.type === 'text' && c.text)
            .map((c) => c.text!)
            .join('')
        : null);

  if (!rawText) return null;

  THINK_EXTRACT_RE.lastIndex = 0;
  const matches = [...rawText.matchAll(THINK_EXTRACT_RE)];
  const extracted = matches
    .map((m) => (m[1] ?? '').trim())
    .filter(Boolean);

  return extracted.length > 0 ? extracted.join('\n') : null;
}

/**
 * Hook: resolve [rc-image:...] markers in message text into displayable images.
 * Loads the image from workspace via rc.ws.read (returns base64 for binary files).
 */
function useWorkspaceImages(text: string): ImageBlock[] {
  const [wsImages, setWsImages] = useState<ImageBlock[]>([]);
  const client = useGatewayStore((s) => s.client);

  useEffect(() => {
    RC_IMAGE_RE.lastIndex = 0;
    const matches = [...text.matchAll(RC_IMAGE_RE)];
    if (matches.length === 0) { setWsImages([]); return; }

    let cancelled = false;
    (async () => {
      const loaded: ImageBlock[] = [];
      for (const m of matches) {
        const wsPath = m[1];
        try {
          const result = await client?.request<{
            content: string;
            encoding: 'utf-8' | 'base64';
            mime_type?: string;
          }>('rc.ws.read', { path: wsPath });
          if (cancelled) return;
          if (result?.encoding === 'base64') {
            const mime = result.mime_type || 'image/png';
            loaded.push({ url: `data:${mime};base64,${result.content}`, alt: wsPath });
          }
        } catch {
          // Image may have been deleted — skip silently
        }
      }
      if (!cancelled) setWsImages(loaded);
    })();

    return () => { cancelled = true; };
  }, [text, client]);

  return wsImages;
}

/** Strip [rc-image:...] markers and [User attached...] lines from display text. */
function stripImageMarkers(text: string): string {
  return text
    .replace(RC_IMAGE_RE, '')
    .replace(/\n*\[User attached \d+ image\(s\):[^\]]*\]/g, '')
    .trimEnd();
}

interface MessageBubbleProps {
  message: ChatMessage;
  isStreaming?: boolean;
}

export default function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [hovered, setHovered] = useState(false);
  // Stable ref so handleCopy doesn't depend on the message object identity
  // (streaming messages create a new object every render).
  const messageRef = useRef(message);
  messageRef.current = message;

  const handleCopy = useCallback(() => {
    if (copied) return;
    const msg = messageRef.current;
    const rawText =
      msg.text ??
      (typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content
              .filter((c) => c.type === 'text' && c.text)
              .map((c) => c.text!)
              .join('')
          : '');
    const copyText = msg.role === 'user'
      ? stripUserMetaPrefix(rawText)
      : stripModelSpecialTokens(stripThinkingTags(rawText));
    navigator.clipboard.writeText(stripImageMarkers(copyText)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => { /* clipboard unavailable */ });
  }, [copied]);

  // Extract raw text — only from type:'text' blocks (NOT type:'thinking')
  // Source: openclaw/ui/src/ui/chat/message-extract.ts:85-109 (extractRawText)
  const rawText =
    message.text ??
    (typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content
            .filter((c) => c.type === 'text' && c.text)
            .map((c) => c.text!)
            .join('')
        : '');

  // For user messages: strip meta prefix
  // For assistant messages: strip thinking tags from displayed text
  // Source: message-extract.ts:10-11 — if (role === "assistant") return stripThinkingTags(text);
  const preText = isUser ? stripUserMetaPrefix(rawText) : stripModelSpecialTokens(stripThinkingTags(rawText));

  // Strip [rc-image:...] markers from display (images rendered separately)
  const text = stripImageMarkers(preText);

  // Extract thinking content for separate rendering (assistant only)
  // Source: message-extract.ts:41-69 (extractThinking)
  // Source: grouped-render.ts:245-246 — only for assistant role
  const thinkingContent = extractThinking(message);

  // Images from content blocks (immediate send) + workspace markers (after refresh)
  const contentImages = extractImages(message);
  const wsImages = useWorkspaceImages(rawText);
  const images = contentImages.length > 0 ? contentImages : wsImages;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isUser ? 'flex-end' : 'flex-start',
        marginBottom: 16,
      }}
    >
      {/* Role label */}
      <Text
        type="secondary"
        style={{
          fontSize: 11,
          marginBottom: 4,
          fontFamily: "'Fira Code', 'JetBrains Mono', monospace",
        }}
      >
        {isUser ? t('chat.you') : t('chat.assistant')}
      </Text>

      {/* Message body */}
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          maxWidth: '80%',
          padding: '10px 14px',
          borderRadius: isUser ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
          background: isUser ? 'var(--surface-hover)' : 'var(--surface)',
          border: `1px solid ${isUser ? 'var(--border-hover)' : 'var(--border)'}`,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Copy button — hover-reveal, hidden during streaming */}
        {!isStreaming && hovered && text && (
          <button
            onClick={handleCopy}
            aria-label={t('code.copy')}
            style={{
              position: 'absolute',
              top: 6,
              right: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              padding: 0,
              border: '1px solid var(--border)',
              borderRadius: 6,
              background: 'var(--surface)',
              color: copied ? '#22C55E' : 'var(--text-tertiary)',
              cursor: 'pointer',
              fontSize: 13,
              zIndex: 1,
              transition: 'color 0.15s, background 0.15s',
            }}
            title={copied ? t('code.copied') : t('code.copy')}
          >
            {copied ? <CheckOutlined /> : <CopyOutlined />}
          </button>
        )}
        {/* Attached images */}
        {images.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: text ? 8 : 0 }}>
            <Image.PreviewGroup>
              {images.map((img, idx) => (
                <Image
                  key={idx}
                  src={img.url}
                  alt={img.alt ?? 'Attached image'}
                  style={{
                    maxWidth: 240,
                    maxHeight: 240,
                    borderRadius: 8,
                    objectFit: 'contain',
                    cursor: 'pointer',
                  }}
                  fallback="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgZmlsbD0iIzY2NiI+PHRleHQgeD0iMTYiIHk9IjM2IiBmb250LXNpemU9IjEyIj5JbWFnZTwvdGV4dD48L3N2Zz4="
                />
              ))}
            </Image.PreviewGroup>
          </div>
        )}

        {/*
         * Thinking/reasoning section — rendered BEFORE the main text.
         * Source: openclaw/ui/src/ui/chat/grouped-render.ts:273-278
         *   html`<div class="chat-thinking">...</div>`
         * Source: openclaw/ui/src/styles/chat/text.css:5-14
         *   .chat-thinking { muted, dashed border, small font }
         *
         * OpenClaw renders thinking as always-visible with muted styling.
         * We add a toggle for collapsed-by-default (improved UX for long thinking).
         */}
        {thinkingContent && (
          <div
            data-testid="thinking-section"
            style={{
              marginBottom: 10,
              padding: '8px 12px',
              borderRadius: 10,
              border: '1px dashed rgba(255, 255, 255, 0.18)',
              background: 'rgba(255, 255, 255, 0.04)',
              fontSize: 12,
              lineHeight: 1.4,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                cursor: 'pointer',
                userSelect: 'none',
                color: 'var(--muted, #888)',
                fontFamily: "'Fira Code', 'JetBrains Mono', monospace",
                fontSize: 11,
                marginBottom: thinkingExpanded ? 6 : 0,
              }}
              onClick={() => setThinkingExpanded(!thinkingExpanded)}
            >
              <span
                style={{
                  display: 'inline-block',
                  transform: thinkingExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                  transition: 'transform 0.15s ease',
                  marginRight: 6,
                  fontSize: 10,
                }}
              >
                {'▶'}
              </span>
              {t('chat.thinkingLabel')}
            </div>
            <div
              style={{
                display: thinkingExpanded ? 'block' : 'none',
                color: 'var(--muted, #888)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {thinkingContent}
            </div>
          </div>
        )}

        {isUser ? (
          text ? <Text style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 14, lineHeight: 1.6 }}>{text}</Text> : null
        ) : (
          <div
            style={{ fontSize: 14, lineHeight: 1.6, overflow: 'hidden', wordBreak: 'break-word' }}
            className="markdown-body"
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                code: ({ className, children, ...props }) => {
                  const isInline = !className;
                  if (isInline) {
                    return (
                      <code
                        style={{
                          background: 'var(--surface-active)',
                          padding: '2px 4px',
                          borderRadius: 3,
                          fontFamily: "'Fira Code', 'JetBrains Mono', monospace",
                          fontSize: '0.9em',
                        }}
                        {...props}
                      >
                        {children}
                      </code>
                    );
                  }
                  return <CodeBlock className={className}>{children}</CodeBlock>;
                },
                pre: ({ children }) => <>{children}</>,
                a: ({ href, children }) => (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--accent-secondary)' }}
                  >
                    {children}
                  </a>
                ),
              }}
            >
              {text}
            </ReactMarkdown>
          </div>
        )}

        {/* Streaming cursor */}
        {isStreaming && (
          <span
            style={{
              display: 'inline-block',
              width: 2,
              height: 16,
              background: 'var(--accent-secondary)',
              marginLeft: 2,
              animation: 'blink 0.8s step-end infinite',
              verticalAlign: 'text-bottom',
            }}
          />
        )}
      </div>
    </div>
  );
}
