import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';
import ConfigRestartListener from './ConfigRestartListener';
import { useGatewayStore } from '../stores/gateway';
import { useConfigStore } from '../stores/config';
import { useSessionsStore } from '../stores/sessions';

const mockMessageSuccess = vi.fn();

vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  const MockApp = Object.assign(
    (props: Record<string, unknown>) => (actual.App as unknown as (p: unknown) => unknown)(props),
    { ...actual.App, useApp: () => ({
      modal: { confirm: vi.fn() },
      message: { success: mockMessageSuccess, error: vi.fn(), warning: vi.fn() },
      notification: {},
    }) },
  );
  return { ...actual, App: MockApp };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

function makeGatewayConfig(modelPrimary: string) {
  return {
    agents: {
      defaults: {
        model: { primary: modelPrimary },
        imageModel: { primary: modelPrimary },
      },
    },
    models: {
      providers: {
        [modelPrimary.split('/')[0]]: {
          baseUrl: 'https://api.example.com/v1',
          api: 'openai-completions',
          models: [{ id: modelPrimary.split('/').slice(1).join('/'), name: modelPrimary }],
        },
      },
    },
  };
}

describe('ConfigRestartListener', () => {
  beforeEach(() => {
    mockMessageSuccess.mockReset();
    useGatewayStore.setState({
      client: null,
      state: 'disconnected',
      serverVersion: null,
      assistantName: 'Research-Claw',
      connId: null,
      sessionDefaults: null,
      connectError: null,
    });
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
    useSessionsStore.setState({
      sessions: [],
      activeSessionKey: 'project-1234',
      loading: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('waits for refreshed gatewayConfig before patching the active session model', async () => {
    const mockRequest = vi.fn().mockResolvedValue({ ok: true });
    const client = {
      isConnected: true,
      request: mockRequest,
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as ReturnType<typeof useGatewayStore.getState>['client'];

    useGatewayStore.setState({ client, state: 'disconnected' });
    useConfigStore.setState({
      pendingConfigRestart: true,
      gatewayConfig: makeGatewayConfig('minimax/MiniMax-M2.7'),
    });

    render(<ConfigRestartListener />);

    act(() => {
      useGatewayStore.setState({ state: 'connected' });
    });

    expect(mockRequest).not.toHaveBeenCalledWith('sessions.patch', expect.objectContaining({
      model: 'minimax/MiniMax-M2.7',
    }));

    act(() => {
      useConfigStore.setState({
        gatewayConfig: makeGatewayConfig('zai-coding/glm-5'),
      });
    });

    expect(mockRequest).toHaveBeenCalledWith('sessions.patch', {
      key: 'project-1234',
      model: 'zai-coding/glm-5',
    });
    expect(mockMessageSuccess).toHaveBeenCalledWith('settings.reconnected');
    expect(useConfigStore.getState().pendingConfigRestart).toBe(false);
  });
});
