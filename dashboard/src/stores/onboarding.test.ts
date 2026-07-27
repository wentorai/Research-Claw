import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useGatewayStore } from './gateway';
import { useChatStore } from './chat';
import { useSessionsStore } from './sessions';
import {
  useOnboardingStore,
  welcomeDebug,
  WELCOME_SHOWN_STORAGE_KEY,
  WELCOME_LOCAL_KIND,
  WELCOME_FALLBACK_TEXT,
} from './onboarding';
import type { ChatMessage } from '../gateway/types';

const LOCAL_MSGS_STORAGE_KEY = 'rc-local-chat-msgs-v2';

function installMockClient(
  handler: (method: string, params?: unknown) => Promise<unknown>,
) {
  const request = vi.fn(handler);
  useGatewayStore.setState({ client: { isConnected: true, request } as never, state: 'connected' });
  return { request };
}

/** Reset every involved store to a pristine "genuine first run" baseline. */
function resetToFirstRunBaseline() {
  localStorage.clear();
  useGatewayStore.setState({ client: null, state: 'disconnected' });
  useChatStore.setState({
    messages: [],
    _localOnlyMsgs: [],
    _pendingUserMsgs: [],
    sessionKey: 'main',
    streaming: false,
    sending: false,
  });
  useSessionsStore.setState({ sessions: [{ key: 'main' }], activeSessionKey: 'main' });
  useOnboardingStore.setState({ status: null, evaluated: false, probesReady: false });
}

function setFirstRunStatus(firstRun: boolean) {
  useOnboardingStore.setState({ status: { firstRun, signals: {} } });
}

function welcomeMessagesIn(list: ChatMessage[]): ChatMessage[] {
  return list.filter((m) => m.localKind === WELCOME_LOCAL_KIND);
}

beforeEach(() => {
  resetToFirstRunBaseline();
});

describe('useOnboardingStore.fetchStatus', () => {
  it('treats an RPC failure as NOT first-run (fail-safe)', async () => {
    installMockClient(async () => { throw new Error('rc.onboarding.status boom'); });

    await useOnboardingStore.getState().fetchStatus();

    expect(useOnboardingStore.getState().status).toEqual({ firstRun: false, signals: {} });
  });

  it('treats a missing/disconnected client as NOT first-run', async () => {
    await useOnboardingStore.getState().fetchStatus();

    expect(useOnboardingStore.getState().status?.firstRun).toBe(false);
  });

  it('treats a malformed payload (no firstRun field) as NOT first-run', async () => {
    installMockClient(async () => ({ something: 'else' }));

    await useOnboardingStore.getState().fetchStatus();

    expect(useOnboardingStore.getState().status?.firstRun).toBe(false);
  });

  it('accepts firstRun=true and keeps the server signals', async () => {
    const signals = { bootstrapPresent: true, paperCount: 0, taskCount: 0 };
    installMockClient(async (method) => {
      expect(method).toBe('rc.onboarding.status');
      return { firstRun: true, signals };
    });

    await useOnboardingStore.getState().fetchStatus();

    expect(useOnboardingStore.getState().status).toEqual({ firstRun: true, signals });
  });
});

describe('useOnboardingStore.maybeShowWelcome — gating matrix', () => {
  it('vetoes when the server verdict is not firstRun', () => {
    setFirstRunStatus(false);

    useOnboardingStore.getState().maybeShowWelcome();

    expect(welcomeMessagesIn(useChatStore.getState().messages)).toHaveLength(0);
    expect(localStorage.getItem(WELCOME_SHOWN_STORAGE_KEY)).toBeNull();
  });

  it('vetoes when status was never fetched (null)', () => {
    useOnboardingStore.getState().maybeShowWelcome();

    expect(welcomeMessagesIn(useChatStore.getState().messages)).toHaveLength(0);
  });

  it('vetoes when the active session is not MAIN', () => {
    setFirstRunStatus(true);
    useChatStore.setState({ sessionKey: 'project-abc12345' });

    useOnboardingStore.getState().maybeShowWelcome();

    expect(welcomeMessagesIn(useChatStore.getState().messages)).toHaveLength(0);
  });

  it('vetoes when the main chat history is non-empty', () => {
    setFirstRunStatus(true);
    useChatStore.setState({
      messages: [{ role: 'user', text: '之前聊过了', timestamp: Date.now() }],
    });

    useOnboardingStore.getState().maybeShowWelcome();

    expect(welcomeMessagesIn(useChatStore.getState().messages)).toHaveLength(0);
  });

  it('vetoes when any session carries a derived title (prior activity)', () => {
    setFirstRunStatus(true);
    useSessionsStore.setState({
      sessions: [{ key: 'main', derivedTitle: 'Quantum error correction papers' }],
    });

    useOnboardingStore.getState().maybeShowWelcome();

    expect(welcomeMessagesIn(useChatStore.getState().messages)).toHaveLength(0);
  });

  it('vetoes when a non-main session exists (veteran created projects)', () => {
    setFirstRunStatus(true);
    useSessionsStore.setState({
      sessions: [{ key: 'main' }, { key: 'project-9f3a2b1c', label: 'Session 1' }],
    });

    useOnboardingStore.getState().maybeShowWelcome();

    expect(welcomeMessagesIn(useChatStore.getState().messages)).toHaveLength(0);
  });

  it('vetoes when the per-computer localStorage flag is already set', () => {
    setFirstRunStatus(true);
    localStorage.setItem(WELCOME_SHOWN_STORAGE_KEY, '1');

    useOnboardingStore.getState().maybeShowWelcome();

    expect(welcomeMessagesIn(useChatStore.getState().messages)).toHaveLength(0);
  });

  it('vetoes when a welcome marker already sits in the local bucket', () => {
    setFirstRunStatus(true);
    useChatStore.setState({
      _localOnlyMsgs: [{
        role: 'assistant',
        text: WELCOME_FALLBACK_TEXT,
        timestamp: Date.now() - 1000,
        localKind: WELCOME_LOCAL_KIND,
      }],
    });

    useOnboardingStore.getState().maybeShowWelcome();

    expect(welcomeMessagesIn(useChatStore.getState().messages)).toHaveLength(0);
  });

  it('happy path: injects exactly once, sets the flag, and persists localKind', () => {
    setFirstRunStatus(true);

    useOnboardingStore.getState().maybeShowWelcome();

    const injected = welcomeMessagesIn(useChatStore.getState().messages);
    expect(injected).toHaveLength(1);
    expect(injected[0].role).toBe('assistant');
    expect(injected[0].text).toBe(WELCOME_FALLBACK_TEXT);
    expect(localStorage.getItem(WELCOME_SHOWN_STORAGE_KEY)).toBe('1');

    // localKind survives the localStorage JSON round-trip (per-session bucket).
    const bucket = JSON.parse(localStorage.getItem(LOCAL_MSGS_STORAGE_KEY)!) as
      Record<string, ChatMessage[]>;
    expect(bucket.main[0].localKind).toBe(WELCOME_LOCAL_KIND);

    // Second invocation is a no-op (evaluated guard).
    useOnboardingStore.getState().maybeShowWelcome();
    expect(welcomeMessagesIn(useChatStore.getState().messages)).toHaveLength(1);

    // Even with the lifetime guard reset, the localStorage flag keeps it out.
    useOnboardingStore.setState({ evaluated: false });
    useOnboardingStore.getState().maybeShowWelcome();
    expect(welcomeMessagesIn(useChatStore.getState().messages)).toHaveLength(1);
  });
});

describe('welcome message survives loadHistory', () => {
  it('stays in messages[] after a loadHistory merge with an empty transcript', async () => {
    setFirstRunStatus(true);
    useOnboardingStore.getState().maybeShowWelcome();
    expect(welcomeMessagesIn(useChatStore.getState().messages)).toHaveLength(1);

    installMockClient(async (method) => {
      if (method === 'chat.history') return { messages: [] };
      if (method === 'sessions.usage') return { totals: { input: 0, output: 0 } };
      throw new Error(`unexpected RPC ${method}`);
    });

    await useChatStore.getState().loadHistory();

    const after = welcomeMessagesIn(useChatStore.getState().messages);
    expect(after).toHaveLength(1);
    expect(after[0].localKind).toBe(WELCOME_LOCAL_KIND);
    expect(after[0].text).toBe(WELCOME_FALLBACK_TEXT);
  });

  it('merges chronologically when the gateway later returns real messages', async () => {
    setFirstRunStatus(true);
    useOnboardingStore.getState().maybeShowWelcome();
    const welcomeTs = welcomeMessagesIn(useChatStore.getState().messages)[0].timestamp!;

    installMockClient(async (method) => {
      if (method === 'chat.history') {
        return {
          messages: [
            { role: 'user', text: '开始初始化', timestamp: welcomeTs + 60_000 },
            { role: 'assistant', text: '好的，请问怎么称呼你？', timestamp: welcomeTs + 61_000 },
          ],
        };
      }
      throw new Error(`unexpected RPC ${method}`);
    });

    await useChatStore.getState().loadHistory();

    const msgs = useChatStore.getState().messages;
    expect(msgs).toHaveLength(3);
    expect(msgs[0].localKind).toBe(WELCOME_LOCAL_KIND); // welcome stays first
    expect(msgs[1].role).toBe('user');
    expect(msgs[2].role).toBe('assistant');
  });
});

describe('welcomeDebug (window.__RC_WELCOME__ console hooks)', () => {
  it('is exposed on window', () => {
    expect(
      (window as unknown as Record<string, unknown>).__RC_WELCOME__,
    ).toBe(welcomeDebug);
  });

  it('show() injects bypassing every gate and never sets the show-once flag', () => {
    // Veteran-looking state: server says not first-run, history non-empty.
    setFirstRunStatus(false);
    useChatStore.setState({
      messages: [{ role: 'user', text: 'old talk', timestamp: 1 }],
    });

    welcomeDebug.show();

    expect(welcomeMessagesIn(useChatStore.getState().messages)).toHaveLength(1);
    expect(welcomeMessagesIn(useChatStore.getState()._localOnlyMsgs)).toHaveLength(1);
    expect(localStorage.getItem(WELCOME_SHOWN_STORAGE_KEY)).toBeNull();
    // The verdict is forced so the CTA section previews even on a veteran machine.
    expect(useOnboardingStore.getState().status).toEqual({
      firstRun: true,
      signals: { __debugForced: true },
    });
  });

  it('show() replaces an existing card instead of stacking', () => {
    welcomeDebug.show();
    welcomeDebug.show();

    expect(welcomeMessagesIn(useChatStore.getState().messages)).toHaveLength(1);
    expect(welcomeMessagesIn(useChatStore.getState()._localOnlyMsgs)).toHaveLength(1);
  });

  it('reset() removes the card, clears the flag, and re-enables the natural flow', () => {
    setFirstRunStatus(true);
    useOnboardingStore.getState().maybeShowWelcome();
    expect(welcomeMessagesIn(useChatStore.getState().messages)).toHaveLength(1);
    expect(localStorage.getItem(WELCOME_SHOWN_STORAGE_KEY)).toBe('1');

    welcomeDebug.reset();

    expect(welcomeMessagesIn(useChatStore.getState().messages)).toHaveLength(0);
    expect(welcomeMessagesIn(useChatStore.getState()._localOnlyMsgs)).toHaveLength(0);
    expect(localStorage.getItem(WELCOME_SHOWN_STORAGE_KEY)).toBeNull();
    expect(useOnboardingStore.getState().evaluated).toBe(false);
    // reset() re-fetches the real verdict; with no client that resolves to NOT first-run.
    expect(useOnboardingStore.getState().status?.firstRun).toBe(false);

    // Natural flow works again end to end once the server verdict is first-run.
    setFirstRunStatus(true);
    useOnboardingStore.getState().maybeShowWelcome();
    expect(welcomeMessagesIn(useChatStore.getState().messages)).toHaveLength(1);
  });

  it('evaluate() re-runs the real gates and reports which one vetoed', () => {
    setFirstRunStatus(true);
    useChatStore.setState({
      messages: [{ role: 'user', text: 'veteran history', timestamp: 1 }],
    });

    const report = welcomeDebug.evaluate() as {
      gates: Record<string, boolean>;
    };

    expect(report.gates.serverFirstRun).toBe(true);
    expect(report.gates.historyEmpty).toBe(false); // the vetoing gate is visible
    expect(welcomeMessagesIn(useChatStore.getState().messages)).toHaveLength(0);
  });

  it('status() reflects the show-once flag and marker state', () => {
    setFirstRunStatus(true);
    useOnboardingStore.getState().maybeShowWelcome();

    const report = welcomeDebug.status() as { gates: Record<string, boolean> };

    expect(report.gates.shownFlagAbsent).toBe(false);
    expect(report.gates.noExistingMarker).toBe(false);
  });
});
