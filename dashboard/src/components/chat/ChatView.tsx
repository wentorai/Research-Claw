import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
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
import { selectPendingTools, useToolStreamStore } from '../../stores/tool-stream';
import { useGatewayStore } from '../../stores/gateway';
import { useConfigStore } from '../../stores/config';
import { useSessionsStore } from '../../stores/sessions';
import { useUiStore } from '../../stores/ui';
import type { ChatMessage } from '../../gateway/types';
import { normalizeSessionKey } from '../../utils/session-key';
import {
  collapseToolActivityEntries,
  fmtTime,
  safeStringifyDetail,
} from '../../utils/activity-log';
import MessageBubble from './MessageBubble';
import MessageInput from './MessageInput';
import WelcomeCard from './WelcomeCard';
import ToolActivityStream from './ToolActivityStream';
import TaskFlowTimeline from './TaskFlowTimeline';
import StagedWritingTimeline from './StagedWritingTimeline';
import AgentActivityBar from './AgentActivityBar';
import { selectTaskFlow, useTaskFlowStore } from '../../stores/task-flow';
import { useStagedWritingStore } from '../../stores/staged-writing';
import { isStagedWritingJobForSession } from '../../utils/staged-writing-run';
import { isTaskFlowVisible } from '../../utils/task-flow';
import { detectStagedWritingIntent } from '../../utils/staged-writing-detect';
import { executionKey, useExecutionTraceStore } from '../../stores/execution-trace';
import { selectSessionRunView, useSessionRunsStore } from '../../stores/session-runs';
import { resolveRunPresentationOwners } from '../../utils/run-presentation-owner';
import RunDetailsDock from './RunDetailsDock';
import { collectPaperFenceAliases, suppressProjectedFileFences } from '../../utils/card-runtime';

const { Text } = Typography;

/**
 * Distance (px) from bottom within which the user is considered "near bottom".
 * Reduced from OC's 450 to 150 — OC uses rAF deduplication (Lit batching),
 * so 450 works there. In React with per-delta useEffect, 150 is more appropriate
 * and still generous (~3-4 lines). The "New messages below" pill covers the gap.
 */
const NEAR_BOTTOM_THRESHOLD = 150;

/** Empty-state suggestion chips — clicking prefills the composer (never auto-sends). */
const SUGGESTION_CHIP_KEYS = [
  'searchRecent',
  'readPdf',
  'writeSurvey',
  'setupMonitor',
  'whatCanYouDo',
] as const;

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
  const canContinue = useChatStore((s) => s.canContinue);
  const continueRun = useChatStore((s) => s.continueRun);
  const lastErrorMeta = useChatStore((s) => s.lastErrorMeta);
  const retry = useChatStore((s) => s.retry);
  const hasResendSource = useChatStore((s) =>
    s._lastSentDraft !== null
    || s.messages.some((message) =>
      message.role === 'user'
      && (Boolean(extractVisibleText(message).trim()) || Boolean(message.references?.length)),
    ),
  );
  const loadHistory = useChatStore((s) => s.loadHistory);
  const loadSessionUsage = useChatStore((s) => s.loadSessionUsage);
  const createSession = useSessionsStore((s) => s.createSession);
  const setRightPanelTab = useUiStore((s) => s.setRightPanelTab);
  const setChatInputPrefill = useUiStore((s) => s.setChatInputPrefill);
  const pendingTools = useToolStreamStore(
    useShallow((state) => selectPendingTools(state, sessionKey)),
  );
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
  const loadExecutionRuns = useExecutionTraceStore((state) => state.loadRuns);
  const activateExecutionSession = useExecutionTraceStore((state) => state.activateSession);
  const executionPresentations = useExecutionTraceStore((state) => state.presentations);
  const runOwners = useMemo(() => resolveRunPresentationOwners(messages), [messages]);
  const runOwnerByIndex = useMemo(
    () => new Map(runOwners.map((owner) => [owner.index, owner])),
    [runOwners],
  );
  const renderedMessages = useMemo(() => messages.map((message, index) => {
    const owner = runOwnerByIndex.get(index);
    const presentation = owner
      ? executionPresentations[executionKey(sessionKey, owner.runId)]
      : undefined;
    return {
      message: presentation
        ? suppressProjectedFileFences(message, new Set(presentation.files.map((file) => file.path)))
        : message,
      selectedPaperAliases: owner ? collectPaperFenceAliases(message) : new Set<string>(),
    };
  }), [executionPresentations, messages, runOwnerByIndex, sessionKey]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    activateExecutionSession(sessionKey);
    void loadExecutionRuns(sessionKey, runOwners.map((owner) => owner.runId));
  }, [activateExecutionSession, loadExecutionRuns, runOwners, sessionKey]);

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
  const sessionRun = useSessionRunsStore(useShallow((s) => selectSessionRunView(s, sessionKey)));
  const activityActive = sessionRun.isBusy
    || sessionRun.needsResultConfirmation
    || sessionRun.resultUnconfirmed
    || pendingTools.length > 0;
  const taskFlow = useTaskFlowStore((s) => selectTaskFlow(s, sessionKey));
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
  /** The run status region already shows authoritative state + activity. */
  const showThinkingPanel = activityActive && !taskFlowVisible && !showWritingTimeline;
  const activityEntries = collapseToolActivityEntries(activityLog
    .filter((e) => normalizeSessionKey(e.sessionKey) === normalizeSessionKey(sessionKey)))
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

      const rootRect = root.getBoundingClientRect();
      const rootTop = rootRect.top;
      const rootBottom = rootRect.bottom;
      const tolerance = 1;

      // The pinned anchor is the user question whose answer currently fills the
      // top of the viewport: the highest-index user bubble scrolled fully above
      // the top edge.
      let bestIdx: number | null = null;
      for (const [idxStr, node] of Object.entries(userElRefs.current)) {
        if (!node) continue;
        const idx = Number(idxStr);
        const bottom = node.getBoundingClientRect().bottom;
        if (bottom <= rootTop + tolerance) {
          if (bestIdx === null || idx > bestIdx) bestIdx = idx;
        }
      }

      // Suppress when a LATER user turn is already visible in the viewport. Its
      // question is on screen, so a pinned copy of an earlier question (the
      // anchor floats at top:0 with z-index) would only obscure the message the
      // user is actually looking at.
      if (bestIdx !== null) {
        for (const [idxStr, node] of Object.entries(userElRefs.current)) {
          if (!node) continue;
          const idx = Number(idxStr);
          if (idx <= bestIdx) continue;
          const r = node.getBoundingClientRect();
          if (r.top < rootBottom && r.bottom > rootTop) {
            bestIdx = null;
            break;
          }
        }
      }

      if (stickyUserIndexRef.current === bestIdx) return;
      stickyUserIndexRef.current = bestIdx;
      setStickyUserMessage(bestIdx === null ? null : (messagesRef.current[bestIdx] ?? null));
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
              <Text type="secondary" style={{ fontSize: 16 }}>
                {t('chat.empty')}
              </Text>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'center',
                  gap: 8,
                  maxWidth: 620,
                  marginTop: 4,
                  padding: '0 24px',
                }}
              >
                {SUGGESTION_CHIP_KEYS.map((key) => {
                  const chipText = t(`chat.suggestions.${key}`);
                  return (
                    <button
                      key={key}
                      type="button"
                      className="chat-suggestion-chip"
                      onClick={() => setChatInputPrefill(chipText)}
                    >
                      {chipText}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Only one sticky copy: the last user input shown as a context anchor. */}
          {!isNearBottom && stickyUserMessage && (
            <div className="chat-context-sticky">
              <MessageBubble message={stickyUserMessage} />
            </div>
          )}

          {renderedMessages.map(({ message: msg, selectedPaperAliases }, idx) => (
            <React.Fragment key={idx}>
              {msg.localKind === 'welcome' ? (
                // Synthetic first-run welcome — rich hero card instead of the
                // plain bubble (the fallback text stays unrendered).
                <WelcomeCard />
              ) : msg.role === 'user' ? (
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
              {runOwnerByIndex.has(idx) && (
                <RunDetailsDock
                  sessionKey={sessionKey}
                  runId={runOwnerByIndex.get(idx)!.runId}
                  noFinal={runOwnerByIndex.get(idx)!.noFinal}
                  selectedPaperAliases={selectedPaperAliases}
                />
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
              <ToolActivityStream sessionKey={sessionKey} />
              {activityEntries.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {activityEntries.map((e) => {
                    const expanded = openActivityId === e.id;
                    const status = e.status || '';
                    const separator = e.text.lastIndexOf(':');
                    const toolName = e.toolName
                      ?? (separator >= 0 ? e.text.slice(separator + 1).trim() : e.text);
                    const activityText = status === 'tool_start'
                      ? t('chat.activityToolStarted', { name: toolName })
                      : status === 'tool_result' || status === 'tool_end'
                        ? t('chat.activityToolCompleted', { name: toolName })
                        : e.text;
                    const durationText = typeof e.durationMs === 'number'
                      ? e.durationMs >= 1_000
                        ? ` ${t('chat.activityDurationSeconds', {
                            duration: (e.durationMs / 1_000).toFixed(1),
                          })}`
                        : ` ${t('chat.activityDurationMilliseconds', {
                            duration: Math.round(e.durationMs),
                          })}`
                      : '';
                    const rowText = `${fmtTime(e.ts)} ${e.scope === 'background' ? 'BG' : 'FG'}  ${activityText}${durationText}`;
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
              description={
                <div>
                  <div>{lastError}</div>
                  {lastErrorMeta?.suggestion && (
                    <div style={{ marginTop: 4, opacity: 0.85 }}>{lastErrorMeta.suggestion}</div>
                  )}
                  {lastErrorMeta?.raw && lastErrorMeta.raw !== lastError && (
                    <details style={{ marginTop: 6 }}>
                      <summary style={{ cursor: 'pointer', fontSize: 12, opacity: 0.7 }}>
                        {t('chat.errorDetails')}
                      </summary>
                      <Text copyable code style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                        {lastErrorMeta.raw}
                      </Text>
                    </details>
                  )}
                </div>
              }
              action={
                <Space size="small">
                  {lastErrorMeta?.category === 'foreground-continue' && canContinue && (
                    <Button type="primary" size="small" onClick={continueRun}>
                      {t('chat.continueRun')}
                    </Button>
                  )}
                  {lastErrorMeta?.category === 'foreground-resend' && hasResendSource && (
                    <Button
                      type="primary"
                      size="small"
                      onClick={retry}
                      disabled={connState !== 'connected'}
                      title={connState === 'connected' ? undefined : t('chat.resendWaitingConnection')}
                    >
                      {t('chat.resend')}
                    </Button>
                  )}
                  {lastErrorMeta?.category === 'unrecoverable' && (
                    <Button type="primary" size="small" onClick={() => { void createSession(); }}>
                      {t('chat.newSession')}
                    </Button>
                  )}
                  {lastErrorMeta?.category === 'config-fixable' && (
                    <>
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
                    </>
                  )}
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
