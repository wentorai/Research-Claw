import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Image } from 'antd';
import {
  CopyOutlined,
  CheckOutlined,
  CodeOutlined,
  ToolOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import type { ChatMessage } from '../../gateway/types';
import { safeStringifyDetail } from '../../utils/activity-log';
import { useGatewayStore } from '../../stores/gateway';
import { sanitizeUserMessage } from '../../utils/sanitize-message';
import { sanitizeAssistantMessage, sanitizeAssistantRawCopy } from '../../utils/sanitize-assistant-message';
import CodeBlock from './CodeBlock';

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

// stripUserMetaPrefix replaced by unified sanitizeUserMessage() in utils/sanitize-message.ts
// stripThinkingTags, stripModelSpecialTokens, stripFinalTags, stripMemoryTags
//   → consolidated into sanitize-assistant-message.ts (unified pipeline)

/**
 * Regex for extracting thinking content from `<think>` tags (captures inner content).
 * Source: openclaw/ui/src/ui/chat/message-extract.ts:65-68
 *   rawText.matchAll(/<\s*think(?:ing)?\s*>([\s\S]*?)<\s*\/\s*think(?:ing)?\s*>/gi)
 *
 * NOTE: This is a CAPTURING regex for extractThinking(), distinct from the
 * STRIPPING regex in sanitize-assistant-message.ts. Kept here because
 * extractThinking is a rendering concern, not sanitization.
 */
const THINK_EXTRACT_RE = /<\s*think(?:ing)?\s*>([\s\S]*?)<\s*\/\s*think(?:ing)?\s*>/gi;

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

const markdownCodeComponents = {
  code: ({ className, children, ...props }: React.ComponentPropsWithoutRef<'code'> & { className?: string }) => {
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
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{ color: 'var(--accent-secondary)' }}
    >
      {children}
    </a>
  ),
};

interface ActivityLogContentBlock {
  type: 'activity_log';
  title?: string;
  entries?: Array<string | { id?: string; text: string; status?: string; detail?: unknown }>;
}

export default function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [copied, setCopied] = useState<false | 'visible' | 'raw'>(false);
  // Stable ref so callbacks don't depend on the message object identity
  // (streaming messages create a new object every render).
  const messageRef = useRef(message);
  messageRef.current = message;

  /** Extract raw text from message (only type:'text' blocks). */
  const extractRawText = useCallback(() => {
    const msg = messageRef.current;
    return msg.text ??
      (typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content
              .filter((c) => c.type === 'text' && c.text)
              .map((c) => c.text!)
              .join('')
          : '');
  }, []);

  /** Copy visible text (all internal scaffolding stripped). */
  const handleCopy = useCallback(() => {
    if (copied) return;
    const raw = extractRawText();
    const msg = messageRef.current;
    const copyText = msg.role === 'user'
      ? sanitizeUserMessage(raw)
      : sanitizeAssistantMessage(raw);
    navigator.clipboard.writeText(stripImageMarkers(copyText)).then(() => {
      setCopied('visible');
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => { /* clipboard unavailable */ });
  }, [copied, extractRawText]);

  /** Copy full source: thinking chain + markdown raw (assistant only). */
  const handleCopyRaw = useCallback(() => {
    if (copied) return;
    const msg = messageRef.current;
    const raw = extractRawText();
    // Prepend Anthropic-format thinking blocks (type:'thinking' in content array)
    let thinkingPrefix = '';
    if (Array.isArray(msg.content)) {
      const parts = msg.content
        .filter((c) => c.type === 'thinking' && typeof (c as Record<string, unknown>).thinking === 'string')
        .map((c) => ((c as Record<string, unknown>).thinking as string).trim())
        .filter(Boolean);
      if (parts.length) {
        thinkingPrefix = `<thinking>\n${parts.join('\n')}\n</thinking>\n\n`;
      }
    }
    // Keep thinking tags in text; strip final/memory/model tokens + image markers
    const cleanedRaw = sanitizeAssistantRawCopy(raw);
    const fullText = thinkingPrefix + stripImageMarkers(cleanedRaw);
    navigator.clipboard.writeText(fullText).then(() => {
      setCopied('raw');
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => { /* clipboard unavailable */ });
  }, [copied, extractRawText]);

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

  // For user messages: strip channel injections (sanitize-message.ts)
  // For assistant messages: strip all internal scaffolding (sanitize-assistant-message.ts)
  const preText = isUser ? sanitizeUserMessage(rawText) : sanitizeAssistantMessage(rawText);

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

  // ── System message rendering (slash command results) ──
  // Centered, muted styling matching OC's injectCommandResult pattern.
  if (message.role === 'system') {
    const activityBlock = Array.isArray(message.content)
      ? message.content.find((b) => typeof b === 'object' && b?.type === 'activity_log') as ActivityLogContentBlock | undefined
      : undefined;
    if (activityBlock) {
      const rows = Array.isArray(activityBlock.entries) ? activityBlock.entries : [];
      const getRowText = (row: string | { id?: string; text: string; status?: string; detail?: unknown }) =>
        typeof row === 'string' ? row : row.text;
      const getRowStatus = (row: string | { id?: string; text: string; status?: string; detail?: unknown }) =>
        typeof row === 'string' ? '' : (row.status ?? '');
      const getRowDetail = (row: string | { id?: string; text: string; status?: string; detail?: unknown }) =>
        typeof row === 'string' ? null : (row.detail ?? null);
      const getRowId = (row: string | { id?: string; text: string; status?: string; detail?: unknown }) =>
        typeof row === 'string' ? row : (row.id ?? row.text);
      const statusIcon = (status: string) => {
        if (status.includes('error')) return <CloseCircleOutlined style={{ color: '#ef4444' }} />;
        if (status.includes('result') || status.includes('end')) return <CheckCircleOutlined style={{ color: '#22c55e' }} />;
        if (status.includes('running') || status.includes('start')) return <LoadingOutlined spin style={{ color: '#a3a3a3' }} />;
        return <ToolOutlined style={{ color: '#a3a3a3' }} />;
      };
      return (
        <div className="chat-turn chat-turn-system">
          {rows.map((row, idx) => (
            <details key={`${idx}-${getRowId(row)}`} className="chat-activity-row">
              <summary>
                <span style={{ fontSize: 11, minWidth: 10 }}>{'▸'}</span>
                <span style={{ minWidth: 14, display: 'inline-flex', justifyContent: 'center' }}>
                  {statusIcon(getRowStatus(row))}
                </span>
                <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{getRowText(row)}</span>
              </summary>
              {getRowDetail(row) && (
                <pre className="chat-activity-detail">
{safeStringifyDetail(getRowDetail(row))}
                </pre>
              )}
            </details>
          ))}
        </div>
      );
    }

    return (
      <article className="chat-turn chat-turn-system">
        <div className="chat-turn-panel">
          <header className="chat-turn-header">
            <span className="chat-turn-label">{t('chat.system')}</span>
          </header>
          <div className="chat-turn-body markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownCodeComponents}>
              {text}
            </ReactMarkdown>
          </div>
        </div>
      </article>
    );
  }

  const turnClass = isUser ? 'chat-turn-user' : 'chat-turn-assistant';

  return (
    <article className={`chat-turn ${turnClass}`}>
      <div className="chat-turn-panel">
        <header className="chat-turn-header">
          <span className="chat-turn-label">{isUser ? t('chat.you') : t('chat.assistant')}</span>
          {!isStreaming && text && (
            <div className="chat-turn-actions">
              <button
                type="button"
                onClick={handleCopy}
                aria-label={t('code.copy')}
                className={`chat-turn-action${copied === 'visible' ? ' is-copied' : ''}`}
                title={copied === 'visible' ? t('code.copied') : t('code.copy')}
              >
                {copied === 'visible' ? <CheckOutlined /> : <CopyOutlined />}
              </button>
              {!isUser && (
                <button
                  type="button"
                  onClick={handleCopyRaw}
                  aria-label={t('chat.copyRaw')}
                  className={`chat-turn-action${copied === 'raw' ? ' is-copied' : ''}`}
                  title={copied === 'raw' ? t('code.copied') : t('chat.copyRaw')}
                >
                  {copied === 'raw' ? <CheckOutlined /> : <CodeOutlined />}
                </button>
              )}
            </div>
          )}
        </header>

        <div className="chat-turn-body">
        {images.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: text ? 12 : 0 }}>
            <Image.PreviewGroup>
              {images.map((img, idx) => (
                <Image
                  key={idx}
                  src={img.url}
                  alt={img.alt ?? 'Attached image'}
                  style={{
                    maxWidth: 280,
                    maxHeight: 280,
                    borderRadius: 4,
                    objectFit: 'contain',
                    cursor: 'pointer',
                    border: '1px solid var(--border)',
                  }}
                  fallback="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgZmlsbD0iIzY2NiI+PHRleHQgeD0iMTYiIHk9IjM2IiBmb250LXNpemU9IjEyIj5JbWFnZTwvdGV4dD48L3N2Zz4="
                />
              ))}
            </Image.PreviewGroup>
          </div>
        )}

        {thinkingContent && (
          <div data-testid="thinking-section" className="chat-thinking">
            <button
              type="button"
              className="chat-thinking-toggle"
              aria-expanded={thinkingExpanded}
              onClick={() => setThinkingExpanded(!thinkingExpanded)}
            >
              <span className={`chat-thinking-chevron${thinkingExpanded ? ' is-open' : ''}`}>{'▶'}</span>
              {t('chat.thinkingLabel')}
            </button>
            {thinkingExpanded && (
              <div className="chat-thinking-content">{thinkingContent}</div>
            )}
          </div>
        )}

        {isUser ? (
          text ? <div>{text}</div> : null
        ) : (
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownCodeComponents}>
              {text}
            </ReactMarkdown>
          </div>
        )}

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
    </article>
  );
}
