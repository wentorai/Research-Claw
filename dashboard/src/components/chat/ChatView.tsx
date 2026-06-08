import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Typography, Spin, Alert, Button, Space } from 'antd';
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
import { useSessionsStore } from '../../stores/sessions';
import { useUiStore } from '../../stores/ui';
import type { ChatMessage } from '../../gateway/types';
import { normalizeSessionKey } from '../../utils/session-key';
import { fmtActivityRow, safeStringifyDetail } from '../../utils/activity-log';
import MessageBubble from './MessageBubble';
import MessageInput from './MessageInput';
import ToolActivityStream from './ToolActivityStream';
import TaskFlowTimeline from './TaskFlowTimeline';
import StagedWritingTimeline from './StagedWritingTimeline';
import AgentActivityBar from './AgentActivityBar';
import { useTaskFlowStore } from '../../stores/task-flow';
import { useStagedWritingStore } from '../../stores/staged-writing';
import { isStagedWritingJobForSession } from '../../utils/staged-writing-run';
import { isTaskFlowVisible } from '../../utils/task-flow';
import { detectStagedWritingIntent } from '../../utils/staged-writing-detect';

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

function findTimelineAnchorIndex(
  messages: ChatMessage[],
  params: {
    startedAtMs?: number;
    anchorUserTimestamp?: number;
    anchorUserText?: string;
    anchorIdempotencyKey?: string;
    topic?: string;
    isStagedWriting?: boolean;
  },
): number {
  const anchorText = params.anchorUserText?.trim();
  const topic = params.topic?.trim();

  if (params.anchorIdempotencyKey) {
    const idx = messages.findIndex((msg) =>
      msg.role === 'user'
      && msg.idempotencyKey === params.anchorIdempotencyKey,
    );
    if (idx >= 0) return idx;
  }

  if (params.anchorUserTimestamp) {
    let nearestIdx = -1;
    let nearestDelta = Number.POSITIVE_INFINITY;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'user') continue;
      if (anchorText && extractVisibleText(msg).trim() !== anchorText) continue;
      const timestamp = typeof msg.timestamp === 'number' ? msg.timestamp : null;
      if (timestamp === null) continue;
      const delta = Math.abs(timestamp - params.anchorUserTimestamp);
      if (delta < nearestDelta && delta <= 5000) {
        nearestIdx = i;
        nearestDelta = delta;
      }
    }
    if (nearestIdx >= 0) return nearestIdx;
  }

  if (anchorText) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'user' && extractVisibleText(msg).trim() === anchorText) return i;
    }
  }

  if (params.startedAtMs) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'user') continue;
      const timestamp = typeof msg.timestamp === 'number' ? msg.timestamp : null;
      if (timestamp !== null && timestamp <= params.startedAtMs) return i;
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const text = extractVisibleText(msg).trim();
    if (!text) continue;
    if (topic && text === topic) return i;
    if (params.isStagedWriting && detectStagedWritingIntent(text)) return i;
  }

  return -1;
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
  const compacting = useChatStore((s) => s.compacting);
  const streamText = useChatStore((s) => s.streamText);
  const sending = useChatStore((s) => s.sending);
  const lastError = useChatStore((s) => s.lastError);
  const clearError = useChatStore((s) => s.clearError);
  const loadHistory = useChatStore((s) => s.loadHistory);
  const loadSessionUsage = useChatStore((s) => s.loadSessionUsage);
  const setRightPanelTab = useUiStore((s) => s.setRightPanelTab);
  const pendingTools = useToolStreamStore((s) => s.pendingTools);
  const activityLog = useToolStreamStore((s) => s.activityLog);
  const clearActivityLog = useToolStreamStore((s) => s.clearActivityLog);
  const connState = useGatewayStore((s) => s.state);
  const toolCallProbe = useConfigStore((s) => s.toolCallProbe);
  const sessionResetPolicy = useConfigStore((s) => s.sessionResetPolicy);
  const activeSessionStale = useSessionsStore((s) => s.activeSessionStale);
  const staleSendAcknowledgedKey = useSessionsStore((s) => s.staleSendAcknowledgedKey);
  const refreshActiveSessionStale = useSessionsStore((s) => s.refreshActiveSessionStale);
  const writingJob = useStagedWritingStore((s) => s.job);
  const showWritingTimeline = isStagedWritingJobForSession(writingJob, sessionKey);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<ChatMessage[]>(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Sticky "last user input" context (only one copy to avoid sticky chaos).
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [stickyUserMessage, setStickyUserMessage] = useState<ChatMessage | null>(null);
  const stickyUserIndexRef = useRef<number | null>(null);
  const userElRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const stickyRafRef = useRef<number | null>(null);

  useEffect(() => {
    refreshActiveSessionStale();
  }, [sessionResetPolicy, refreshActiveSessionStale]);

  // Smart scroll state — refs to avoid re-renders on every scroll event
  const userNearBottomRef = useRef(true);
  const [newMessagesBelow, setNewMessagesBelow] = useState(false);
  // rAF deduplication: batch rapid streaming deltas into one scroll per frame.
  // Matches OC pattern: openclaw/ui/src/ui/app-scroll.ts:19-21
  const scrollFrameRef = useRef<number | null>(null);
  const prevActivityActiveRef = useRef(false);
  const activityActive = sending || streaming || compacting || pendingTools.length > 0;
  const taskFlow = useTaskFlowStore((s) => s.flow);
  const taskFlowVisible = isTaskFlowVisible(taskFlow);
  const timelineAnchorIndex = useMemo(() => {
    if (showWritingTimeline) {
      return findTimelineAnchorIndex(messages, {
        startedAtMs: writingJob?.startedAtMs,
        topic: writingJob?.topic,
        isStagedWriting: true,
      });
    }
    if (taskFlowVisible) {
      return findTimelineAnchorIndex(messages, {
        startedAtMs: taskFlow?.startedAtMs,
        anchorUserTimestamp: taskFlow?.anchorUserTimestamp,
        anchorUserText: taskFlow?.anchorUserText,
        anchorIdempotencyKey: taskFlow?.anchorIdempotencyKey,
      });
    }
    return -1;
  }, [
    messages,
    showWritingTimeline,
    taskFlow?.startedAtMs,
    taskFlowVisible,
    writingJob?.startedAtMs,
    writingJob?.topic,
  ]);
  /** Task progress already shows coarse steps + tool detail — hide redundant thinking UI. */
  const showThinkingPanel = activityActive && !taskFlowVisible && !showWritingTimeline;
  const activityEntries = activityLog
    .filter((e) => normalizeSessionKey(e.sessionKey) === normalizeSessionKey(sessionKey))
    .slice(-30)
    .reverse();
  const [openActivityId, setOpenActivityId] = useState<string | null>(null);

  // Scroll event handler — tracks whether user is near bottom
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nextNearBottom = distanceFromBottom < NEAR_BOTTOM_THRESHOLD;
    const prevNearBottom = userNearBottomRef.current;
    userNearBottomRef.current = nextNearBottom;
    if (prevNearBottom !== nextNearBottom) setIsNearBottom(nextNearBottom);
    if (nextNearBottom) setNewMessagesBelow(false);

    // Update sticky context when user scrolls away from the bottom.
    if (nextNearBottom) {
      stickyUserIndexRef.current = null;
      setStickyUserMessage(null);
      return;
    }

    if (stickyRafRef.current !== null) cancelAnimationFrame(stickyRafRef.current);
    stickyRafRef.current = requestAnimationFrame(() => {
      stickyRafRef.current = null;
      const root = scrollRef.current;
      if (!root) return;

      const rootTop = root.getBoundingClientRect().top;
      const tolerance = 1;

      // Pin context only after the in-flow user bubble has scrolled fully above the viewport.
      let bestIdx: number | null = null;
      for (const [idxStr, node] of Object.entries(userElRefs.current)) {
        if (!node) continue;
        const idx = Number(idxStr);
        const bottom = node.getBoundingClientRect().bottom;
        if (bottom <= rootTop + tolerance) {
          if (bestIdx === null || idx > bestIdx) bestIdx = idx;
        }
      }

      if (bestIdx === null) {
        stickyUserIndexRef.current = null;
        setStickyUserMessage(null);
        return;
      }
      if (stickyUserIndexRef.current === bestIdx) return;

      stickyUserIndexRef.current = bestIdx;
      setStickyUserMessage(messagesRef.current[bestIdx] ?? null);
    });
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
    setIsNearBottom(true);
    stickyUserIndexRef.current = null;
    setStickyUserMessage(null);
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
      userElRefs.current = {};
      userNearBottomRef.current = true;
      setIsNearBottom(true);
      stickyUserIndexRef.current = null;
      setStickyUserMessage(null);
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
    <div className="chat-view">
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

      {compacting && (
        <Alert
          type="info"
          showIcon
          message={t('chat.compacting')}
          description={t('chat.compactingBanner')}
          style={{ borderRadius: 0, margin: 0 }}
        />
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
        className="chat-view-messages"
      >
        <div
          ref={scrollRef}
          className="chat-scroll"
          onScroll={handleScroll}
          onMouseDown={handleContainerMouseDown}
          onClick={handleContainerClick}
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

          {/* Only one sticky copy: the last user input shown as a context anchor. */}
          {!isNearBottom && stickyUserMessage && (
            <div className="chat-context-sticky">
              <MessageBubble message={stickyUserMessage} />
            </div>
          )}

          {messages.map((msg, idx) => (
            <React.Fragment key={idx}>
              {msg.role === 'user' ? (
                <div
                  ref={(el) => {
                    userElRefs.current[idx] = el;
                  }}
                >
                  <MessageBubble message={msg} />
                </div>
              ) : (
                <MessageBubble message={msg} />
              )}
              {timelineAnchorIndex === idx && (
                showWritingTimeline ? <StagedWritingTimeline /> : <TaskFlowTimeline />
              )}
            </React.Fragment>
          ))}

          {/* Streaming indicator */}
          {streaming && streamText && (
            <MessageBubble
              message={{ role: 'assistant', text: streamText, timestamp: Date.now() }}
              isStreaming
            />
          )}

          {timelineAnchorIndex < 0 && (
            showWritingTimeline ? (
              <>
                {writingJob?.topic && (
                  <MessageBubble
                    message={{
                      role: 'user',
                      text: writingJob.topic,
                      timestamp: writingJob.startedAtMs,
                    }}
                  />
                )}
                <StagedWritingTimeline />
              </>
            ) : <TaskFlowTimeline />
          )}

          {/* Tool stream + activity log — hidden while task progress is shown */}
          {showThinkingPanel && (
            <>
              {(sending || compacting || (streaming && !streamText)) && (
                <div className="chat-status-row">
                  <Spin size="small" />
                  <Text type="secondary" style={{ fontSize: 15 }}>
                    {compacting ? t('chat.compacting') : t('chat.thinking')}
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
                      <div key={e.id} className="chat-activity-row">
                        <button
                          type="button"
                          className="chat-activity-summary"
                          onClick={() => setOpenActivityId((prev) => (prev === e.id ? null : e.id))}
                        >
                          <span style={{ fontSize: 11, minWidth: 10 }}>
                            {expanded ? '▼' : '▶'}
                          </span>
                          <span style={{ minWidth: 14, display: 'inline-flex', justifyContent: 'center' }}>
                            {icon}
                          </span>
                          <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{rowText}</span>
                        </button>
                        {expanded && (
                          <pre className="chat-activity-detail">
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
          {!taskFlowVisible && !activityActive && (sending || compacting || (streaming && !streamText)) && (
            <div className="chat-status-row">
              <Spin size="small" />
              <Text type="secondary" style={{ fontSize: 13 }}>
                {compacting ? t('chat.compacting') : t('chat.thinking')}
              </Text>
            </div>
          )}
        </div>
      </div>

      {/* Input + banners pinned below scroll area (never overlays messages). */}
      <div className="chat-view-footer">
        {newMessagesBelow && (
          <div className="chat-new-messages-anchor">
            <button
              onClick={scrollToBottom}
              aria-label={t('chat.newMessages')}
              style={{
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
              }}
            >
              <ArrowDownOutlined style={{ fontSize: 12 }} />
              {t('chat.newMessages')}
            </button>
          </div>
        )}

        {activeSessionStale && staleSendAcknowledgedKey !== sessionKey && (
          <div style={{ padding: '8px 24px 0' }}>
            <Alert
              type="warning"
              showIcon
              message={t('chat.staleSessionBannerTitle')}
              description={t('chat.staleSessionBannerBody')}
            />
          </div>
        )}

        {lastError && (
          <div style={{ padding: '8px 24px' }}>
            <Alert
              type="error"
              showIcon
              closable
              onClose={clearError}
              message={t('chat.runIssueTitle')}
              description={lastError}
              action={
                <Space size="small">
                  <Button size="small" onClick={() => setRightPanelTab('settings')}>
                    {t('chat.openSettings')}
                  </Button>
                  <Button
                    size="small"
                    onClick={() => {
                      void loadHistory();
                      void loadSessionUsage();
                    }}
                  >
                    {t('chat.refreshHistory')}
                  </Button>
                </Space>
              }
            />
          </div>
        )}

        <MessageInput />
      </div>
    </div>
  );
}
