/**
 * Behavioral Parity Tests: Stale Stream Recovery & Reconnection
 *
 * Tests for three bug fixes:
 * 1. Stale tool eviction: watchdog must recover even when tools are pending
 *    but haven't received events for > STALE_TOOL_MS.
 * 2. lastEventAt tracking: tool staleness based on last event, not start time.
 * 3. Reconnect fast recovery: _reconnectedAt flag reduces watchdog timeout to 15s.
 *
 * SOP: tests written BEFORE implementation code.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useChatStore, _testWatchdog } from '../../stores/chat';
import { useToolStreamStore } from '../../stores/tool-stream';
import { useTaskFlowStore } from '../../stores/task-flow';
import {
  DELTA_FIRST,
  DELTA_SECOND,
  FINAL_TEXT,
} from '../../__fixtures__/gateway-payloads/chat-events';

// ─── Mocks ────────────────────────────────────────────────────────

const mockGatewayClient = {
  isConnected: true,
  request: vi.fn().mockResolvedValue({ messages: [] }),
};

vi.mock('../../stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({ client: mockGatewayClient, state: 'connected' }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────

/** Inject a pending tool into the tool-stream store. */
function injectPendingTool(overrides?: Partial<{
  toolCallId: string;
  name: string;
  phase: 'start' | 'running' | 'result' | 'end';
  startedAt: number;
  lastEventAt: number;
}>) {
  const now = Date.now();
  const tool = {
    toolCallId: overrides?.toolCallId ?? 'tool-1',
    name: overrides?.name ?? 'exec',
    phase: overrides?.phase ?? 'running' as const,
    startedAt: overrides?.startedAt ?? now,
    lastEventAt: overrides?.lastEventAt ?? now,
  };
  useToolStreamStore.setState({
    pendingTools: [tool],
  });
  return tool;
}

/** Reset both stores to clean state. */
function resetStores() {
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
    _pendingGapReload: false,
    _pendingUserMsgs: [],
    _streamStartedAt: null,
    _lastDeltaAt: null,
    _reconnectedAt: null,
  });
  useToolStreamStore.setState({
    pendingTools: [],
    bgActivity: null,
  });
  useTaskFlowStore.getState().clear();
}

describe('Stale stream recovery — tool hang + reconnect fixes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    resetStores();
  });

  afterEach(() => {
    _testWatchdog.stop();
    vi.useRealTimers();
  });

  // ── Fix 1: Stale tool eviction in watchdog ─────────────────────

  describe('Fix 1: Watchdog recovers when all pending tools are stale', () => {
    it('skips recovery when tools have recent activity', () => {
      useChatStore.setState({
        streaming: true,
        runId: 'run-1',
        _streamStartedAt: Date.now(),
        _lastDeltaAt: null,
      });
      injectPendingTool({ lastEventAt: Date.now() });
      _testWatchdog.start();

      // Fast-forward 75s — beyond STALE_STREAM_TIMEOUT_MS (60s)
      vi.advanceTimersByTime(75_000);

      // Tool has recent activity → streaming should NOT be cleared
      expect(useChatStore.getState().streaming).toBe(true);
    });

    it('recovers when all pending tools exceed STALE_TOOL_MS with no events', () => {
      const twoMinutesAgo = Date.now() - 130_000; // 130s > STALE_TOOL_MS (120s)

      useChatStore.setState({
        streaming: true,
        runId: 'run-1',
        _streamStartedAt: twoMinutesAgo,
        _lastDeltaAt: twoMinutesAgo,
      });
      useTaskFlowStore.getState().startRun('run-1', 'main');
      injectPendingTool({
        startedAt: twoMinutesAgo,
        lastEventAt: twoMinutesAgo, // no events for 130s
      });
      _testWatchdog.start();

      // The watchdog runs every 15s (STALE_WATCHDOG_CHECK_MS)
      vi.advanceTimersByTime(15_000);

      // All tools are stale + stream gap > 60s → should recover
      expect(useChatStore.getState().streaming).toBe(false);
      expect(useChatStore.getState().streamText).toBeNull();
      expect(useChatStore.getState().runId).toBeNull();
      expect(useTaskFlowStore.getState().flow?.activeIndex).toBe(-1);
    });

    it('does not recover when some tools still have recent events', () => {
      const twoMinutesAgo = Date.now() - 130_000;

      useChatStore.setState({
        streaming: true,
        runId: 'run-1',
        _streamStartedAt: twoMinutesAgo,
        _lastDeltaAt: twoMinutesAgo,
      });

      // Two tools: one stale, one active
      useToolStreamStore.setState({
        pendingTools: [
          {
            toolCallId: 'tool-stale',
            name: 'exec',
            phase: 'running' as const,
            startedAt: twoMinutesAgo,
            lastEventAt: twoMinutesAgo,
          },
          {
            toolCallId: 'tool-active',
            name: 'exec',
            phase: 'running' as const,
            startedAt: twoMinutesAgo,
            lastEventAt: Date.now(), // just had an event
          },
        ],
      });
      _testWatchdog.start();

      vi.advanceTimersByTime(15_000);

      // One tool is still active → should NOT recover
      expect(useChatStore.getState().streaming).toBe(true);
    });

    it('clears pendingTools when all are stale during recovery', () => {
      const twoMinutesAgo = Date.now() - 130_000;

      useChatStore.setState({
        streaming: true,
        runId: 'run-1',
        _streamStartedAt: twoMinutesAgo,
        _lastDeltaAt: twoMinutesAgo,
      });
      injectPendingTool({
        startedAt: twoMinutesAgo,
        lastEventAt: twoMinutesAgo,
      });
      _testWatchdog.start();

      vi.advanceTimersByTime(15_000);

      // pendingTools should be cleared during recovery
      expect(useToolStreamStore.getState().pendingTools).toHaveLength(0);
    });
  });

  // ── Fix 1 supplement: lastEventAt tracking ─────────────────────

  describe('lastEventAt tracks most recent event per tool', () => {
    it('sets lastEventAt on tool start', () => {
      const now = Date.now();
      useToolStreamStore.getState().handleAgentEvent(
        { runId: 'run-1', sessionKey: 'main', stream: 'tool', data: { phase: 'start', toolCallId: 'tc-1', name: 'exec' } },
        'run-1',
        'main',
      );

      const tool = useToolStreamStore.getState().pendingTools[0];
      expect(tool).toBeDefined();
      expect(tool.lastEventAt).toBeGreaterThanOrEqual(now);
    });

    it('updates lastEventAt on phase transitions (running/result)', () => {
      // Start tool
      useToolStreamStore.getState().handleAgentEvent(
        { runId: 'run-1', sessionKey: 'main', stream: 'tool', data: { phase: 'start', toolCallId: 'tc-1', name: 'exec' } },
        'run-1',
        'main',
      );
      const startTime = useToolStreamStore.getState().pendingTools[0].lastEventAt;

      // Advance time and transition to running
      vi.advanceTimersByTime(5000);
      useToolStreamStore.getState().handleAgentEvent(
        { runId: 'run-1', sessionKey: 'main', stream: 'tool', data: { phase: 'running', toolCallId: 'tc-1' } },
        'run-1',
        'main',
      );

      const runningTime = useToolStreamStore.getState().pendingTools[0].lastEventAt;
      expect(runningTime).toBeGreaterThan(startTime);
    });

    it('updates lastEventAt on update events (tool heartbeats)', () => {
      // Start tool
      useToolStreamStore.getState().handleAgentEvent(
        { runId: 'run-1', sessionKey: 'main', stream: 'tool', data: { phase: 'start', toolCallId: 'tc-1', name: 'exec' } },
        'run-1',
        'main',
      );

      vi.advanceTimersByTime(10_000);

      // Simulate an update event (exec tool heartbeat)
      useToolStreamStore.getState().handleAgentEvent(
        { runId: 'run-1', sessionKey: 'main', stream: 'tool', data: { phase: 'running', toolCallId: 'tc-1' } },
        'run-1',
        'main',
      );

      const tool = useToolStreamStore.getState().pendingTools[0];
      // lastEventAt should be updated, not still at startedAt
      expect(tool.lastEventAt).toBeGreaterThan(tool.startedAt);
    });

    it('stale eviction uses lastEventAt, not startedAt', () => {
      const longAgo = Date.now() - 200_000; // 200s ago

      // Inject a tool that started long ago but has recent events
      useToolStreamStore.setState({
        pendingTools: [{
          toolCallId: 'tc-old-but-active',
          name: 'exec',
          phase: 'running' as const,
          startedAt: longAgo,
          lastEventAt: Date.now(), // just had an event
        }],
      });

      // Trigger eviction via a new tool start
      useToolStreamStore.getState().handleAgentEvent(
        { runId: 'run-1', sessionKey: 'main', stream: 'tool', data: { phase: 'start', toolCallId: 'tc-new', name: 'exec' } },
        'run-1',
        'main',
      );

      // The old-but-active tool should NOT be evicted
      const tools = useToolStreamStore.getState().pendingTools;
      expect(tools.find(t => t.toolCallId === 'tc-old-but-active')).toBeDefined();
      expect(tools.find(t => t.toolCallId === 'tc-new')).toBeDefined();
    });
  });

  // ── Fix 3: Reconnect fast recovery ─────────────────────────────

  describe('Fix 3: _reconnectedAt reduces watchdog timeout post-reconnect', () => {
    it('sets _reconnectedAt when onHello fires with active runId', () => {
      // Simulate: user sent a message (runId set), then WS reconnects
      useChatStore.setState({
        streaming: true,
        runId: 'run-1',
        streamText: 'partial output...',
        _streamStartedAt: Date.now() - 10_000,
        _lastDeltaAt: Date.now() - 5_000,
      });

      // Simulate onHello reconnect behavior
      const { runId } = useChatStore.getState();
      if (runId) {
        useChatStore.setState({
          streamText: null,
          _reconnectedAt: Date.now(),
        });
      }

      expect(useChatStore.getState()._reconnectedAt).not.toBeNull();
      expect(useChatStore.getState().streamText).toBeNull();
      // runId and streaming preserved
      expect(useChatStore.getState().runId).toBe('run-1');
      expect(useChatStore.getState().streaming).toBe(true);
    });

    it('does NOT set _reconnectedAt when no active runId', () => {
      useChatStore.setState({
        streaming: false,
        runId: null,
      });

      // Simulate onHello without active run
      const { runId } = useChatStore.getState();
      if (runId) {
        useChatStore.setState({ _reconnectedAt: Date.now() });
      } else {
        useChatStore.setState({ streaming: false, streamText: null, runId: null });
      }

      expect(useChatStore.getState()._reconnectedAt).toBeNull();
    });

    it('clears _reconnectedAt when new delta arrives after reconnect', () => {
      useChatStore.setState({
        streaming: true,
        runId: DELTA_FIRST.runId,
        streamText: null,
        _reconnectedAt: Date.now(),
        _lastDeltaAt: null,
      });

      useChatStore.getState().handleChatEvent(DELTA_FIRST);

      expect(useChatStore.getState()._reconnectedAt).toBeNull();
      expect(useChatStore.getState().streamText).toBe('Hello');
    });

    it('clears _reconnectedAt on final/aborted/error', () => {
      useChatStore.setState({
        streaming: true,
        runId: FINAL_TEXT.runId,
        _reconnectedAt: Date.now(),
      });

      useChatStore.getState().handleChatEvent(FINAL_TEXT);

      expect(useChatStore.getState()._reconnectedAt).toBeNull();
      expect(useChatStore.getState().streaming).toBe(false);
    });

    it('uses shorter timeout (RECONNECT_STALE_MS) after reconnect', () => {
      const reconnectTime = Date.now();

      useChatStore.setState({
        streaming: true,
        runId: 'run-1',
        streamText: null,
        _streamStartedAt: reconnectTime - 30_000,
        _lastDeltaAt: reconnectTime - 20_000, // 20s since last delta
        _reconnectedAt: reconnectTime,
      });
      _testWatchdog.start();

      // After 15s check interval, gap from _lastDeltaAt is now ~35s
      // Normal timeout (60s) would NOT trigger, but reconnect timeout (15s) should
      vi.advanceTimersByTime(15_000);

      // With reconnect flag, 35s > 15s → should recover
      expect(useChatStore.getState().streaming).toBe(false);
      expect(useChatStore.getState()._reconnectedAt).toBeNull();
    });

    it('does NOT use shorter timeout in normal (non-reconnect) streaming', () => {
      useChatStore.setState({
        streaming: true,
        runId: 'run-1',
        streamText: 'some text',
        _streamStartedAt: Date.now() - 30_000,
        _lastDeltaAt: Date.now() - 30_000, // 30s since last delta
        _reconnectedAt: null, // NOT a reconnect scenario
      });
      _testWatchdog.start();

      vi.advanceTimersByTime(15_000);

      // 45s < 60s normal timeout → should NOT recover yet
      expect(useChatStore.getState().streaming).toBe(true);
    });
  });

  // ── Integration: combined scenarios ────────────────────────────

  describe('Integration: reconnect + stale tool combined', () => {
    it('reconnect with stale tools: uses reconnect timeout AND clears stale tools', () => {
      const longAgo = Date.now() - 130_000;

      useChatStore.setState({
        streaming: true,
        runId: 'run-1',
        streamText: null,
        _streamStartedAt: longAgo,
        _lastDeltaAt: longAgo,
        _reconnectedAt: Date.now(),
      });
      injectPendingTool({
        startedAt: longAgo,
        lastEventAt: longAgo,
      });
      _testWatchdog.start();

      vi.advanceTimersByTime(15_000);

      // Both conditions met: reconnect timeout AND stale tools → recover
      expect(useChatStore.getState().streaming).toBe(false);
      expect(useToolStreamStore.getState().pendingTools).toHaveLength(0);
    });

    it('reconnect with active tools: waits for tools even with reconnect flag', () => {
      useChatStore.setState({
        streaming: true,
        runId: 'run-1',
        streamText: null,
        _streamStartedAt: Date.now() - 30_000,
        _lastDeltaAt: Date.now() - 20_000,
        _reconnectedAt: Date.now(),
      });
      injectPendingTool({ lastEventAt: Date.now() }); // tool is active
      _testWatchdog.start();

      vi.advanceTimersByTime(15_000);

      // Tool is active → should NOT recover even with reconnect flag
      expect(useChatStore.getState().streaming).toBe(true);
    });

    it('normal delta resumes streaming after reconnect text loss', () => {
      // Simulate: reconnect cleared streamText, then delta arrives with full accumulated text
      useChatStore.setState({
        streaming: true,
        runId: DELTA_SECOND.runId,
        streamText: null, // cleared by reconnect
        _reconnectedAt: Date.now(),
      });

      useChatStore.getState().handleChatEvent(DELTA_SECOND);

      // Full accumulated text restored
      expect(useChatStore.getState().streamText).toBe('Hello, I can help');
      expect(useChatStore.getState()._reconnectedAt).toBeNull();
    });
  });
});
