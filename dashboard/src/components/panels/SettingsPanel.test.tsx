import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import React from 'react';
import SettingsPanel from './SettingsPanel';
import { useConfigStore } from '../../stores/config';
import { useGatewayStore } from '../../stores/gateway';
import { serializeConfigForGatewayApply } from '../../utils/config-patch';

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
  const saveButtons = screen.getAllByRole('button', { name: /settings\.(save|apply)|setup\.gatewayRestarting/i });
  const configButton = saveButtons.find((button) => button.parentElement?.textContent?.includes('settings.restartHint')) ?? saveButtons[0];
  fireEvent.click(configButton);
}

/** The footer Save/Apply button (label is dynamic), located via its sibling restart hint. */
function getConfigActionButton(): HTMLButtonElement {
  const candidates = screen
    .getAllByRole('button')
    .filter((b) => /settings\.(save|apply)|setup\.gatewayRestarting/.test(b.textContent ?? ''));
  const btn =
    candidates.find((b) => b.parentElement?.textContent?.includes('settings.restartHint')) ?? candidates[0];
  return btn as HTMLButtonElement;
}

/**
 * The "Saved API profiles" list lives inside a collapsed-by-default Collapse,
 * so its items are unmounted until the panel header is clicked open. Tests that
 * interact with inline profile cards must expand it first.
 */
function expandApiProfiles(): void {
  act(() => {
    fireEvent.click(screen.getByText('settings.apiProfilesTitle'));
  });
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
// Footer save hints — bullet list + color
// ============================================================

describe('Footer save hints — bullet list + color', () => {
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
    useGatewayStore.setState({ state: 'connected', client: createMockClient(), serverVersion: '0.42.0' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the missing-key hint as a red (danger) bullet while the restart hint stays neutral', () => {
    // makeGatewayConfig() omits apiKey → provider reports "no API key configured".
    useConfigStore.setState({ gatewayConfig: makeGatewayConfig() });
    render(<SettingsPanel />);

    // Restart hint is neutral (secondary), never danger.
    const restart = screen.getByText('settings.restartHint');
    expect(restart.className).toContain('ant-typography-secondary');
    expect(restart.className).not.toContain('ant-typography-danger');

    // The footer renders the missing-key status as a danger (red) element.
    const dangerMissing = screen
      .getAllByText('settings.apiKeyMissing')
      .find((el) => el.className.includes('ant-typography-danger'));
    expect(dangerMissing).toBeTruthy();

    // Hints are bulleted — at least the restart + missing-key bullets are present.
    expect(screen.getAllByText('•').length).toBeGreaterThanOrEqual(2);
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

    // Dirty the form so the Save button is enabled (Save is gated on changes).
    fireEvent.change(screen.getByDisplayValue('old-model'), { target: { value: 'old-model-edited' } });

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
      gatewayConfig: makeGatewayConfig('deepseek-v4-pro', 'deepseek', 'https://api.deepseek.com', {
        apiKey: '__OPENCLAW_REDACTED__',
      }),
    });

    render(<SettingsPanel />);

    expect(screen.getByPlaceholderText('setup.apiKeyExisting')).toBeTruthy();
    // The configured deepseek preset now also surfaces as a saved API profile
    // row, so the "configured" suffix can appear on both the provider button
    // and the profile row.
    expect(screen.getAllByText(/settings\.providerConfigured/).length).toBeGreaterThan(0);
  });

  it('shows replace guidance after typing a new API key', () => {
    useConfigStore.setState({
      gatewayConfig: makeGatewayConfig('deepseek-v4-pro', 'deepseek', 'https://api.deepseek.com', {
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
      gatewayConfig: makeGatewayConfig('deepseek-v4-pro', 'deepseek', 'https://api.deepseek.com', {
        apiKey: '__OPENCLAW_REDACTED__',
      }),
    });

    render(<SettingsPanel />);

    fireEvent.click(screen.getByText('settings.clearApiKey'));

    expect(screen.getAllByText('settings.apiKeyDeletePending').length).toBeGreaterThan(0);
  });

  it('removes "configured" suffix from provider button after clearing API key', () => {
    useConfigStore.setState({
      gatewayConfig: makeGatewayConfig('deepseek-v4-pro', 'deepseek', 'https://api.deepseek.com', {
        apiKey: '__OPENCLAW_REDACTED__',
      }),
    });

    render(<SettingsPanel />);

    // Before clear: the provider button shows the configured suffix.
    // (Scope to the button label form "DeepSeek · …" so the saved-profile
    // row's own "configured" suffix does not interfere.)
    expect(screen.getByText(/DeepSeek · settings\.providerConfigured/)).toBeTruthy();

    fireEvent.click(screen.getByText('settings.clearApiKey'));

    // After clear: the provider button suffix must disappear immediately.
    expect(screen.queryByText(/DeepSeek · settings\.providerConfigured/)).toBeNull();
  });

  it('does not keep the existing-key placeholder after clear is requested', () => {
    useConfigStore.setState({
      gatewayConfig: makeGatewayConfig('deepseek-v4-pro', 'deepseek', 'https://api.deepseek.com', {
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
      gatewayConfig: makeGatewayConfig('deepseek-v4-pro', 'deepseek', 'https://api.deepseek.com', {
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

    expect(screen.getByText(/DeepSeek · settings\.providerConfigured/)).toBeTruthy();
  });

  it('sends the current provider key with the atomic provider upsert', async () => {
    const mockRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'rc.auth.statuses') return Promise.resolve({ deepseek: { configured: true } });
      if (method === 'config.get') {
        return Promise.resolve({
          config: makeGatewayConfig('deepseek-v4-pro', 'deepseek', 'https://api.deepseek.com', {
            apiKey: '__OPENCLAW_REDACTED__',
          }),
          hash: 'hash123',
        });
      }
      if (method === 'rc.auth.setApiKey') return Promise.resolve({ ok: true, provider: 'deepseek', profileId: 'deepseek:manual' });
      if (method === 'config.apply') return Promise.resolve({});
      return Promise.resolve({});
    });

    useGatewayStore.setState({ client: createMockClient(mockRequest) });
    useConfigStore.setState({
      gatewayConfig: makeGatewayConfig('deepseek-v4-pro', 'deepseek', 'https://api.deepseek.com', {
        apiKey: '__OPENCLAW_REDACTED__',
      }),
    });

    render(<SettingsPanel />);
    expect(screen.getByDisplayValue('deepseek-v4-pro')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('setup.apiKeyExisting'), {
      target: { value: 'sk-fresh-openai' },
    });
    clickConfigSaveButton();

    const confirmCall = mockModalConfirm.mock.calls[0][0] as { onOk: () => Promise<void> };
    await confirmCall.onOk();

    expect(mockRequest).toHaveBeenCalledWith('rc.provider.upsert', expect.objectContaining({
      desiredConfig: expect.any(Object),
      authActions: [{ provider: 'deepseek', apiKey: 'sk-fresh-openai' }],
    }));
  });

  it('clears the auth-profile key when the user removes it and saves', async () => {
    const mockRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'rc.auth.statuses') return Promise.resolve({ deepseek: { configured: true } });
      if (method === 'config.get') {
        return Promise.resolve({
          config: makeGatewayConfig('deepseek-v4-pro', 'deepseek', 'https://api.deepseek.com', {
            apiKey: '__OPENCLAW_REDACTED__',
          }),
          hash: 'hash456',
        });
      }
      if (method === 'rc.auth.clearApiKey') return Promise.resolve({ ok: true, provider: 'deepseek', removed: ['deepseek:manual'] });
      if (method === 'config.apply') return Promise.resolve({});
      return Promise.resolve({});
    });

    useGatewayStore.setState({ client: createMockClient(mockRequest) });
    useConfigStore.setState({
      gatewayConfig: makeGatewayConfig('deepseek-v4-pro', 'deepseek', 'https://api.deepseek.com', {
        apiKey: '__OPENCLAW_REDACTED__',
      }),
    });

    render(<SettingsPanel />);
    expect(screen.getByDisplayValue('deepseek-v4-pro')).toBeTruthy();

    fireEvent.click(screen.getByText('settings.clearApiKey'));
    clickConfigSaveButton();

    const confirmCall = mockModalConfirm.mock.calls[0][0] as { onOk: () => Promise<void> };
    await confirmCall.onOk();

    expect(mockRequest).toHaveBeenCalledWith('rc.provider.upsert', expect.objectContaining({
      authActions: [{ provider: 'deepseek', clear: true }],
    }));
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

    // Dirty the form so the Save button is enabled (Save is gated on changes).
    fireEvent.change(screen.getByDisplayValue('glm-5'), { target: { value: 'glm-5-edited' } });

    clickConfigSaveButton();

    const confirmCall = mockModalConfirm.mock.calls[0][0] as { onOk: () => Promise<void> };
    await confirmCall.onOk();

    const upsertCall = mockRequest.mock.calls.find((call: unknown[]) => call[0] === 'rc.provider.upsert');
    expect(upsertCall).toBeTruthy();
    const upsertPayload = upsertCall?.[1] as { desiredConfig: Record<string, unknown> };
    expect(JSON.stringify(upsertPayload.desiredConfig)).not.toContain('__OPENCLAW_REDACTED__');
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

    // Form keeps the stale glm-5 (syncNeeded false); dirty it so Save is enabled.
    fireEvent.change(screen.getByDisplayValue('glm-5'), { target: { value: 'glm-5-edited' } });

    clickConfigSaveButton();

    const confirmCall = mockModalConfirm.mock.calls[0][0] as { onOk: () => Promise<void> };
    await confirmCall.onOk();

    const upsertCall = mockRequest.mock.calls.find((call: unknown[]) => call[0] === 'rc.provider.upsert');
    expect(upsertCall).toBeTruthy();
    const upsertPayload = upsertCall?.[1] as { desiredConfig: Record<string, unknown> };
    const serialized = JSON.stringify(upsertPayload.desiredConfig);
    expect(serialized).toContain('"zai-coding-global"');
    expect(serialized).not.toContain('__OPENCLAW_REDACTED__');
  });
});

// ============================================================
// Saved API profile switch ("Use" / 切换)
// ============================================================

describe('Saved API profile switch', () => {
  /** Config with two custom profiles; custom-relay-a is active. */
  function makeTwoProfileConfig() {
    return {
      agents: {
        defaults: {
          model: { primary: 'custom-relay-a/m0' },
          imageModel: { primary: 'custom-relay-a/m0' },
        },
      },
      models: {
        providers: {
          'custom-relay-a': {
            baseUrl: 'https://a.example/v1',
            api: 'openai-completions',
            apiKey: '__OPENCLAW_REDACTED__',
            models: [{ id: 'm0', name: 'Relay A' }],
          },
          'custom-relay-b': {
            baseUrl: 'https://b.example/v1',
            api: 'openai-completions',
            apiKey: '__OPENCLAW_REDACTED__',
            models: [{ id: 'gpt-4o', name: 'Relay B' }],
          },
        },
      },
    };
  }

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
      serverVersion: '0.7.1',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('upserts a config whose primary points at the target profile and shows success', async () => {
    const mockRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'rc.auth.statuses') return Promise.resolve({});
      if (method === 'config.get') {
        return Promise.resolve({ config: makeTwoProfileConfig(), hash: 'hash-switch' });
      }
      if (method === 'rc.provider.upsert') return Promise.resolve({});
      return Promise.resolve({});
    });

    useGatewayStore.setState({ client: createMockClient(mockRequest) });
    useConfigStore.setState({ gatewayConfig: makeTwoProfileConfig() });

    render(<SettingsPanel />);
    expandApiProfiles();

    // The non-active profile (Relay B) exposes a "Use" control.
    const useButton = screen.getByText('settings.apiProfilesUse');
    await act(async () => {
      fireEvent.click(useButton);
    });

    const upsertCall = mockRequest.mock.calls.find((call: unknown[]) => call[0] === 'rc.provider.upsert');
    expect(upsertCall).toBeTruthy();
    const upsertPayload = upsertCall?.[1] as { desiredConfig: Record<string, unknown> };
    const defaults = (upsertPayload.desiredConfig.agents as Record<string, unknown>).defaults as Record<string, unknown>;
    expect((defaults.model as { primary?: string }).primary).toBe('custom-relay-b/gpt-4o');

    // Switching must not drop the non-target provider entry from the upsert payload.
    const providers = (
      (upsertPayload.desiredConfig.models as Record<string, unknown>).providers as Record<string, unknown>
    );
    expect(providers['custom-relay-a']).toBeDefined();

    expect(mockMessageSuccess).toHaveBeenCalled();
    expect(mockMessageError).not.toHaveBeenCalled();
  });

  it('shows an error message when the switch upsert rejects', async () => {
    const mockRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'rc.auth.statuses') return Promise.resolve({});
      if (method === 'config.get') {
        return Promise.resolve({ config: makeTwoProfileConfig(), hash: 'hash-switch' });
      }
      if (method === 'rc.provider.upsert') return Promise.reject(new Error('switch failed'));
      return Promise.resolve({});
    });

    useGatewayStore.setState({ client: createMockClient(mockRequest) });
    useConfigStore.setState({ gatewayConfig: makeTwoProfileConfig() });

    render(<SettingsPanel />);
    expandApiProfiles();

    const useButton = screen.getByText('settings.apiProfilesUse');
    await act(async () => {
      fireEvent.click(useButton);
    });

    expect(mockMessageError).toHaveBeenCalled();
    expect(mockMessageSuccess).not.toHaveBeenCalled();
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

    // Should have called config.get then config.apply with serialized snapshot config
    expect(mockRequest).toHaveBeenCalledWith('config.get', {});
    expect(mockRequest).toHaveBeenCalledWith('config.apply', {
      raw: serializeConfigForGatewayApply(makeGatewayConfig()),
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

// ============================================================
// Save button dirty gating — disabled until a config field changes
// ============================================================

describe('Save button dirty gating', () => {
  function getConfigSaveButton(): HTMLButtonElement {
    const saveButtons = screen.getAllByRole('button', { name: /settings\.save|setup\.gatewayRestarting/i });
    const btn = saveButtons.find((b) => b.parentElement?.textContent?.includes('settings.restartHint')) ?? saveButtons[0];
    return btn as HTMLButtonElement;
  }

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
      serverVersion: '0.6.3',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('disables the save button when the form matches the loaded config', () => {
    useConfigStore.setState({ gatewayConfig: makeGatewayConfig('m1', 'openai', 'https://api.openai.com/v1') });

    render(<SettingsPanel />);

    expect(getConfigSaveButton().disabled).toBe(true);
  });

  it('enables the save button after editing a config field', () => {
    useConfigStore.setState({ gatewayConfig: makeGatewayConfig('m1', 'openai', 'https://api.openai.com/v1') });

    render(<SettingsPanel />);
    expect(getConfigSaveButton().disabled).toBe(true);

    fireEvent.change(screen.getByDisplayValue('m1'), { target: { value: 'm2' } });

    expect(getConfigSaveButton().disabled).toBe(false);
  });

  it('disables the save button again when the edit is reverted to the baseline', () => {
    useConfigStore.setState({ gatewayConfig: makeGatewayConfig('m1', 'openai', 'https://api.openai.com/v1') });

    render(<SettingsPanel />);

    const modelInput = screen.getByDisplayValue('m1');
    fireEvent.change(modelInput, { target: { value: 'm2' } });
    expect(getConfigSaveButton().disabled).toBe(false);

    fireEvent.change(screen.getByDisplayValue('m2'), { target: { value: 'm1' } });
    expect(getConfigSaveButton().disabled).toBe(true);
  });
});

// ============================================================
// Model tuning field (context window) must dirty the form, and a sub-floor
// window is auto-raised to the floor on save with a toast (never blocked).
// Regression: editing the window once left the Save button stuck disabled
// because it was absent from the dirty signature (formSignature).
// ============================================================

describe('Model tuning field dirty gating + save-time clamp', () => {
  function getConfigSaveButton(): HTMLButtonElement {
    const saveButtons = screen.getAllByRole('button', { name: /settings\.save|setup\.gatewayRestarting/i });
    const btn = saveButtons.find((b) => b.parentElement?.textContent?.includes('settings.restartHint')) ?? saveButtons[0];
    return btn as HTMLButtonElement;
  }

  // Manual endpoint (ollama) so the contextWindow input renders.
  function makeManualTuningConfig() {
    return makeGatewayConfig('m1', 'ollama', 'http://localhost:11434/v1');
  }

  beforeEach(() => {
    mockModalConfirm.mockReset();
    mockMessageSuccess.mockReset();
    mockMessageError.mockReset();
    mockMessageWarning.mockReset();
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
      serverVersion: '0.6.3',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enables the save button after editing the context window', () => {
    useConfigStore.setState({ gatewayConfig: makeManualTuningConfig() });

    render(<SettingsPanel />);
    expect(getConfigSaveButton().disabled).toBe(true);

    // The tuning input lives inside the collapsed "advanced" panel; expand it first.
    fireEvent.click(screen.getByText('settings.advancedTextEndpoint'));

    // Only one tuning input now (contextWindow); the history-share knob was removed.
    const tuningInputs = screen.getAllByPlaceholderText('settings.tuning.autoPlaceholder');
    expect(tuningInputs).toHaveLength(1);
    fireEvent.change(tuningInputs[0], { target: { value: '48000' } });
    fireEvent.blur(tuningInputs[0]);

    expect(getConfigSaveButton().disabled).toBe(false);
  });

  it('auto-raises a sub-floor window to the floor on save, toasts, and writes no reserve override', async () => {
    const mockRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'rc.auth.statuses') return Promise.resolve({});
      if (method === 'config.get') {
        return Promise.resolve({ config: makeManualTuningConfig(), hash: 'hash-clamp' });
      }
      if (method === 'rc.provider.upsert') return Promise.resolve({});
      if (method === 'config.apply') return Promise.resolve({});
      return Promise.resolve({});
    });
    useGatewayStore.setState({ client: createMockClient(mockRequest) });
    useConfigStore.setState({ gatewayConfig: makeManualTuningConfig() });

    render(<SettingsPanel />);
    fireEvent.click(screen.getByText('settings.advancedTextEndpoint'));

    // Enter a window below CONTEXT_WINDOW_MIN (64000). The input min is intentionally
    // low (1024) so the value survives blur and the save-time clamp is what raises it.
    const tuningInput = screen.getAllByPlaceholderText('settings.tuning.autoPlaceholder')[0];
    fireEvent.change(tuningInput, { target: { value: '8000' } });
    fireEvent.blur(tuningInput);

    clickConfigSaveButton();
    const confirmCall = mockModalConfirm.mock.calls[0][0] as { onOk: () => Promise<void> };
    await act(async () => {
      await confirmCall.onOk();
    });

    // A warning toast (i18n key) tells the user the window was raised to the floor.
    expect(mockMessageWarning).toHaveBeenCalledWith('settings.tuning.contextWindowClamped');

    const upsertCall = mockRequest.mock.calls.find((c: unknown[]) => c[0] === 'rc.provider.upsert');
    expect(upsertCall).toBeTruthy();
    const desired = (upsertCall?.[1] as { desiredConfig: Record<string, unknown> }).desiredConfig;
    const card = (
      (desired.models as { providers: Record<string, { models: Array<{ contextWindow?: number }> }> })
        .providers.ollama.models[0]
    );
    expect(card.contextWindow).toBe(64_000);

    const compaction = (
      (desired.agents as { defaults: { compaction: Record<string, unknown> } }).defaults.compaction
    );
    // Reserve is OC-owned now; RC writes only the strategy mode.
    expect(compaction.reserveTokens).toBeUndefined();
    expect(compaction.reserveTokensFloor).toBeUndefined();
    expect(compaction.maxHistoryShare).toBeUndefined();
  });
});

describe('Delete active profile re-baselines the form', () => {
  function getConfigSaveButton(): HTMLButtonElement {
    const saveButtons = screen.getAllByRole('button', {
      name: /settings\.(save|apply)|setup\.gatewayRestarting/i,
    });
    const btn =
      saveButtons.find((b) => b.parentElement?.textContent?.includes('settings.restartHint')) ??
      saveButtons[0];
    return btn as HTMLButtonElement;
  }

  /** Two custom profiles; custom-relay-a is the active one. */
  function makeTwoProfileConfig() {
    return {
      agents: {
        defaults: {
          model: { primary: 'custom-relay-a/m0' },
          imageModel: { primary: 'custom-relay-a/m0' },
        },
      },
      models: {
        providers: {
          'custom-relay-a': {
            baseUrl: 'https://a.example/v1',
            api: 'openai-completions',
            apiKey: '__OPENCLAW_REDACTED__',
            models: [{ id: 'm0', name: 'Relay A' }],
          },
          'custom-relay-b': {
            baseUrl: 'https://b.example/v1',
            api: 'openai-completions',
            apiKey: '__OPENCLAW_REDACTED__',
            models: [{ id: 'gpt-4o', name: 'Relay B' }],
          },
        },
      },
    };
  }

  /** Config after deleting custom-relay-a — primary falls back to relay-b. */
  function makePostDeleteConfig() {
    return {
      agents: {
        defaults: {
          model: { primary: 'custom-relay-b/gpt-4o' },
          imageModel: { primary: 'custom-relay-b/gpt-4o' },
        },
      },
      models: {
        providers: {
          'custom-relay-b': {
            baseUrl: 'https://b.example/v1',
            api: 'openai-completions',
            apiKey: '__OPENCLAW_REDACTED__',
            models: [{ id: 'gpt-4o', name: 'Relay B' }],
          },
        },
      },
    };
  }

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
      serverVersion: '0.7.1',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Deleting the active profile is a one-click action that already persists +
  // auto-switches to a remaining profile, so the footer must settle to a clean
  // disabled "Save" — not an enabled "Apply" demanding a second confirmation.
  it('disables the footer (Save, not Apply) after deleting the active profile', async () => {
    const mockRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'rc.auth.statuses') return Promise.resolve({});
      if (method === 'config.get') {
        return Promise.resolve({ config: makeTwoProfileConfig(), hash: 'hash-del' });
      }
      if (method === 'rc.provider.delete') return Promise.resolve({});
      return Promise.resolve({});
    });
    // The post-delete reload swaps in a new config reference so the hydration
    // effect fires (the fix relies on it re-baselining the form). The restart
    // also settles, clearing pendingConfigRestart — matching what the user sees.
    const loadGatewayConfig = vi.fn(async () => {
      useConfigStore.setState({
        gatewayConfig: makePostDeleteConfig(),
        pendingConfigRestart: false,
      });
    });

    useGatewayStore.setState({ client: createMockClient(mockRequest) });
    useConfigStore.setState({ gatewayConfig: makeTwoProfileConfig(), loadGatewayConfig });

    render(<SettingsPanel />);
    expect(getConfigSaveButton().disabled).toBe(true);
    expandApiProfiles();

    // The active profile (relay-a) shows an "In use" tag + a delete button.
    const inUse = screen.getByText('settings.apiProfilesInUse');
    const activeItem = inUse.closest('.ant-list-item') as HTMLElement;
    const deleteBtn = within(activeItem).getByRole('button');
    await act(async () => {
      fireEvent.click(deleteBtn);
    });

    // The delete button opens a confirm modal; invoke its onOk to confirm.
    const confirmArgs = mockModalConfirm.mock.calls.at(-1)?.[0] as { onOk: () => Promise<void> };
    expect(confirmArgs?.onOk).toBeTruthy();
    await act(async () => {
      await confirmArgs.onOk();
    });

    const footer = getConfigSaveButton();
    expect(footer.disabled).toBe(true);
    expect(footer.textContent).toContain('settings.save');
    expect(footer.textContent).not.toContain('settings.apply');
  });
});

// ============================================================
// Task 2: independent vision endpoint + protocol auto-align
// ============================================================

describe('Vision independent endpoint + protocol auto-align', () => {
  /** Text on openai, vision on a distinct custom-* profile. */
  function makeSeparateVisionConfig() {
    return {
      agents: {
        defaults: {
          model: { primary: 'openai/gpt-4o' },
          imageModel: { primary: 'custom-relay-b/qwen-vl' },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: 'https://api.openai.com/v1',
            api: 'openai-completions',
            apiKey: '__OPENCLAW_REDACTED__',
            models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
          },
          'custom-relay-b': {
            baseUrl: 'https://b.example/v1',
            api: 'openai-completions',
            apiKey: '__OPENCLAW_REDACTED__',
            models: [{ id: 'qwen-vl', name: 'Qwen VL' }],
          },
        },
      },
    };
  }

  /** Text and vision both on bare `custom` (same key → vision inherits). */
  function makeSharedVisionConfig() {
    return {
      agents: {
        defaults: {
          model: { primary: 'custom/text-model' },
          imageModel: { primary: 'custom/vision-model' },
        },
      },
      models: {
        providers: {
          custom: {
            baseUrl: 'https://api.example.com/v1',
            api: 'openai-completions',
            apiKey: '__OPENCLAW_REDACTED__',
            models: [
              { id: 'text-model', name: 'Text' },
              { id: 'vision-model', name: 'Vision' },
            ],
          },
        },
      },
    };
  }

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
      serverVersion: '0.7.1',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the vision URL, protocol Select, and key fields when vision uses a distinct custom profile', () => {
    useConfigStore.setState({ gatewayConfig: makeSeparateVisionConfig() });

    render(<SettingsPanel />);

    // Vision key field label is visible (top-level, outside the advanced Collapse)
    expect(screen.getByText('settings.visionApiKey')).toBeTruthy();
    // Vision advanced section is collapsed by default; its header still renders.
    expect(screen.getByText('settings.advancedVisionEndpoint')).toBeTruthy();
    // Expand it to reveal the URL + protocol fields.
    fireEvent.click(screen.getByText('settings.advancedVisionEndpoint'));

    // Vision URL field is visible with the vision provider's own baseUrl
    expect(screen.getByDisplayValue('https://b.example/v1')).toBeTruthy();
    // Protocol field renders (text provider is openai → no text protocol Select)
    expect(screen.getByText('settings.apiProtocol')).toBeTruthy();
  });

  it('auto-aligns the vision protocol to anthropic-messages when the vision URL contains /anthropic', () => {
    useConfigStore.setState({ gatewayConfig: makeSeparateVisionConfig() });

    render(<SettingsPanel />);

    // Vision advanced (URL + protocol) is collapsed by default — expand it first.
    fireEvent.click(screen.getByText('settings.advancedVisionEndpoint'));

    const visionUrlInput = screen.getByDisplayValue('https://b.example/v1');
    fireEvent.change(visionUrlInput, { target: { value: 'https://relay-b.example/anthropic' } });

    // The vision protocol Select now displays the Anthropic-compatible option label
    expect(screen.getByText('Anthropic Compatible')).toBeTruthy();
  });

  it('hides independent vision fields and shows the inherit hint when vision provider equals the text provider', () => {
    useConfigStore.setState({ gatewayConfig: makeSharedVisionConfig() });

    render(<SettingsPanel />);

    // No independent vision endpoint fields
    expect(screen.queryByText('settings.advancedVisionEndpoint')).toBeNull();
    expect(screen.queryByText('settings.visionApiKey')).toBeNull();
    // The inherit hint is shown
    expect(screen.getByText('settings.visionInheritsText')).toBeTruthy();
  });

  /** Text on openai + vision on openai (distinct model) → vision enabled and
   *  initially inheriting the text provider, with NO custom-* keys in config. */
  function makeVisionInheritsOpenaiConfig() {
    return {
      agents: {
        defaults: {
          model: { primary: 'openai/gpt-4o' },
          imageModel: { primary: 'openai/gpt-4o-vision' },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: 'https://api.openai.com/v1',
            api: 'openai-completions',
            apiKey: '__OPENCLAW_REDACTED__',
            models: [
              { id: 'gpt-4o', name: 'GPT-4o' },
              { id: 'gpt-4o-vision', name: 'GPT-4o Vision' },
            ],
          },
        },
      },
    };
  }

  it('allocates a vision provider key distinct from an in-flight (unsaved) text custom profile', () => {
    // Config has no custom-* keys: an in-flight text custom profile the user
    // just created via "Add custom profile" is NOT yet persisted, so it does
    // not appear in listApiProfilesFromConfig. The first such profile claims the
    // bare `custom` slot. When the user then creates a vision custom profile,
    // a naive allocator that only consulted the config-derived profile set would
    // re-pick `custom` and overwrite the in-flight text endpoint. The explicit
    // existingIds.add(provider) guard in beginNewVisionCustomProfile prevents
    // that collision.
    useConfigStore.setState({ gatewayConfig: makeVisionInheritsOpenaiConfig() });

    render(<SettingsPanel />);

    const openaiProviderButtons = () =>
      screen.getAllByRole('button').filter((b) => /^OpenAI/.test(b.textContent ?? ''));

    // Initially both the text and vision provider buttons read "OpenAI".
    expect(openaiProviderButtons().length).toBe(2);

    // 1) Create an in-flight TEXT custom profile → claims the bare `custom` key,
    //    which is NOT present in config (so config-listing cannot see it). The
    //    text provider button is the first of the two OpenAI buttons.
    fireEvent.click(openaiProviderButtons()[0]);
    act(() => {
      fireEvent.click(screen.getByText('providerPicker.addCustomProfile'));
    });

    // The text provider button now shows the in-flight `custom` key; no `custom-*`
    // slot exists yet.
    expect(screen.getAllByText('custom').length).toBeGreaterThan(0);
    expect(screen.queryByText(/^custom-/)).toBeNull();

    // 2) Create a VISION custom profile. The vision provider still reads OpenAI
    //    (it was never changed), so it is now the single remaining OpenAI button.
    const remainingOpenai = openaiProviderButtons();
    expect(remainingOpenai.length).toBe(1);
    fireEvent.click(remainingOpenai[0]);
    act(() => {
      // The vision picker mounts after the text picker in document order, so the
      // last "add custom profile" card belongs to the (now open) vision picker.
      const addCards = screen.getAllByText('providerPicker.addCustomProfile');
      fireEvent.click(addCards[addCards.length - 1]);
    });

    // The new vision profile MUST land on a key distinct from the in-flight text
    // `custom` provider — observable two ways through the public UI:
    //  (1) the separate vision-endpoint advanced section now renders — it only
    //      appears when visionProvider !== provider, so a collision back onto
    //      `custom` would have kept it hidden; and
    //  (2) a fresh `custom-*` provider key surfaces (the new vision slot) while
    //      the in-flight text `custom` key is still present, proving the text
    //      profile was not overwritten by the vision entry.
    expect(screen.getByText('settings.advancedVisionEndpoint')).toBeTruthy();
    expect(screen.getAllByText(/^custom-/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('custom').length).toBeGreaterThan(0);
  });
});

// ============================================================
// Task 3c: protocol probe ("Test" button) + state machine + logic locks
// ============================================================

describe('Protocol probe (Test button) — text endpoint', () => {
  /** A `custom` (API-profile) text endpoint (no key — tests type one in). */
  function makeProbeConfig() {
    return makeGatewayConfig('m1', 'custom', 'https://relay.example/v1');
  }

  /** Open the text endpoint advanced Collapse so the protocol Select + Test button render. */
  function openTextAdvanced() {
    fireEvent.click(screen.getByText('settings.advancedTextEndpoint'));
  }

  /** Open the vision endpoint advanced Collapse so its protocol Select + Test button render. */
  function openVisionAdvanced() {
    fireEvent.click(screen.getByText('settings.advancedVisionEndpoint'));
  }

  /** Type a key into the text endpoint API key input so probes are allowed.
   *  A configured-but-redacted key de-redacts to '' in form state, so the probe
   *  gate (`!apiKey.trim()`) requires an actually-typed key. */
  function typeTextKey(key = 'sk-test') {
    const input = screen.getByPlaceholderText('setup.apiKeyPlaceholder');
    fireEvent.change(input, { target: { value: key } });
  }

  /** The text endpoint's "Test" button. */
  function getTextTestButton(): HTMLButtonElement {
    return screen.getByRole('button', { name: /settings\.testProtocol/i }) as HTMLButtonElement;
  }

  beforeEach(() => {
    mockModalConfirm.mockReset();
    mockMessageSuccess.mockReset();
    mockMessageError.mockReset();
    mockMessageWarning.mockReset();
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
      serverVersion: '0.7.1',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('auto-applies the detected protocol and shows a verified indicator on success', async () => {
    const mockRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'rc.provider.probeProtocol') {
        return Promise.resolve({ detected: 'anthropic-messages', reason: 'detected', attempts: [] });
      }
      return Promise.resolve({});
    });
    useGatewayStore.setState({ client: createMockClient(mockRequest) });
    useConfigStore.setState({ gatewayConfig: makeProbeConfig() });

    render(<SettingsPanel />);
    openTextAdvanced();
    typeTextKey();

    // Before probing, the protocol Select shows the URL-inferred default (completions).
    expect(screen.getByText('OpenAI Compatible')).toBeTruthy();

    await act(async () => {
      fireEvent.click(getTextTestButton());
    });

    // The probe was called against the text endpoint.
    expect(mockRequest).toHaveBeenCalledWith(
      'rc.provider.probeProtocol',
      expect.objectContaining({ baseUrl: 'https://relay.example/v1' }),
    );
    // Protocol auto-applied to anthropic → Select now shows the anthropic label.
    expect(screen.getByText('Anthropic Compatible')).toBeTruthy();
    // A verified indicator is shown with the protocol label as plain text.
    expect(screen.getByText('settings.protocolVerified', { exact: false })).toBeTruthy();
    expect(mockMessageSuccess).toHaveBeenCalled();
  });

  it('shows a failure indicator and re-enables the Test button on no-protocol', async () => {
    const mockRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'rc.provider.probeProtocol') {
        return Promise.resolve({ detected: null, reason: 'no-protocol', attempts: [] });
      }
      return Promise.resolve({});
    });
    useGatewayStore.setState({ client: createMockClient(mockRequest) });
    useConfigStore.setState({ gatewayConfig: makeProbeConfig() });

    render(<SettingsPanel />);
    openTextAdvanced();
    typeTextKey();

    await act(async () => {
      fireEvent.click(getTextTestButton());
    });

    // Failure text is shown (mapped reason key) and an error toast fired.
    expect(screen.getByText('settings.probeNoProtocol', { exact: false })).toBeTruthy();
    expect(mockMessageError).toHaveBeenCalledWith('settings.probeNoProtocol');
    // The Test button is enabled again so the user can retry.
    expect(getTextTestButton().disabled).toBe(false);
  });

  it('locks Save and freezes the probed URL input while a probe is in flight', async () => {
    let resolveProbe: (v: unknown) => void = () => {};
    const deferred = new Promise((resolve) => {
      resolveProbe = resolve;
    });
    const mockRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'rc.provider.probeProtocol') return deferred;
      return Promise.resolve({});
    });
    useGatewayStore.setState({ client: createMockClient(mockRequest) });
    useConfigStore.setState({ gatewayConfig: makeProbeConfig() });

    render(<SettingsPanel />);
    openTextAdvanced();
    typeTextKey();

    // Dirty the form so Save would otherwise be enabled.
    fireEvent.change(screen.getByDisplayValue('m1'), { target: { value: 'm2' } });

    act(() => {
      fireEvent.click(getTextTestButton());
    });

    // While probing: Save disabled + URL input frozen.
    const saveButtons = screen.getAllByRole('button', { name: /settings\.save|setup\.gatewayRestarting/i });
    const saveBtn = (saveButtons.find((b) => b.parentElement?.textContent?.includes('settings.restartHint')) ?? saveButtons[0]) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
    expect((screen.getByDisplayValue('https://relay.example/v1') as HTMLInputElement).disabled).toBe(true);

    // Resolve so the finally unlocks (avoid the 24s race).
    await act(async () => {
      resolveProbe({ detected: 'openai-completions', reason: 'detected', attempts: [] });
    });

    expect((screen.getByDisplayValue('https://relay.example/v1') as HTMLInputElement).disabled).toBe(false);
  });

  it('disables the vision Test button while the text probe is in flight (single-flight)', async () => {
    let resolveProbe: (v: unknown) => void = () => {};
    const deferred = new Promise((resolve) => {
      resolveProbe = resolve;
    });
    const mockRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'rc.provider.probeProtocol') return deferred;
      return Promise.resolve({});
    });
    useGatewayStore.setState({ client: createMockClient(mockRequest) });

    // Text on `custom`, vision on a distinct `custom-vis` profile (no saved keys,
    // so the tests type their own) so both Test buttons render.
    const cfg = {
      agents: {
        defaults: {
          model: { primary: 'custom/m1' },
          imageModel: { primary: 'custom-vis/v1' },
        },
      },
      models: {
        providers: {
          custom: {
            baseUrl: 'https://relay.example/v1',
            api: 'openai-completions',
            models: [{ id: 'm1', name: 'm1' }],
          },
          'custom-vis': {
            baseUrl: 'https://vision.example/v1',
            api: 'openai-completions',
            models: [{ id: 'v1', name: 'v1' }],
          },
        },
      },
    };
    useConfigStore.setState({ gatewayConfig: cfg as ReturnType<typeof makeGatewayConfig> });

    render(<SettingsPanel />);
    openTextAdvanced();
    openVisionAdvanced();

    // Provide keys for both endpoints so their Test buttons are enabled.
    const keyInputs = screen.getAllByPlaceholderText('setup.apiKeyPlaceholder');
    fireEvent.change(keyInputs[0], { target: { value: 'sk-text' } });
    fireEvent.change(keyInputs[1], { target: { value: 'sk-vision' } });

    // Both endpoints expose a Test button (text + vision).
    const testButtonsBefore = screen.getAllByRole('button', { name: /settings\.testProtocol/i });
    expect(testButtonsBefore.length).toBe(2);

    // Start the text probe (first Test button).
    act(() => {
      fireEvent.click(testButtonsBefore[0]);
    });

    // All Test buttons are now disabled (text = loading/active, vision = single-flight lock).
    const testButtonsDuring = screen.getAllByRole('button', { name: /settings\.testProtocol/i });
    for (const btn of testButtonsDuring) {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    }

    await act(async () => {
      resolveProbe({ detected: 'openai-completions', reason: 'detected', attempts: [] });
    });
  });

  it('disables the Test button when the endpoint key is empty', () => {
    // Config with a `custom` provider but NO saved key → empty text key.
    useConfigStore.setState({
      gatewayConfig: makeGatewayConfig('m1', 'custom', 'https://relay.example/v1'),
    });

    render(<SettingsPanel />);
    openTextAdvanced();

    expect(getTextTestButton().disabled).toBe(true);
  });
});

describe('Config picker — re-select guard, draft card, Apply/Save label', () => {
  /** Text endpoint config with one or more saved custom profiles, vision OFF. */
  function makeProfilesConfig(extra?: Record<string, Record<string, unknown>>) {
    return {
      agents: { defaults: { model: { primary: 'custom/m1' } } },
      models: {
        providers: {
          custom: { baseUrl: 'https://a.example/v1', api: 'openai-completions', models: [{ id: 'm1', name: 'm1' }] },
          ...(extra ?? {}),
        },
      },
    } as unknown as ReturnType<typeof makeGatewayConfig>;
  }

  /** Open the text provider picker by clicking its trigger (text ends with the provider id). */
  function openProviderPicker(providerId: string) {
    const btn = screen.getAllByRole('button').find((b) => (b.textContent ?? '').endsWith(providerId));
    act(() => {
      fireEvent.click(btn as HTMLButtonElement);
    });
  }

  /** Click a card inside the open picker dialog by its visible text. */
  function clickPickerItem(text: string) {
    const dialog = screen.getByRole('dialog');
    act(() => {
      fireEvent.click(within(dialog).getAllByText(text)[0]);
    });
  }

  beforeEach(() => {
    // Auto-confirm the "non-recommended provider" caution so selections proceed.
    mockModalConfirm.mockReset();
    mockModalConfirm.mockImplementation((cfg: { onOk?: () => void }) => cfg.onOk?.());
    mockMessageSuccess.mockReset();
    mockMessageError.mockReset();
    mockMessageWarning.mockReset();
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
    useGatewayStore.setState({ client: createMockClient(), state: 'connected', serverVersion: '0.7.1' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Fix #1
  it('re-selecting the already-active provider does not dirty the form (Save stays disabled)', () => {
    useConfigStore.setState({ gatewayConfig: makeProfilesConfig() });
    render(<SettingsPanel />);

    // Not dirty on load → footer button disabled.
    expect(getConfigActionButton().disabled).toBe(true);

    openProviderPicker('custom');
    clickPickerItem('custom'); // re-pick the current provider → no-op guard

    expect(getConfigActionButton().disabled).toBe(true);
  });

  // Fix #1 (inline counterpart): clicking the already-active card in the inline
  // "Saved API profiles" list must be a no-op. Re-hydrating the active provider
  // re-derives fields via extractProviderFieldsForEditor, whose `api` falls back
  // to the preset default (e.g. minimax → anthropic-messages) while the baseline
  // came from extractConfigFields (openai-completions) — a spurious dirty.
  it('clicking the already-active inline profile card does not dirty the form', () => {
    useConfigStore.setState({
      gatewayConfig: {
        agents: { defaults: { model: { primary: 'minimax/MiniMax-M2.7' } } },
        models: {
          providers: {
            // No explicit `api` → the two extractors disagree on the api type.
            minimax: { baseUrl: 'https://api.minimax.io/anthropic', models: [{ id: 'MiniMax-M2.7', name: 'MiniMax M2.7' }] },
          },
        },
      } as unknown as ReturnType<typeof makeGatewayConfig>,
    });
    render(<SettingsPanel />);

    // Not dirty on load → footer button disabled.
    expect(getConfigActionButton().disabled).toBe(true);
    expandApiProfiles();

    // Click the active inline card (located via its "In use" tag).
    const card = screen.getByText('settings.apiProfilesInUse').closest('.ant-list-item') as HTMLElement;
    act(() => {
      fireEvent.click(card);
    });

    expect(getConfigActionButton().disabled).toBe(true);
  });

  // Root-cause regression: A → B → A must return to a not-dirty form. Re-hydrating
  // the original active provider must reproduce the load-time baseline exactly, so
  // the per-provider field extraction used on switch must agree with the one used
  // to seed the baseline (api preset fallback + provider-scoped profile label).
  it('switching to another provider and back to the original leaves the form not dirty', () => {
    useConfigStore.setState({
      gatewayConfig: {
        agents: { defaults: { model: { primary: 'minimax/MiniMax-M2.7' } } },
        models: {
          providers: {
            // Active provider omits `api` (so it relies on the preset default).
            minimax: { baseUrl: 'https://api.minimax.io/anthropic', models: [{ id: 'MiniMax-M2.7', name: 'MiniMax M2.7' }] },
            'custom-2': { baseUrl: 'https://b.example/v1', api: 'openai-completions', models: [{ id: 'm2', name: 'm2' }] },
          },
        },
      } as unknown as ReturnType<typeof makeGatewayConfig>,
    });
    render(<SettingsPanel />);
    expandApiProfiles();

    expect(getConfigActionButton().disabled).toBe(true);

    // A → B: switching the active provider dirties the form (needs Apply/Save).
    openProviderPicker('minimax');
    clickPickerItem('custom-2');
    expect(getConfigActionButton().disabled).toBe(false);

    // B → A: returning to the persisted active provider, with no edits, must be clean.
    const minimaxCard = screen
      .getAllByText('MiniMax (International)')
      .map((el) => el.closest('.ant-list-item'))
      .find(Boolean) as HTMLElement;
    act(() => {
      fireEvent.click(minimaxCard);
    });
    expect(getConfigActionButton().disabled).toBe(true);
  });

  // Fix #2
  it('shows an unsaved-draft card in the picker after clicking "Add custom profile"', () => {
    useConfigStore.setState({ gatewayConfig: makeProfilesConfig() });
    render(<SettingsPanel />);

    // The provider trigger node persists across re-renders — reuse it to re-open the picker
    // without depending on the auto-allocated draft id.
    const trigger = screen
      .getAllByRole('button')
      .find((b) => (b.textContent ?? '').endsWith('custom')) as HTMLButtonElement;

    act(() => fireEvent.click(trigger));
    clickPickerItem('providerPicker.addCustomProfile'); // closes picker, creates a custom-* draft
    act(() => fireEvent.click(trigger)); // re-open

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('providerPicker.unsavedDraft')).toBeTruthy();
    // A distinct draft card (id custom-*) is now listed alongside the saved `custom`.
    expect(within(dialog).getByText(/^custom-/)).toBeTruthy();
  });

  // Fix #3 (a)
  it('labels the footer button "Apply" when switching to another saved profile', () => {
    useConfigStore.setState({
      gatewayConfig: makeProfilesConfig({
        'custom-2': { baseUrl: 'https://b.example/v1', api: 'openai-completions', models: [{ id: 'm2', name: 'm2' }] },
      }),
    });
    render(<SettingsPanel />);

    openProviderPicker('custom');
    clickPickerItem('custom-2'); // switch to the other already-saved profile

    const btn = getConfigActionButton();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain('settings.apply');
  });

  // Fix #3 (b)
  it('labels the footer button "Save" for a brand-new draft profile', () => {
    useConfigStore.setState({ gatewayConfig: makeProfilesConfig() });
    render(<SettingsPanel />);

    openProviderPicker('custom');
    clickPickerItem('providerPicker.addCustomProfile'); // new draft → not a saved config

    const btn = getConfigActionButton();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain('settings.save');
    expect(btn.textContent).not.toContain('settings.apply');
  });

  // Fix #3 (c)
  it('labels the footer button "Save" when editing the active provider without switching', () => {
    useConfigStore.setState({ gatewayConfig: makeProfilesConfig() });
    render(<SettingsPanel />);

    const keyInput = screen.getByPlaceholderText('setup.apiKeyPlaceholder');
    fireEvent.change(keyInput, { target: { value: 'sk-edited' } });

    const btn = getConfigActionButton();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain('settings.save');
    expect(btn.textContent).not.toContain('settings.apply');
  });

  // Fix #3 (d)
  it('labels the footer button "Save" when editing a field after switching to a saved profile', () => {
    useConfigStore.setState({
      gatewayConfig: makeProfilesConfig({
        'custom-2': { baseUrl: 'https://b.example/v1', api: 'openai-completions', models: [{ id: 'm2', name: 'm2' }] },
      }),
    });
    render(<SettingsPanel />);

    openProviderPicker('custom');
    clickPickerItem('custom-2'); // pure switch → Apply

    expect(getConfigActionButton().textContent).toContain('settings.apply');

    // Editing any field after the switch introduces new data → Save, not Apply.
    const keyInput = screen.getByPlaceholderText('setup.apiKeyPlaceholder');
    act(() => {
      fireEvent.change(keyInput, { target: { value: 'sk-edited' } });
    });

    const btn = getConfigActionButton();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain('settings.save');
    expect(btn.textContent).not.toContain('settings.apply');
  });

  // Inline list ↔ picker parity: a draft created from the inline "Add" button
  // surfaces as an unsaved card in the inline profile list (same source as the picker).
  it('surfaces the just-added draft as an unsaved card in the inline profile list', () => {
    useConfigStore.setState({ gatewayConfig: makeProfilesConfig() });
    render(<SettingsPanel />);
    expandApiProfiles();

    // No draft marker before adding.
    expect(screen.queryByText('providerPicker.unsavedDraft')).toBeNull();

    // The "Add" control is a link button nested in the collapse header's `extra`.
    // Exclude the header itself (also role=button, text spans title + Add) so the
    // click hits Add (stopPropagation) instead of toggling the panel shut.
    const addBtn = screen
      .getAllByRole('button')
      .find(
        (b) =>
          (b.textContent ?? '').includes('settings.apiProfilesAdd') &&
          !(b.textContent ?? '').includes('settings.apiProfilesTitle'),
      ) as HTMLButtonElement;
    act(() => fireEvent.click(addBtn));

    // The inline list now renders the draft with the shared unsaved marker.
    expect(screen.getAllByText('providerPicker.unsavedDraft').length).toBeGreaterThan(0);
  });
});
