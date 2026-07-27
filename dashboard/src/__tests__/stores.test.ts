import { describe, it, expect, beforeEach } from 'vitest';
import { useConfigStore } from '../stores/config';
import { useUiStore } from '../stores/ui';
import { useChatStore } from '../stores/chat';

// Store modules are imported during collection, outside the per-test 5s timeout.
// Dynamic imports inside each test made the first chat assertion time out under
// full-suite worker contention even though the assertion itself is synchronous.
// Zustand stores persist as singletons, so individual tests reset the fields
// they mutate with store.setState.

describe('configStore', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('default theme is dark', async () => {
    useConfigStore.setState({ theme: 'dark', locale: 'zh-CN', bootState: 'pending' });
    const state = useConfigStore.getState();
    expect(state.theme).toBe('dark');
    expect(state.locale).toBe('zh-CN');
  });

  it('setTheme updates state and localStorage', async () => {
    useConfigStore.getState().setTheme('light');
    expect(useConfigStore.getState().theme).toBe('light');
    expect(localStorage.getItem('rc-theme')).toBe('light');
  });

  it('evaluateConfig sets needs_setup when no config and retries exhausted', async () => {
    useConfigStore.setState({ gatewayConfig: null, _configRetryCount: 5 });
    useConfigStore.getState().evaluateConfig();
    expect(useConfigStore.getState().bootState).toBe('needs_setup');
  });

  it('evaluateConfig sets ready when config is valid', async () => {
    useConfigStore.setState({
      gatewayConfig: {
        agents: { defaults: { model: { primary: 'rc/gpt-4o' } } },
        models: { providers: { rc: { baseUrl: 'https://api.openai.com' } } },
      },
    });
    useConfigStore.getState().evaluateConfig();
    expect(useConfigStore.getState().bootState).toBe('ready');
  });
});

describe('uiStore', () => {
  it('default agent status is disconnected', async () => {
    expect(useUiStore.getState().agentStatus).toBe('disconnected');
  });

  it('toggleLeftNav flips collapsed state', async () => {
    const initial = useUiStore.getState().leftNavCollapsed;
    useUiStore.getState().toggleLeftNav();
    expect(useUiStore.getState().leftNavCollapsed).toBe(!initial);
  });

  it('setRightPanelWidth clamps between 320-480', async () => {
    useUiStore.getState().setRightPanelWidth(200);
    expect(useUiStore.getState().rightPanelWidth).toBe(320);

    useUiStore.getState().setRightPanelWidth(600);
    expect(useUiStore.getState().rightPanelWidth).toBe(480);

    useUiStore.getState().setRightPanelWidth(400);
    expect(useUiStore.getState().rightPanelWidth).toBe(400);
  });

  it('setConfigPanelHeight clamps and persists', async () => {
    useUiStore.getState().setConfigPanelHeight(100);
    expect(useUiStore.getState().configPanelHeight).toBe(200);
    expect(localStorage.getItem('rc-config-panel-height')).toBe('200');
  });

  it('setConfigPanelPlacement persists', async () => {
    useUiStore.getState().setConfigPanelPlacement('bottom');
    expect(useUiStore.getState().configPanelPlacement).toBe('bottom');
    expect(localStorage.getItem('rc-config-panel-placement')).toBe('bottom');
  });

  it('addNotification increments unreadCount', async () => {
    useUiStore.setState({ notifications: [], unreadCount: 0 });
    useUiStore.getState().addNotification({ type: 'system', title: 'Test' });
    expect(useUiStore.getState().unreadCount).toBe(1);
    expect(useUiStore.getState().notifications).toHaveLength(1);
  });

  it('markAllNotificationsRead sets unreadCount to 0', async () => {
    useUiStore.setState({ notifications: [], unreadCount: 0 });
    useUiStore.getState().addNotification({ type: 'system', title: 'A' });
    useUiStore.getState().addNotification({ type: 'system', title: 'B' });
    expect(useUiStore.getState().unreadCount).toBe(2);
    useUiStore.getState().markAllNotificationsRead();
    expect(useUiStore.getState().unreadCount).toBe(0);
  });

  it('setAgentStatus updates status', async () => {
    useUiStore.getState().setAgentStatus('thinking');
    expect(useUiStore.getState().agentStatus).toBe('thinking');
  });
});

describe('chatStore', () => {
  it('initial state has empty messages', async () => {
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it('handleChatEvent delta appends to streamText', async () => {
    useChatStore.setState({ runId: 'run-1', streaming: true, streamText: '' });

    useChatStore.getState().handleChatEvent({
      runId: 'run-1',
      sessionKey: 'main',
      state: 'delta',
      message: { role: 'assistant', text: 'Hello' },
    });

    expect(useChatStore.getState().streamText).toBe('Hello');
  });

  it('handleChatEvent final adds message and clears streaming', async () => {
    useChatStore.setState({ runId: 'run-1', streaming: true, streamText: 'Hello', messages: [] });

    useChatStore.getState().handleChatEvent({
      runId: 'run-1',
      sessionKey: 'main',
      state: 'final',
      message: { role: 'assistant', text: 'Hello world' },
    });

    const state = useChatStore.getState();
    expect(state.streaming).toBe(false);
    expect(state.streamText).toBeNull();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].text).toBe('Hello world');
  });

  it('handleChatEvent filters NO_REPLY', async () => {
    useChatStore.setState({ runId: 'run-1', messages: [] });

    useChatStore.getState().handleChatEvent({
      runId: 'run-1',
      sessionKey: 'main',
      state: 'final',
      message: { role: 'assistant', text: '  NO_REPLY  ' },
    });

    expect(useChatStore.getState().messages).toHaveLength(0);
  });

  it('handleChatEvent error sets lastError', async () => {
    useChatStore.setState({ runId: 'run-1', streaming: true });

    useChatStore.getState().handleChatEvent({
      runId: 'run-1',
      sessionKey: 'main',
      state: 'error',
      errorMessage: 'Model overloaded',
    });

    expect(useChatStore.getState().lastError).toBe('Model overloaded');
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it('clearError resets lastError', async () => {
    useChatStore.setState({ lastError: 'some error' });
    useChatStore.getState().clearError();
    expect(useChatStore.getState().lastError).toBeNull();
  });
});
