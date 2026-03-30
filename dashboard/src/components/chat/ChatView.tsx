import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Typography, Spin } from 'antd';
import {
  MessageOutlined,
  ArrowDownOutlined,
  ToolOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '../../stores/chat';
import { useToolStreamStore } from '../../stores/tool-stream';
import { useGatewayStore } from '../../stores/gateway';
import { useConfigStore } from '../../stores/config';
import type { ChatMessage } from '../../gateway/types';
import { normalizeSessionKey } from '../../utils/session-key';
import { fmtActivityRow, safeStringifyDetail } from '../../utils/activity-log';
import MessageBubble from './MessageBubble';
import MessageInput from './MessageInput';
import ToolActivityStream from './ToolActivityStream';
import AgentActivityBar from './AgentActivityBar';

const { Text } = Typography;

/**
 * Distance (px) from bottom within which the user is considered "near bottom".
 * Reduced from OC's 450 to 150 — OC uses rAF deduplication (Lit batching),
 * so 450 works there. In React with per-delta useEffect, 150 is more appropriate
 * and still generous (~3-4 lines). The "New messages below" pill covers the gap.
 */
const NEAR_BOTTOM_THRESHOLD = 150;

function extractVisibleText(msg: ChatMessage): string {
  if (msg.text) return msg.text;
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!)
      .join('');
  }
  return '';
}

/** Check if a message has image content blocks */
function hasImageContent(msg: ChatMessage): boolean {
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some((c) => c.type === 'image' || c.type === 'image_url');
}

export default function ChatView() {
  const { t } = useTranslation();
  const sessionKey = useChatStore((s) => s.sessionKey);
  const rawMessages = useChatStore((s) => s.messages);
  // Filter messages for display:
  // 1. Only show 'user' and 'assistant' roles (skip toolResult, etc.)
  // 2. Skip assistant messages with no visible text (tool-call-only turns)
  const messages = rawMessages.filter((m) => {
    if (m.role === 'user') return true;
    if (m.role === 'system') return true; // Slash command results
    if (m.role !== 'assistant') return false;
    return extractVisibleText(m).trim().length > 0 || hasImageContent(m);
  });
  const streaming = useChatStore((s) => s.streaming);
  const streamText = useChatStore((s) => s.streamText);
  const sending = useChatStore((s) => s.sending);
  const lastError = useChatStore((s) => s.lastError);
  const clearError = useChatStore((s) => s.clearError);
  const pendingTools = useToolStreamStore((s) => s.pendingTools);
  const activityLog = useToolStreamStore((s) => s.activityLog);
  const clearActivityLog = useToolStreamStore((s) => s.clearActivityLog);
  const connState = useGatewayStore((s) => s.state);
  const toolCallProbe = useConfigStore((s) => s.toolCallProbe);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Smart scroll state — refs to avoid re-renders on every scroll event
  const userNearBottomRef = useRef(true);
  const [newMessagesBelow, setNewMessagesBelow] = useState(false);
  // rAF deduplication: batch rapid streaming deltas into one scroll per frame.
  // Matches OC pattern: openclaw/ui/src/ui/app-scroll.ts:19-21
  const scrollFrameRef = useRef<number | null>(null);
  const prevActivityActiveRef = useRef(false);
  const activityActive = sending || streaming || pendingTools.length > 0;
  const activityEntries = activityLog
    .filter((e) => normalizeSessionKey(e.sessionKey) === normalizeSessionKey(sessionKey))
    .slice(-30)
    .reverse();
  const [openActivityId, setOpenActivityId] = useState<string | null>(null);

  // Scroll event handler — tracks whether user is near bottom
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userNearBottomRef.current = distanceFromBottom < NEAR_BOTTOM_THRESHOLD;
    if (userNearBottomRef.current) {
      setNewMessagesBelow(false);
    }
  }, []);

  // Safari workaround: clicking blank areas in overflow:hidden containers
  // doesn't clear text selection. Explicitly clear when clicking the scroll
  // container background (not text or buttons).
  // Guard: do NOT clear if the click is the tail end of a drag-selection
  // (cross-bubble text select). Distinguish via mousedown→mouseup distance.
  const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null);
  const handleContainerMouseDown = useCallback((e: React.MouseEvent) => {
    mouseDownPosRef.current = { x: e.clientX, y: e.clientY };
  }, []);
  const handleContainerClick = useCallback((e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    // If mouse moved > 5px between down and up, this is a drag-select, not a click
    const down = mouseDownPosRef.current;
    if (down) {
      const dist = Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y);
      if (dist > 5) return;
    }
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      sel.removeAllRanges();
    }
  }, []);

  // Scroll to bottom — used by the "new messages" pill
  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
    userNearBottomRef.current = true;
    setNewMessagesBelow(false);
  }, []);

  // Smart auto-scroll: only scroll if user is near bottom.
  // Uses requestAnimationFrame deduplication to batch rapid streaming deltas
  // into a single scroll per frame. This prevents the "scroll lock" where
  // synchronous scrollTop assignments on every delta override user scroll intent.
  // Matches OC pattern: openclaw/ui/src/ui/app-scroll.ts:18-98
  useEffect(() => {
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
    }
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (scrollRef.current && userNearBottomRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      } else if (streaming) {
        setNewMessagesBelow(true);
      }
    });
  }, [messages, streamText, streaming, pendingTools]);

  // Cleanup rAF on unmount
  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, []);

  // Reset scroll tracking when a new session starts (messages cleared)
  useEffect(() => {
    if (messages.length === 0) {
      userNearBottomRef.current = true;
      setNewMessagesBelow(false);
    }
  }, [messages.length]);

  // Bind activity log lifecycle to "thinking/tool-running" lifecycle:
  // each run starts with a fresh log, and UI releases when run finishes.
  useEffect(() => {
    const prev = prevActivityActiveRef.current;
    if (!prev && activityActive) {
      clearActivityLog();
    }
    prevActivityActiveRef.current = activityActive;
  }, [activityActive, clearActivityLog]);

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg)',
      }}
    >
      {/* Background activity bar (P1-3) */}
      <AgentActivityBar />

      {/* Connection status banner — visible during reconnect/disconnect */}
      {(connState === 'reconnecting' || connState === 'disconnected') && (
        <div
          role="alert"
          style={{
            padding: '6px 16px',
            fontSize: 12,
            fontFamily: "'Fira Code', 'JetBrains Mono', Consolas, monospace",
            textAlign: 'center',
            color: connState === 'reconnecting' ? 'var(--warning, #FBBF24)' : 'var(--error, #F87171)',
            background: connState === 'reconnecting'
              ? 'rgba(251, 191, 36, 0.08)'
              : 'rgba(248, 113, 113, 0.08)',
            borderBottom: `1px solid ${connState === 'reconnecting' ? 'rgba(251, 191, 36, 0.2)' : 'rgba(248, 113, 113, 0.2)'}`,
          }}
        >
          {connState === 'reconnecting'
            ? t('chat.connectionBanner.reconnecting')
            : t('chat.connectionBanner.disconnected')}
        </div>
      )}

      {/* Tool call capability warning — model cannot generate structured tool calls */}
      {toolCallProbe?.status === 'done' && toolCallProbe.supported === false && (
        <div
          role="alert"
          style={{
            padding: '6px 16px',
            fontSize: 12,
            fontFamily: "'Fira Code', 'JetBrains Mono', Consolas, monospace",
            textAlign: 'center',
            color: 'var(--warning, #FBBF24)',
            background: 'rgba(251, 191, 36, 0.08)',
            borderBottom: '1px solid rgba(251, 191, 36, 0.2)',
          }}
        >
          {t('chat.toolCallWarning', { model: toolCallProbe.model ?? 'unknown' })}
        </div>
      )}

      {/* Message list */}
      <div
        role="log"
        aria-live="polite"
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          onMouseDown={handleContainerMouseDown}
          onClick={handleContainerClick}
          style={{
            height: '100%',
            overflow: 'auto',
            padding: '16px 24px',
          }}
        >
          {messages.length === 0 && !streaming && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                gap: 12,
              }}
            >
              <MessageOutlined
                style={{ fontSize: 48, color: 'var(--text-tertiary)', opacity: 0.5 }}
              />
              <Text type="secondary">{t('chat.empty')}</Text>
            </div>
          )}

          {messages.map((msg, idx) => (
            <MessageBubble key={idx} message={msg} />
          ))}

          {/* Streaming indicator */}
          {streaming && streamText && (
            <MessageBubble
              message={{ role: 'assistant', text: streamText, timestamp: Date.now() }}
              isStreaming
            />
          )}

          {/* Tool stream + activity log are lifecycle-bound to thinking/running */}
          {activityActive && (
            <>
              {(sending || (streaming && !streamText)) && (
                <div style={{ padding: '8px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Spin size="small" />
                  <Text type="secondary" style={{ fontSize: 13 }}>
                    {t('chat.thinking')}
                  </Text>
                </div>
              )}
              <ToolActivityStream />
              {activityEntries.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {activityEntries.map((e) => {
                    const rowText = fmtActivityRow(e);
                    const expanded = openActivityId === e.id;
                    const status = e.status || '';
                    const icon = status.includes('error')
                      ? <CloseCircleOutlined style={{ color: '#ef4444' }} />
                      : (status.includes('result') || status.includes('end'))
                        ? <CheckCircleOutlined style={{ color: '#22c55e' }} />
                        : (status.includes('running') || status.includes('start'))
                          ? <LoadingOutlined spin style={{ color: '#a3a3a3' }} />
                          : <ToolOutlined style={{ color: '#a3a3a3' }} />;
                    const detailObj = {
                      runId: e.runId,
                      toolCallId: e.toolCallId,
                      scope: e.scope,
                      status: e.status,
                      durationMs: e.durationMs,
                      detail: e.detail ?? 'No detailed params',
                    };

                    return (
                      <div
                        key={e.id}
                        style={{
                          marginBottom: 8,
                          borderRadius: 8,
                          border: '1px solid rgba(0,0,0,0.08)',
                          background: 'rgba(0,0,0,0.03)',
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => setOpenActivityId((prev) => (prev === e.id ? null : e.id))}
                          style={{
                            width: '100%',
                            border: 'none',
                            background: 'transparent',
                            padding: '10px 12px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            color: 'var(--text-tertiary)',
                            fontSize: 12,
                            fontFamily: "'Fira Code', 'JetBrains Mono', monospace",
                            cursor: 'pointer',
                            textAlign: 'left',
                          }}
                        >
                          <span style={{ color: 'var(--text-tertiary)', fontSize: 11, minWidth: 10 }}>
                            {expanded ? '▼' : '▶'}
                          </span>
                          <span style={{ fontSize: 12, minWidth: 14, display: 'inline-flex', justifyContent: 'center' }}>
                            {icon}
                          </span>
                          <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{rowText}</span>
                        </button>
                        {expanded && (
                          <pre
                            style={{
                              margin: '0 12px 10px 34px',
                              padding: 8,
                              borderRadius: 6,
                              background: 'var(--code-bg, rgba(0,0,0,0.06))',
                              border: '1px solid rgba(0,0,0,0.1)',
                              fontSize: 11,
                              lineHeight: 1.4,
                              color: 'var(--text-tertiary)',
                              overflowX: 'auto',
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                            }}
                          >
{safeStringifyDetail(detailObj)}
                          </pre>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
          {/* Sending / waiting-for-first-delta indicator (only when no activity panel). */}
          {!activityActive && (sending || (streaming && !streamText)) && (
            <div style={{ padding: '8px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Spin size="small" />
              <Text type="secondary" style={{ fontSize: 13 }}>
                {t('chat.thinking')}
              </Text>
            </div>
          )}
        </div>
      </div>

      {/* "New messages below" pill — shown when user scrolls up during streaming */}
      {newMessagesBelow && (
        <div style={{ position: 'relative', height: 0, overflow: 'visible' }}>
          <button
            onClick={scrollToBottom}
            aria-label={t('chat.newMessages')}
            style={{
              position: 'absolute',
              bottom: 8,
              left: '50%',
              transform: 'translateX(-50%)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 16px',
              background: 'var(--surface-hover, rgba(255,255,255,0.08))',
              border: '1px solid var(--border, rgba(255,255,255,0.1))',
              borderRadius: 9999,
              color: 'var(--text-secondary, #a1a1aa)',
              fontSize: 12,
              cursor: 'pointer',
              backdropFilter: 'blur(8px)',
              boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
              transition: 'background 0.15s, color 0.15s',
              zIndex: 10,
            }}
          >
            <ArrowDownOutlined style={{ fontSize: 12 }} />
            {t('chat.newMessages')}
          </button>
        </div>
      )}

      {/* Error banner */}
      {lastError && (
        <div
          style={{
            padding: '8px 24px',
            background: 'rgba(239, 68, 68, 0.1)',
            borderTop: '1px solid var(--error)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Text style={{ color: 'var(--error)', fontSize: 13 }}>{lastError}</Text>
          <button
            onClick={clearError}
            aria-label={t('chat.dismiss')}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--error)',
              cursor: 'pointer',
              fontSize: 16,
              padding: '0 4px',
            }}
          >
            &times;
          </button>
        </div>
      )}

      {/* Input area */}
      <MessageInput />
    </div>
  );
}
