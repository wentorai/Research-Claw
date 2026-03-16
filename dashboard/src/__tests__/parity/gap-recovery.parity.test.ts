/**
 * Event sequence gap recovery parity tests.
 *
 * OC reference: ui/src/ui/app-gateway.ts:258-264 (onGap handler)
 * OC reference: ui/src/ui/controllers/chat.ts:66-93 (loadChatHistory)
 *
 * OC displays an error message and lets the user manually refresh.
 * RC improves on this: auto-recovers by reloading history when safe,
 * deferring reload if currently streaming to avoid interruption.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useChatStore } from '../../stores/chat';

describe('Seq gap recovery — RC improvement over OC onGap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useChatStore.setState({
      messages: [],
      streaming: false,
      streamText: null,
      runId: null,
      lastError: null,
      _pendingGapReload: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules debounced loadHistory when idle (not streaming)', () => {
    const loadHistory = vi.spyOn(useChatStore.getState(), 'loadHistory').mockResolvedValue();

    useChatStore.getState().onGapDetected();

    // Should NOT call immediately (debounce)
    expect(loadHistory).not.toHaveBeenCalled();

    // After debounce period
    vi.advanceTimersByTime(1000);
    expect(loadHistory).toHaveBeenCalledTimes(1);

    loadHistory.mockRestore();
  });

  it('batches multiple rapid gaps into one loadHistory call', () => {
    const loadHistory = vi.spyOn(useChatStore.getState(), 'loadHistory').mockResolvedValue();

    // Three gaps in quick succession
    useChatStore.getState().onGapDetected();
    useChatStore.getState().onGapDetected();
    useChatStore.getState().onGapDetected();

    vi.advanceTimersByTime(1000);
    // Only one reload, not three
    expect(loadHistory).toHaveBeenCalledTimes(1);

    loadHistory.mockRestore();
  });

  it('defers reload when streaming — sets _pendingGapReload flag', () => {
    const loadHistory = vi.spyOn(useChatStore.getState(), 'loadHistory').mockResolvedValue();

    // Simulate active streaming
    useChatStore.setState({ streaming: true, runId: 'run-123', streamText: 'partial...' });

    useChatStore.getState().onGapDetected();

    // Should NOT schedule a reload during streaming
    vi.advanceTimersByTime(2000);
    expect(loadHistory).not.toHaveBeenCalled();

    // Flag should be set for post-streaming recovery
    expect(useChatStore.getState()._pendingGapReload).toBe(true);

    loadHistory.mockRestore();
  });

  it('executes deferred reload when streaming ends via final event', () => {
    const loadHistory = vi.spyOn(useChatStore.getState(), 'loadHistory').mockResolvedValue();

    // Streaming with pending gap
    useChatStore.setState({
      streaming: true,
      runId: 'run-gap-final',
      streamText: 'partial...',
      _pendingGapReload: true,
    });

    // Final event arrives — ends streaming
    useChatStore.getState().handleChatEvent({
      runId: 'run-gap-final',
      sessionKey: 'main',
      state: 'final',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Complete response.' }],
        timestamp: Date.now(),
      },
    });

    // Flag should be cleared
    expect(useChatStore.getState()._pendingGapReload).toBe(false);
    // Deferred reload should have been called
    expect(loadHistory).toHaveBeenCalledTimes(1);

    loadHistory.mockRestore();
  });

  it('executes deferred reload when streaming ends via abort', () => {
    const loadHistory = vi.spyOn(useChatStore.getState(), 'loadHistory').mockResolvedValue();

    useChatStore.setState({
      streaming: true,
      runId: 'run-gap-abort',
      streamText: 'partial...',
      _pendingGapReload: true,
    });

    useChatStore.getState().handleChatEvent({
      runId: 'run-gap-abort',
      sessionKey: 'main',
      state: 'aborted',
    });

    expect(useChatStore.getState()._pendingGapReload).toBe(false);
    expect(loadHistory).toHaveBeenCalledTimes(1);

    loadHistory.mockRestore();
  });

  it('executes deferred reload when streaming ends via error', () => {
    const loadHistory = vi.spyOn(useChatStore.getState(), 'loadHistory').mockResolvedValue();

    useChatStore.setState({
      streaming: true,
      runId: 'run-gap-err',
      streamText: 'partial...',
      _pendingGapReload: true,
    });

    useChatStore.getState().handleChatEvent({
      runId: 'run-gap-err',
      sessionKey: 'main',
      state: 'error',
      errorMessage: 'Model overloaded',
    });

    expect(useChatStore.getState()._pendingGapReload).toBe(false);
    expect(loadHistory).toHaveBeenCalledTimes(1);

    loadHistory.mockRestore();
  });

  it('does NOT reload if no gap was pending after streaming ends', () => {
    const loadHistory = vi.spyOn(useChatStore.getState(), 'loadHistory').mockResolvedValue();

    useChatStore.setState({
      streaming: true,
      runId: 'run-no-gap',
      streamText: 'partial...',
      _pendingGapReload: false, // no gap
    });

    useChatStore.getState().handleChatEvent({
      runId: 'run-no-gap',
      sessionKey: 'main',
      state: 'final',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
        timestamp: Date.now(),
      },
    });

    expect(loadHistory).not.toHaveBeenCalled();

    loadHistory.mockRestore();
  });
});
