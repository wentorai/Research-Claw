import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import SettingsPanel from './SettingsPanel';
import { useConfigStore } from '../../stores/config';
import { useGatewayStore } from '../../stores/gateway';

// Mock antd App.useApp (modal.confirm + message)
const mockModalConfirm = vi.fn();
const mockMessageSuccess = vi.fn();
const mockMessageError = vi.fn();
const mockMessageWarning = vi.fn();
vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  const MockApp = Object.assign(
    (props: Record<string, unknown>) => (actual.App as unknown as (p: unknown) => unknown)(props),
    { ...actual.App, useApp: () => ({
      modal: { confirm: (...args: unknown[]) => mockModalConfirm(...args) },
      message: { success: mockMessageSuccess, error: mockMessageError, warning: mockMessageWarning },
      notification: {},
    }) },
  );
  return { ...actual, App: MockApp };
});

// Mock i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && 'count' in opts) return `${key}:${opts.count}`;
      if (opts && 'version' in opts) return `${key}:${opts.version}`;
      return key;
    },
    i18n: { changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

/** Minimal valid gateway config for form rendering. */
function makeGatewayConfig(textModel = 'test-model', provider = 'custom', baseUrl = 'https://api.example.com/v1') {
  return {
    agents: {
      defaults: {
        model: { primary: `${provider}/${textModel}` },
        imageModel: { primary: `${provider}/${textModel}` },
      },
    },
    models: {
      providers: {
        [provider]: {
          baseUrl,
          api: 'openai-completions',
          models: [{ id: textModel, name: textModel }],
        },
      },
    },
  };
}

/** Create a mock gateway client. */
function createMockClient(requestFn?: (...args: unknown[]) => Promise<unknown>) {
  return {
    isConnected: true,
    request: requestFn ?? vi.fn().mockResolvedValue({}),
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as ReturnType<typeof useGatewayStore.getState>['client'];
}

describe('SettingsPanel', () => {
  beforeEach(() => {
    mockModalConfirm.mockReset();
    mockMessageSuccess.mockReset();
    mockMessageError.mockReset();
    useConfigStore.setState({
      theme: 'dark',
      locale: 'en',
      systemPromptAppend: '',
      bootState: 'ready',
      gatewayConfig: null,
      gatewayConfigLoading: false,
      _configRetryCount: 0,
    });
    useGatewayStore.setState({
      client: null,
      state: 'disconnected',
      serverVersion: '0.42.0',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows disconnected message when not connected', () => {
    render(<SettingsPanel />);
    expect(screen.getByText('status.disconnected')).toBeTruthy();
  });

  it('renders single scrollable panel (no tabs) when connected', () => {
    useGatewayStore.setState({
      state: 'connected',
      client: createMockClient(),
    });
    useConfigStore.setState({ gatewayConfig: makeGatewayConfig() });

    render(<SettingsPanel />);

    // Config source badge visible
    expect(screen.getByText('settings.configSource')).toBeTruthy();
    // About section inline (no tab click needed)
    expect(screen.getByText('settings.aboutDiagnostics')).toBeTruthy();
    // No tab elements
    expect(screen.queryByText('settings.model')).toBeNull();
    expect(screen.queryByText('settings.proxy')).toBeNull();
    expect(screen.queryByText('settings.about')).toBeNull();
  });

  it('renders vision enable toggle', () => {
    useGatewayStore.setState({
      state: 'connected',
      client: createMockClient(),
    });
    useConfigStore.setState({ gatewayConfig: makeGatewayConfig() });

    render(<SettingsPanel />);
    expect(screen.getByText('settings.enableVision')).toBeTruthy();
  });

  it('renders text model field when connected with config', () => {
    useGatewayStore.setState({
      state: 'connected',
      client: createMockClient(),
    });
    useConfigStore.setState({ gatewayConfig: makeGatewayConfig() });

    render(<SettingsPanel />);
    // The primary model label should be visible
    expect(screen.getByText('settings.primaryModel')).toBeTruthy();
  });
});

// ============================================================
// PR #18: syncNeeded ref — prevents WS reconnect from overwriting edits
// ============================================================

describe('PR #18: syncNeeded — form sync gating', () => {
  beforeEach(() => {
    mockModalConfirm.mockReset();
    mockMessageSuccess.mockReset();
    mockMessageError.mockReset();
    useConfigStore.setState({
      theme: 'dark',
      locale: 'en',
      systemPromptAppend: '',
      bootState: 'ready',
      gatewayConfig: null,
      gatewayConfigLoading: false,
      _configRetryCount: 0,
    });
    useGatewayStore.setState({
      client: createMockClient(),
      state: 'connected',
      serverVersion: '0.5.6',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('syncs form fields on initial config load', () => {
    // Set config BEFORE render — the initial useEffect should sync
    useConfigStore.setState({ gatewayConfig: makeGatewayConfig('gpt-4o', 'openai', 'https://api.openai.com/v1') });

    render(<SettingsPanel />);

    // The text model field should have the value from config
    const modelInput = screen.getByDisplayValue('gpt-4o');
    expect(modelInput).toBeTruthy();
  });

  it('does NOT overwrite user edits when gatewayConfig changes (WS reconnect)', () => {
    // Initial config load
    useConfigStore.setState({ gatewayConfig: makeGatewayConfig('original-model') });

    render(<SettingsPanel />);

    // Verify initial sync happened
    expect(screen.getByDisplayValue('original-model')).toBeTruthy();

    // User types a new model name
    const modelInput = screen.getByDisplayValue('original-model');
    fireEvent.change(modelInput, { target: { value: 'user-edited-model' } });
    expect(screen.getByDisplayValue('user-edited-model')).toBeTruthy();

    // Simulate WS reconnect: gatewayConfig gets a new object reference with old values
    act(() => {
      useConfigStore.setState({ gatewayConfig: makeGatewayConfig('original-model') });
    });

    // User's edit should be preserved — NOT overwritten back to 'original-model'
    expect(screen.getByDisplayValue('user-edited-model')).toBeTruthy();
  });

  it('syncs form when refresh button is clicked', () => {
    const loadGatewayConfig = vi.fn();
    useConfigStore.setState({
      gatewayConfig: makeGatewayConfig('initial-model'),
      loadGatewayConfig,
    });

    render(<SettingsPanel />);

    // User edits the model
    const modelInput = screen.getByDisplayValue('initial-model');
    fireEvent.change(modelInput, { target: { value: 'user-edit' } });
    expect(screen.getByDisplayValue('user-edit')).toBeTruthy();

    // Click refresh button
    const refreshButton = screen.getByText('settings.refreshConfig');
    fireEvent.click(refreshButton);

    // loadGatewayConfig should have been called
    expect(loadGatewayConfig).toHaveBeenCalled();

    // Simulate the config reload arriving with server value
    act(() => {
      useConfigStore.setState({ gatewayConfig: makeGatewayConfig('server-updated-model') });
    });

    // Form should now show the new server value (syncNeeded was set to true by refresh)
    expect(screen.getByDisplayValue('server-updated-model')).toBeTruthy();
  });

  it('syncs form after successful save + gateway restart', async () => {
    const mockRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'config.get') {
        return Promise.resolve({
          config: makeGatewayConfig('old-model'),
          hash: 'hash123',
        });
      }
      if (method === 'config.apply') {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    useGatewayStore.setState({ client: createMockClient(mockRequest) });
    useConfigStore.setState({ gatewayConfig: makeGatewayConfig('old-model') });

    render(<SettingsPanel />);

    // Click save button to trigger modal.confirm
    const saveButtons = screen.getAllByRole('button', { name: /settings\.save|setup\.gatewayRestarting/i });
    fireEvent.click(saveButtons[0]);

    expect(mockModalConfirm).toHaveBeenCalledTimes(1);

    // Simulate user confirming the dialog
    const confirmCall = mockModalConfirm.mock.calls[0][0] as {
      onOk: () => Promise<void>;
    };
    await confirmCall.onOk();

    // After save, syncNeeded should be true. Simulate gateway restart and new config.
    act(() => {
      useConfigStore.setState({ gatewayConfig: makeGatewayConfig('new-saved-model') });
    });

    // Form should sync to the newly saved model (because syncNeeded was set to true after save)
    expect(screen.getByDisplayValue('new-saved-model')).toBeTruthy();
  });

  it('preserves user edits across multiple WS reconnections', () => {
    useConfigStore.setState({ gatewayConfig: makeGatewayConfig('server-model') });

    render(<SettingsPanel />);

    // User edits the model
    const modelInput = screen.getByDisplayValue('server-model');
    fireEvent.change(modelInput, { target: { value: 'my-custom-model' } });

    // Simulate 3 consecutive WS reconnections
    for (let i = 0; i < 3; i++) {
      act(() => {
        useConfigStore.setState({ gatewayConfig: makeGatewayConfig('server-model') });
      });
    }

    // User's edit should still be preserved after all reconnections
    expect(screen.getByDisplayValue('my-custom-model')).toBeTruthy();
  });

  it('does not sync when save fails (preserves user edits for retry)', () => {
    const mockRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'config.get') {
        return Promise.resolve({
          config: makeGatewayConfig('current-model'),
          hash: 'hash123',
        });
      }
      if (method === 'config.apply') {
        return Promise.reject(new Error('Save failed'));
      }
      return Promise.resolve({});
    });

    useGatewayStore.setState({ client: createMockClient(mockRequest) });
    useConfigStore.setState({ gatewayConfig: makeGatewayConfig('current-model') });

    render(<SettingsPanel />);

    // Verify initial value
    expect(screen.getByDisplayValue('current-model')).toBeTruthy();

    // User edits
    const modelInput = screen.getByDisplayValue('current-model');
    fireEvent.change(modelInput, { target: { value: 'attempted-change' } });

    // Simulate WS reconnect after failed save
    act(() => {
      useConfigStore.setState({ gatewayConfig: makeGatewayConfig('current-model') });
    });

    // User's edit should be preserved (syncNeeded was never set to true since save failed)
    expect(screen.getByDisplayValue('attempted-change')).toBeTruthy();
  });
});

// ============================================================
// Restart button in settings panel
// ============================================================

describe('Restart Research-Claw button', () => {
  beforeEach(() => {
    mockModalConfirm.mockReset();
    mockMessageSuccess.mockReset();
    mockMessageError.mockReset();
    useConfigStore.setState({
      theme: 'dark',
      locale: 'en',
      systemPromptAppend: '',
      bootState: 'ready',
      gatewayConfig: makeGatewayConfig(),
      gatewayConfigLoading: false,
      _configRetryCount: 0,
    });
    useGatewayStore.setState({
      client: createMockClient(),
      state: 'connected',
      serverVersion: '0.6.0',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders restart button in about section', () => {
    render(<SettingsPanel />);
    expect(screen.getByText('settings.restart')).toBeTruthy();
  });

  it('opens confirm modal when restart button is clicked', () => {
    render(<SettingsPanel />);
    const restartBtn = screen.getByText('settings.restart');
    fireEvent.click(restartBtn);
    expect(mockModalConfirm).toHaveBeenCalledTimes(1);
    expect(mockModalConfirm.mock.calls[0][0]).toHaveProperty('title', 'settings.restartConfirm');
  });

  it('calls config.get + config.apply on confirm (no-op restart)', async () => {
    const mockRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'config.get') {
        return Promise.resolve({
          config: makeGatewayConfig(),
          raw: '{"test":true}',
          hash: 'abc123',
        });
      }
      if (method === 'config.apply') {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    useGatewayStore.setState({ client: createMockClient(mockRequest) });

    render(<SettingsPanel />);
    const restartBtn = screen.getByText('settings.restart');
    fireEvent.click(restartBtn);

    // Invoke the onOk callback from the confirm modal
    const confirmCall = mockModalConfirm.mock.calls[0][0] as { onOk: () => Promise<void> };
    await confirmCall.onOk();

    // Should have called config.get then config.apply with same raw
    expect(mockRequest).toHaveBeenCalledWith('config.get', {});
    expect(mockRequest).toHaveBeenCalledWith('config.apply', {
      raw: '{"test":true}',
      baseHash: 'abc123',
    });
    expect(mockMessageSuccess).toHaveBeenCalledWith('settings.restartSuccess');
  });

  it('shows error message when restart fails', async () => {
    const mockRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'config.get') {
        return Promise.reject(new Error('Network error'));
      }
      return Promise.resolve({});
    });

    useGatewayStore.setState({ client: createMockClient(mockRequest) });

    render(<SettingsPanel />);
    fireEvent.click(screen.getByText('settings.restart'));

    const confirmCall = mockModalConfirm.mock.calls[0][0] as { onOk: () => Promise<void> };
    await confirmCall.onOk();

    expect(mockMessageError).toHaveBeenCalledWith('settings.restartFailed');
  });
});
