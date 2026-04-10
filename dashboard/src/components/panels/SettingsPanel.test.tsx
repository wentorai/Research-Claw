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
function makeGatewayConfig(
  textModel = 'test-model',
  provider = 'custom',
  baseUrl = 'https://api.example.com/v1',
  overrides?: {
    apiKey?: string;
    extraProviders?: Record<string, Record<string, unknown>>;
  },
) {
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
          ...(overrides?.apiKey ? { apiKey: overrides.apiKey } : {}),
          models: [{ id: textModel, name: textModel }],
        },
        ...(overrides?.extraProviders ?? {}),
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

function clickConfigSaveButton(): void {
  const saveButtons = screen.getAllByRole('button', { name: /settings\.save|setup\.gatewayRestarting/i });
  const configButton = saveButtons.find((button) => button.parentElement?.textContent?.includes('settings.restartHint')) ?? saveButtons[0];
  fireEvent.click(configButton);
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
      pendingConfigRestart: false,
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
      pendingConfigRestart: false,
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

describe('API key status guidance', () => {
  beforeEach(() => {
    mockModalConfirm.mockReset();
    mockMessageSuccess.mockReset();
    mockMessageError.mockReset();
    useConfigStore.setState({
      theme: 'dark',
      locale: 'en',
      systemPromptAppend: '',
      bootState: 'ready',
      pendingConfigRestart: false,
      gatewayConfig: null,
      gatewayConfigLoading: false,
      _configRetryCount: 0,
    });
    useGatewayStore.setState({
      client: createMockClient(),
      state: 'connected',
      serverVersion: '0.5.11',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows keep-current-key guidance via placeholder when the current provider already has a configured key', () => {
    useConfigStore.setState({
      gatewayConfig: makeGatewayConfig('gpt-4o', 'openai', 'https://api.openai.com/v1', {
        apiKey: '__OPENCLAW_REDACTED__',
      }),
    });

    render(<SettingsPanel />);

    expect(screen.getByPlaceholderText('setup.apiKeyExisting')).toBeTruthy();
    expect(screen.getByText(/settings\.providerConfigured/)).toBeTruthy();
  });

  it('shows replace guidance after typing a new API key', () => {
    useConfigStore.setState({
      gatewayConfig: makeGatewayConfig('gpt-4o', 'openai', 'https://api.openai.com/v1', {
        apiKey: '__OPENCLAW_REDACTED__',
      }),
    });

    render(<SettingsPanel />);

    const apiKeyInput = screen.getByPlaceholderText('setup.apiKeyExisting');
    fireEvent.change(apiKeyInput, { target: { value: 'sk-new-openai-key' } });

    expect(screen.getAllByText('settings.apiKeyWillUpdate').length).toBeGreaterThan(0);
  });

  it('shows delete guidance after clearing an existing API key', () => {
    useConfigStore.setState({
      gatewayConfig: makeGatewayConfig('gpt-4o', 'openai', 'https://api.openai.com/v1', {
        apiKey: '__OPENCLAW_REDACTED__',
      }),
    });

    render(<SettingsPanel />);

    fireEvent.click(screen.getByText('settings.clearApiKey'));

    expect(screen.getAllByText('settings.apiKeyDeletePending').length).toBeGreaterThan(0);
  });

  it('removes "configured" suffix from provider button after clearing API key', () => {
    useConfigStore.setState({
      gatewayConfig: makeGatewayConfig('gpt-4o', 'openai', 'https://api.openai.com/v1', {
        apiKey: '__OPENCLAW_REDACTED__',
      }),
    });

    render(<SettingsPanel />);

    // Before clear: suffix is visible
    expect(screen.getByText(/settings\.providerConfigured/)).toBeTruthy();

    fireEvent.click(screen.getByText('settings.clearApiKey'));

    // After clear: suffix must disappear immediately
    expect(screen.queryByText(/settings\.providerConfigured/)).toBeNull();
  });

  it('does not keep the existing-key placeholder after clear is requested', () => {
    useConfigStore.setState({
      gatewayConfig: makeGatewayConfig('gpt-4o', 'openai', 'https://api.openai.com/v1', {
        apiKey: '__OPENCLAW_REDACTED__',
      }),
    });

    render(<SettingsPanel />);

    fireEvent.click(screen.getByText('settings.clearApiKey'));

    expect(screen.queryByPlaceholderText('setup.apiKeyExisting')).toBeNull();
    expect(screen.getByPlaceholderText('setup.apiKeyPlaceholder')).toBeTruthy();
  });

  it('marks inactive providers with configured status in the provider picker labels', () => {
    useConfigStore.setState({
      gatewayConfig: makeGatewayConfig('gpt-4o', 'openai', 'https://api.openai.com/v1', {
        apiKey: '__OPENCLAW_REDACTED__',
        extraProviders: {
          anthropic: {
            baseUrl: 'https://api.anthropic.com/v1',
            api: 'anthropic-messages',
            apiKey: '__OPENCLAW_REDACTED__',
            models: [{ id: 'claude-sonnet-4-5', name: 'claude-sonnet-4-5' }],
          },
        },
      }),
    });

    render(<SettingsPanel />);

    expect(screen.getByText(/OpenAI · settings\.providerConfigured/)).toBeTruthy();
  });

  it('writes the current provider key into auth-profiles before applying config', async () => {
    const mockRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'rc.auth.statuses') return Promise.resolve({ openai: { configured: true } });
      if (method === 'config.get') {
        return Promise.resolve({
          config: makeGatewayConfig('gpt-4o', 'openai', 'https://api.openai.com/v1', {
            apiKey: '__OPENCLAW_REDACTED__',
          }),
          hash: 'hash123',
        });
      }
      if (method === 'rc.auth.setApiKey') return Promise.resolve({ ok: true, provider: 'openai', profileId: 'openai:manual' });
      if (method === 'config.apply') return Promise.resolve({});
      return Promise.resolve({});
    });

    useGatewayStore.setState({ client: createMockClient(mockRequest) });
    useConfigStore.setState({
      gatewayConfig: makeGatewayConfig('gpt-4o', 'openai', 'https://api.openai.com/v1', {
        apiKey: '__OPENCLAW_REDACTED__',
      }),
    });

    render(<SettingsPanel />);
    expect(screen.getByDisplayValue('gpt-4o')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('setup.apiKeyExisting'), {
      target: { value: 'sk-fresh-openai' },
    });
    clickConfigSaveButton();

    const confirmCall = mockModalConfirm.mock.calls[0][0] as { onOk: () => Promise<void> };
    await confirmCall.onOk();

    expect(mockRequest).toHaveBeenCalledWith('rc.auth.setApiKey', {
      provider: 'openai',
      apiKey: 'sk-fresh-openai',
    });
    expect(mockRequest).toHaveBeenCalledWith('config.apply', expect.any(Object));
  });

  it('clears the auth-profile key when the user removes it and saves', async () => {
    const mockRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'rc.auth.statuses') return Promise.resolve({ openai: { configured: true } });
      if (method === 'config.get') {
        return Promise.resolve({
          config: makeGatewayConfig('gpt-4o', 'openai', 'https://api.openai.com/v1', {
            apiKey: '__OPENCLAW_REDACTED__',
          }),
          hash: 'hash456',
        });
      }
      if (method === 'rc.auth.clearApiKey') return Promise.resolve({ ok: true, provider: 'openai', removed: ['openai:manual'] });
      if (method === 'config.apply') return Promise.resolve({});
      return Promise.resolve({});
    });

    useGatewayStore.setState({ client: createMockClient(mockRequest) });
    useConfigStore.setState({
      gatewayConfig: makeGatewayConfig('gpt-4o', 'openai', 'https://api.openai.com/v1', {
        apiKey: '__OPENCLAW_REDACTED__',
      }),
    });

    render(<SettingsPanel />);
    expect(screen.getByDisplayValue('gpt-4o')).toBeTruthy();

    fireEvent.click(screen.getByText('settings.clearApiKey'));
    clickConfigSaveButton();

    const confirmCall = mockModalConfirm.mock.calls[0][0] as { onOk: () => Promise<void> };
    await confirmCall.onOk();

    expect(mockRequest).toHaveBeenCalledWith('rc.auth.clearApiKey', {
      provider: 'openai',
    });
  });

  it('does not write the redacted sentinel back into config when only auth-profiles has the key', async () => {
    const mockRequest = vi.fn().mockImplementation((method: string, params?: unknown) => {
      if (method === 'rc.auth.statuses') return Promise.resolve({ 'zai-coding': { configured: true } });
      if (method === 'config.get') {
        return Promise.resolve({
          config: makeGatewayConfig('glm-5', 'zai-coding', 'https://open.bigmodel.cn/api/coding/paas/v4'),
          hash: 'hash789',
        });
      }
      if (method === 'config.apply') return Promise.resolve({});
      return Promise.resolve({});
    });

    useGatewayStore.setState({ client: createMockClient(mockRequest) });
    useConfigStore.setState({
      gatewayConfig: makeGatewayConfig('glm-5', 'zai-coding', 'https://open.bigmodel.cn/api/coding/paas/v4'),
    });

    render(<SettingsPanel />);
    expect(screen.getByDisplayValue('glm-5')).toBeTruthy();

    clickConfigSaveButton();

    const confirmCall = mockModalConfirm.mock.calls[0][0] as { onOk: () => Promise<void> };
    await confirmCall.onOk();

    const applyCall = mockRequest.mock.calls.find((call: unknown[]) => call[0] === 'config.apply');
    expect(applyCall).toBeTruthy();
    const applyPayload = applyCall?.[1] as { raw: string };
    expect(applyPayload.raw).not.toContain('__OPENCLAW_REDACTED__');
  });

  it('preserves a previously seen redacted provider when a later config.get snapshot omits it', async () => {
    const initialProjectConfig = {
      agents: {
        defaults: {
          model: { primary: 'zai-coding-global/glm-5' },
          imageModel: { primary: 'zai-coding-global/glm-5' },
        },
      },
      models: {
        providers: {
          'zai-coding-global': {
            baseUrl: 'https://api.z.ai/api/coding/paas/v4',
            api: 'openai-completions',
            apiKey: '__OPENCLAW_REDACTED__',
            models: [{ id: 'glm-5', name: 'glm-5' }],
          },
        },
      },
    };

    const minimaxOnlyProjectConfig = {
      agents: {
        defaults: {
          model: { primary: 'minimax/MiniMax-M2.7' },
          imageModel: { primary: 'minimax/MiniMax-M2.7' },
        },
      },
      models: {
        providers: {
          minimax: {
            baseUrl: 'https://api.minimax.io/anthropic',
            api: 'anthropic-messages',
            apiKey: '__OPENCLAW_REDACTED__',
            models: [{ id: 'MiniMax-M2.7', name: 'MiniMax-M2.7' }],
          },
        },
      },
    };

    const mockRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'rc.auth.statuses') return Promise.resolve({});
      if (method === 'config.get') {
        return Promise.resolve({
          config: minimaxOnlyProjectConfig,
          hash: 'hash-preserve-provider',
        });
      }
      if (method === 'config.apply') return Promise.resolve({});
      return Promise.resolve({});
    });

    useGatewayStore.setState({ client: createMockClient(mockRequest) });
    useConfigStore.setState({
      gatewayConfig: {
        ...(initialProjectConfig as ReturnType<typeof makeGatewayConfig>),
        projectConfig: initialProjectConfig,
      },
    });

    render(<SettingsPanel />);
    expect(screen.getByDisplayValue('glm-5')).toBeTruthy();

    act(() => {
      useConfigStore.setState({
        gatewayConfig: {
          ...(minimaxOnlyProjectConfig as ReturnType<typeof makeGatewayConfig>),
          projectConfig: minimaxOnlyProjectConfig,
        },
      });
    });

    clickConfigSaveButton();

    const confirmCall = mockModalConfirm.mock.calls[0][0] as { onOk: () => Promise<void> };
    await confirmCall.onOk();

    const applyCall = mockRequest.mock.calls.find((call: unknown[]) => call[0] === 'config.apply');
    expect(applyCall).toBeTruthy();
    const applyPayload = applyCall?.[1] as { raw: string };
    expect(applyPayload.raw).toContain('"zai-coding-global"');
    expect(applyPayload.raw).toContain('__OPENCLAW_REDACTED__');
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
      pendingConfigRestart: false,
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
