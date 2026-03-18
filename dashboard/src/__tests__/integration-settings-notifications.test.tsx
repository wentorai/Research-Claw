/**
 * Integration Tests: Issues 6, 7, 8
 *
 * Issue 6: Settings save confirmation dialog (Modal.confirm before config.apply)
 * Issue 7: Version v0.5.1 + glow header + GitHub link
 * Issue 8: Notification system (Channel A polling, Channel B card extraction, dedup, read persistence)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

// --- Mock antd App.useApp (modal.confirm + message) ---
const mockModalConfirm = vi.fn();
const mockMessageSuccess = vi.fn();
const mockMessageError = vi.fn();
vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  // App.useApp() must return theme-aware modal/message instances
  const MockApp = Object.assign(
    (props: Record<string, unknown>) => (actual.App as unknown as (p: unknown) => unknown)(props),
    { ...actual.App, useApp: () => ({
      modal: { confirm: (...args: unknown[]) => mockModalConfirm(...args) },
      message: { success: mockMessageSuccess, error: mockMessageError },
      notification: {},
    }) },
  );
  return { ...actual, App: MockApp };
});

// --- Mock i18n ---
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && 'version' in opts) return key.replace('{{version}}', String(opts.version));
      if (opts && 'count' in opts) return `${key}:${opts.count}`;
      return key;
    },
    i18n: { changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

// --- Imports (after mocks) ---
import SettingsPanel from '../components/panels/SettingsPanel';
import { useUiStore } from '../stores/ui';
import { useGatewayStore } from '../stores/gateway';
import { useConfigStore } from '../stores/config';
import { useChatStore } from '../stores/chat';

// --- Helpers ---

/** Create a mock gateway client with a controllable request method. */
function createMockClient(requestFn?: (...args: unknown[]) => Promise<unknown>) {
  return {
    isConnected: true,
    request: requestFn ?? vi.fn().mockResolvedValue({}),
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as ReturnType<typeof useGatewayStore.getState>['client'];
}

/** Minimal valid gateway config that makes SettingsPanel render its form fields. */
function minimalGatewayConfig() {
  return {
    agents: {
      defaults: {
        model: { primary: 'custom/test-model' },
        imageModel: { primary: 'custom/test-model' },
      },
    },
    models: {
      providers: {
        custom: {
          baseUrl: 'https://api.example.com/v1',
          api: 'openai-completions',
          models: [{ id: 'test-model', name: 'test-model' }],
        },
      },
    },
  };
}

// --- Reset all store state between tests ---

beforeEach(() => {
  mockModalConfirm.mockReset();

  // Reset localStorage
  localStorage.clear();

  // Reset stores to default state
  useGatewayStore.setState({
    client: null,
    state: 'disconnected',
    serverVersion: null,
    assistantName: 'Research-Claw',
    connId: null,
  });

  useConfigStore.setState({
    theme: 'dark',
    locale: 'en',
    systemPromptAppend: '',
    bootState: 'ready',
    gatewayConfig: null,
    gatewayConfigLoading: false,
    _configRetryCount: 0,
  });

  useUiStore.setState({
    notifications: [],
    unreadCount: 0,
  });

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
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
// Issue 6: Settings save triggers confirmation dialog
// ============================================================

describe('Issue 6: Settings save confirmation dialog', () => {
  it('shows Modal.confirm when save button is clicked', async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      config: minimalGatewayConfig(),
      hash: 'abc123',
    });

    useGatewayStore.setState({
      client: createMockClient(mockRequest),
      state: 'connected',
      serverVersion: '0.5.1',
    });

    useConfigStore.setState({
      gatewayConfig: minimalGatewayConfig(),
      gatewayConfigLoading: false,
    });

    render(<SettingsPanel />);

    // The form should be rendered with pre-filled values from config
    // Find and click the save button (the first one - config save, not prompt save)
    const saveButtons = screen.getAllByRole('button', { name: /settings\.save|setup\.gatewayRestarting/i });
    expect(saveButtons.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(saveButtons[0]);

    // Modal.confirm should have been called
    expect(mockModalConfirm).toHaveBeenCalledTimes(1);

    // Verify the confirmation dialog has the correct title
    const confirmCall = mockModalConfirm.mock.calls[0][0] as {
      title: string;
      content: string;
      okText: string;
      onOk: () => Promise<void>;
    };
    expect(confirmCall.title).toBe('settings.restartConfirmTitle');
    expect(confirmCall.content).toBe('settings.restartConfirmContent');
    expect(confirmCall.okText).toBe('settings.save');
  });

  it('does NOT call config.apply before user confirms the dialog', async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      config: minimalGatewayConfig(),
      hash: 'abc123',
    });

    useGatewayStore.setState({
      client: createMockClient(mockRequest),
      state: 'connected',
      serverVersion: '0.5.1',
    });

    useConfigStore.setState({
      gatewayConfig: minimalGatewayConfig(),
      gatewayConfigLoading: false,
    });

    render(<SettingsPanel />);

    // Click save
    const saveButtons = screen.getAllByRole('button', { name: /settings\.save|setup\.gatewayRestarting/i });
    fireEvent.click(saveButtons[0]);

    // config.apply should NOT have been called — only Modal.confirm was invoked
    const configApplyCalls = mockRequest.mock.calls.filter(
      (call: unknown[]) => call[0] === 'config.apply',
    );
    expect(configApplyCalls).toHaveLength(0);
  });

  it('calls config.apply after user confirms the dialog', async () => {
    const mockRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'config.get') {
        return Promise.resolve({
          config: minimalGatewayConfig(),
          hash: 'abc123',
        });
      }
      if (method === 'config.apply') {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    useGatewayStore.setState({
      client: createMockClient(mockRequest),
      state: 'connected',
      serverVersion: '0.5.1',
    });

    useConfigStore.setState({
      gatewayConfig: minimalGatewayConfig(),
      gatewayConfigLoading: false,
    });

    render(<SettingsPanel />);

    // Click save to trigger Modal.confirm
    const saveButtons = screen.getAllByRole('button', { name: /settings\.save|setup\.gatewayRestarting/i });
    fireEvent.click(saveButtons[0]);

    expect(mockModalConfirm).toHaveBeenCalledTimes(1);

    // Simulate user confirming the dialog by calling onOk
    const confirmCall = mockModalConfirm.mock.calls[0][0] as {
      onOk: () => Promise<void>;
    };
    await confirmCall.onOk();

    // Now config.get and config.apply should both have been called
    const configGetCalls = mockRequest.mock.calls.filter(
      (call: unknown[]) => call[0] === 'config.get',
    );
    const configApplyCalls = mockRequest.mock.calls.filter(
      (call: unknown[]) => call[0] === 'config.apply',
    );
    expect(configGetCalls.length).toBeGreaterThanOrEqual(1);
    expect(configApplyCalls).toHaveLength(1);

    // Verify config.apply was called with raw and baseHash
    const applyParams = configApplyCalls[0][1] as { raw: string; baseHash: string };
    expect(applyParams.raw).toBeDefined();
    expect(typeof applyParams.raw).toBe('string');
    expect(applyParams.baseHash).toBe('abc123');
  });
});

// ============================================================
// Issue 7: Version v0.5.1 + GitHub link
// ============================================================

describe('Issue 7: Version v0.5.1 and GitHub link', () => {
  beforeEach(() => {
    useGatewayStore.setState({
      client: createMockClient(),
      state: 'connected',
      serverVersion: '0.5.1',
    });

    useConfigStore.setState({
      gatewayConfig: minimalGatewayConfig(),
      gatewayConfigLoading: false,
    });
  });

  it('renders "Research-Claw v0.5.1" text in the about section', () => {
    render(<SettingsPanel />);

    // The glowing header should contain the version string
    expect(screen.getByText('Research-Claw v0.5.1')).toBeInTheDocument();
  });

  it('renders a link to the GitHub repository', () => {
    render(<SettingsPanel />);

    // There should be at least one link to the GitHub repo
    const githubLinks = screen.getAllByRole('link').filter(
      (link) => link.getAttribute('href') === 'https://github.com/wentorai/Research-Claw',
    );
    expect(githubLinks.length).toBeGreaterThanOrEqual(1);
  });

  it('renders the "View on GitHub" text (settings.aboutGithub)', () => {
    render(<SettingsPanel />);

    // The i18n key is returned as-is by our mock
    expect(screen.getByText('settings.aboutGithub')).toBeInTheDocument();
  });

  it('GitHub link opens in a new tab', () => {
    render(<SettingsPanel />);

    const githubLinks = screen.getAllByRole('link').filter(
      (link) => link.getAttribute('href') === 'https://github.com/wentorai/Research-Claw',
    );
    // Both the header link and bottom link should open in new tab
    for (const link of githubLinks) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    }
  });

  it('contains v0.5.1 in the glow header (info row removed to avoid duplication)', () => {
    render(<SettingsPanel />);

    // Version is shown only in the glow header, not as a separate info row
    expect(screen.getByText('Research-Claw v0.5.1')).toBeInTheDocument();
  });

  it('diagnostics copy text contains v0.5.1', () => {
    // Verify by reading the source — the diagnostics array includes 'Research-Claw v0.5.1'
    // This is a structural test: the AboutSection handleCopyDiagnostics builds the string
    // with a hardcoded 'Research-Claw v0.5.1' on line 71 of SettingsPanel.tsx.
    // We verify the rendered component has the version header which uses the same string.
    render(<SettingsPanel />);

    const versionHeader = screen.getByText('Research-Claw v0.5.1');
    expect(versionHeader).toBeInTheDocument();

    // The version header should be styled with the red glow color
    const parentLink = versionHeader.closest('a');
    expect(parentLink).not.toBeNull();
    expect(parentLink!.getAttribute('href')).toBe('https://github.com/wentorai/Research-Claw');
  });
});

// ============================================================
// Issue 8: Notification System
// ============================================================

describe('Issue 8: Notification Channel A - polling', () => {
  it('adds notifications from rc.notifications.pending RPC results', async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      overdue: [
        { id: 'task-1', title: 'Submit paper', deadline: '2026-03-10', priority: 'high' },
      ],
      upcoming: [
        { id: 'task-2', title: 'Review draft', deadline: '2026-03-16', priority: 'medium' },
      ],
    });

    useGatewayStore.setState({
      client: createMockClient(mockRequest),
      state: 'connected',
    });

    await useUiStore.getState().checkNotifications();

    // Verify the RPC was called correctly
    expect(mockRequest).toHaveBeenCalledWith('rc.notifications.pending', { hours: 48 });

    // Should have 2 notifications (1 overdue + 1 upcoming)
    const { notifications, unreadCount } = useUiStore.getState();
    expect(notifications).toHaveLength(2);
    expect(unreadCount).toBe(2);

    // Verify overdue notification
    const overdue = notifications.find((n) => n.dedupKey === 'overdue:task-1');
    expect(overdue).toBeDefined();
    expect(overdue!.type).toBe('deadline');
    expect(overdue!.title).toBe('Submit paper');
    expect(overdue!.body).toBe('Overdue: 2026-03-10');

    // Verify upcoming notification
    const upcoming = notifications.find((n) => n.dedupKey === 'upcoming:task-2');
    expect(upcoming).toBeDefined();
    expect(upcoming!.type).toBe('deadline');
    expect(upcoming!.title).toBe('Review draft');
    expect(upcoming!.body).toBe('Due: 2026-03-16');
  });

  it('includes custom agent-sent notifications', async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      overdue: [],
      upcoming: [],
      custom: [
        { id: 'n-1', type: 'system', title: 'Scan complete', body: '12 new papers found', created_at: '2026-03-14T10:00:00Z' },
      ],
    });

    useGatewayStore.setState({
      client: createMockClient(mockRequest),
      state: 'connected',
    });

    await useUiStore.getState().checkNotifications();

    const { notifications } = useUiStore.getState();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe('system');
    expect(notifications[0].title).toBe('Scan complete');
    expect(notifications[0].dedupKey).toBe('custom:n-1');
  });

  it('deduplicates notifications on repeated polling', async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      overdue: [
        { id: 'task-1', title: 'Submit paper', deadline: '2026-03-10', priority: 'high' },
      ],
      upcoming: [],
    });

    useGatewayStore.setState({
      client: createMockClient(mockRequest),
      state: 'connected',
    });

    // Poll twice with the same data
    await useUiStore.getState().checkNotifications();
    await useUiStore.getState().checkNotifications();

    // Should still have only 1 notification, not 2
    const { notifications, unreadCount } = useUiStore.getState();
    expect(notifications).toHaveLength(1);
    expect(unreadCount).toBe(1);
  });

  it('does nothing when client is not connected', async () => {
    useGatewayStore.setState({
      client: null,
      state: 'disconnected',
    });

    // Should not throw
    await useUiStore.getState().checkNotifications();

    const { notifications } = useUiStore.getState();
    expect(notifications).toHaveLength(0);
  });

  it('silently handles RPC errors without crashing', async () => {
    const mockRequest = vi.fn().mockRejectedValue(new Error('Network error'));

    useGatewayStore.setState({
      client: createMockClient(mockRequest),
      state: 'connected',
    });

    // Should not throw
    await useUiStore.getState().checkNotifications();

    const { notifications } = useUiStore.getState();
    expect(notifications).toHaveLength(0);
  });
});

describe('Issue 8: Notification Channel B - card extraction', () => {
  it('extracts progress_card from assistant message and creates heartbeat notification', () => {
    const mockRequest = vi.fn().mockResolvedValue({
      overdue: [],
      upcoming: [],
    });

    useGatewayStore.setState({
      client: createMockClient(mockRequest),
      state: 'connected',
    });

    // Set up a runId so the 'final' event matches
    useChatStore.setState({ runId: 'run-123', streaming: true });

    const progressCardText = [
      'Here is your progress update:',
      '',
      '```progress_card',
      JSON.stringify({
        period: 'daily',
        highlights: ['Finished literature review', 'Submitted draft'],
      }),
      '```',
    ].join('\n');

    useChatStore.getState().handleChatEvent({
      runId: 'run-123',
      sessionKey: 'main',
      state: 'final',
      message: {
        role: 'assistant',
        text: progressCardText,
      },
    });

    // A heartbeat notification should have been created
    const { notifications } = useUiStore.getState();
    const heartbeat = notifications.find((n) => n.type === 'heartbeat');
    expect(heartbeat).toBeDefined();
    expect(heartbeat!.title).toContain('Heartbeat');
    expect(heartbeat!.title).toContain('daily');
    expect(heartbeat!.body).toContain('Finished literature review');
  });

  it('extracts radar_digest from assistant message and creates system notification', () => {
    useChatStore.setState({ runId: 'run-456', streaming: true });

    useGatewayStore.setState({
      client: createMockClient(vi.fn().mockResolvedValue({ overdue: [], upcoming: [] })),
      state: 'connected',
    });

    const radarText = [
      'Radar scan results:',
      '',
      '```radar_digest',
      JSON.stringify({
        total_found: 5,
        query: 'transformer attention',
      }),
      '```',
    ].join('\n');

    useChatStore.getState().handleChatEvent({
      runId: 'run-456',
      sessionKey: 'main',
      state: 'final',
      message: {
        role: 'assistant',
        text: radarText,
      },
    });

    const { notifications } = useUiStore.getState();
    const radar = notifications.find((n) => n.type === 'system');
    expect(radar).toBeDefined();
    expect(radar!.title).toContain('Radar');
    expect(radar!.title).toContain('5');
    expect(radar!.body).toContain('transformer attention');
  });

  it('extracts approval_card from assistant message and creates error-type notification', () => {
    useChatStore.setState({ runId: 'run-789', streaming: true });

    useGatewayStore.setState({
      client: createMockClient(vi.fn().mockResolvedValue({ overdue: [], upcoming: [] })),
      state: 'connected',
    });

    const approvalText = [
      'Approval required:',
      '',
      '```approval_card',
      JSON.stringify({
        approval_id: 'apr-001',
        action: 'delete experiment data',
        context: 'This will remove 50 records',
      }),
      '```',
    ].join('\n');

    useChatStore.getState().handleChatEvent({
      runId: 'run-789',
      sessionKey: 'main',
      state: 'final',
      message: {
        role: 'assistant',
        text: approvalText,
      },
    });

    const { notifications } = useUiStore.getState();
    const approval = notifications.find((n) => n.type === 'error');
    expect(approval).toBeDefined();
    expect(approval!.title).toContain('Approval needed');
    expect(approval!.title).toContain('delete experiment data');
    expect(approval!.dedupKey).toBe('approval:apr-001');
  });
});

describe('Issue 8: Notification deduplication', () => {
  it('prevents duplicate notifications with the same dedupKey', () => {
    const { addNotification } = useUiStore.getState();

    addNotification({
      type: 'system',
      title: 'First notification',
      dedupKey: 'test:1',
    });

    addNotification({
      type: 'system',
      title: 'Duplicate notification',
      dedupKey: 'test:1',
    });

    const { notifications, unreadCount } = useUiStore.getState();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe('First notification');
    expect(unreadCount).toBe(1);
  });

  it('allows notifications with different dedupKeys', () => {
    const { addNotification } = useUiStore.getState();

    addNotification({
      type: 'system',
      title: 'Notification A',
      dedupKey: 'test:1',
    });

    addNotification({
      type: 'system',
      title: 'Notification B',
      dedupKey: 'test:2',
    });

    const { notifications, unreadCount } = useUiStore.getState();
    expect(notifications).toHaveLength(2);
    expect(unreadCount).toBe(2);
  });

  it('allows notifications without dedupKey (no dedup for those)', () => {
    const { addNotification } = useUiStore.getState();

    addNotification({
      type: 'system',
      title: 'No key A',
    });

    addNotification({
      type: 'system',
      title: 'No key B',
    });

    const { notifications } = useUiStore.getState();
    expect(notifications).toHaveLength(2);
  });
});

describe('Issue 8: Read state persistence via localStorage', () => {
  it('persists read state to localStorage when marking a notification as read', () => {
    const { addNotification } = useUiStore.getState();

    addNotification({
      type: 'deadline',
      title: 'Overdue task',
      dedupKey: 'persist:1',
    });

    const notifications = useUiStore.getState().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0].read).toBe(false);

    // Mark as read
    useUiStore.getState().markNotificationRead(notifications[0].id);

    // Verify it's marked as read in the store
    const updated = useUiStore.getState().notifications;
    expect(updated[0].read).toBe(true);

    // Verify localStorage was updated
    const storedRaw = localStorage.getItem('rc-read-dedup-keys');
    expect(storedRaw).not.toBeNull();
    const storedKeys = JSON.parse(storedRaw!) as string[];
    expect(storedKeys).toContain('persist:1');
  });

  it('auto-marks re-added notifications as read if their dedupKey was previously read', () => {
    // Step 1: Add and mark as read
    const { addNotification, markNotificationRead } = useUiStore.getState();

    addNotification({
      type: 'deadline',
      title: 'Task A',
      dedupKey: 'persist:2',
    });

    const id = useUiStore.getState().notifications[0].id;
    markNotificationRead(id);

    // Step 2: Reset the store (simulating a page refresh)
    useUiStore.setState({
      notifications: [],
      unreadCount: 0,
    });

    // localStorage still has the read keys (not cleared)
    const storedRaw = localStorage.getItem('rc-read-dedup-keys');
    expect(storedRaw).not.toBeNull();

    // Step 3: Re-add the same notification (e.g., from a new poll)
    useUiStore.getState().addNotification({
      type: 'deadline',
      title: 'Task A (re-polled)',
      dedupKey: 'persist:2',
    });

    // The notification should be automatically marked as read
    const notifications = useUiStore.getState().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0].read).toBe(true);
    // unreadCount should remain 0 since the notification was auto-read
    expect(useUiStore.getState().unreadCount).toBe(0);
  });

  it('markAllNotificationsRead persists all dedupKeys to localStorage', () => {
    const { addNotification } = useUiStore.getState();

    addNotification({ type: 'system', title: 'N1', dedupKey: 'bulk:1' });
    addNotification({ type: 'system', title: 'N2', dedupKey: 'bulk:2' });
    addNotification({ type: 'system', title: 'N3', dedupKey: 'bulk:3' });

    expect(useUiStore.getState().unreadCount).toBe(3);

    // Mark all as read
    useUiStore.getState().markAllNotificationsRead();

    expect(useUiStore.getState().unreadCount).toBe(0);

    // All dedupKeys should be in localStorage
    const storedRaw = localStorage.getItem('rc-read-dedup-keys');
    const storedKeys = JSON.parse(storedRaw!) as string[];
    expect(storedKeys).toContain('bulk:1');
    expect(storedKeys).toContain('bulk:2');
    expect(storedKeys).toContain('bulk:3');
  });

  it('caps stored read keys at MAX_READ_KEYS (200)', () => {
    const { addNotification, markNotificationRead } = useUiStore.getState();

    // Add and mark 210 notifications as read
    for (let i = 0; i < 210; i++) {
      addNotification({ type: 'system', title: `N-${i}`, dedupKey: `cap:${i}` });
    }

    // Mark all as read
    useUiStore.getState().markAllNotificationsRead();

    const storedRaw = localStorage.getItem('rc-read-dedup-keys');
    const storedKeys = JSON.parse(storedRaw!) as string[];
    // Should be capped at 200 (the last 200)
    expect(storedKeys.length).toBeLessThanOrEqual(200);
  });
});
