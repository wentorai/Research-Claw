import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import StatusBar from './StatusBar';
import { useChatStore } from '../stores/chat';
import { useConfigStore } from '../stores/config';
import { useJobsStore, type Job } from '../stores/jobs';
import { useUiStore } from '../stores/ui';

const gatewayMock = vi.hoisted(() => ({ state: 'connected' }));

vi.mock('../stores/gateway', () => {
  const useGatewayStore = (selector: (state: typeof gatewayMock) => unknown) => selector(gatewayMock);
  useGatewayStore.getState = () => ({ state: gatewayMock.state, client: null, eventEpoch: 1 });
  return { useGatewayStore };
});

vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  const MockApp = Object.assign(
    (props: Record<string, unknown>) => (actual.App as unknown as (p: unknown) => unknown)(props),
    {
      ...actual.App,
      useApp: () => ({
        modal: { confirm: vi.fn() },
        message: { success: vi.fn(), error: vi.fn() },
        notification: {},
      }),
    },
  );
  return { ...actual, App: MockApp };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, params?: { count?: number; version?: string }) => {
      if (params?.count !== undefined) return `${key}:${params.count}`;
      if (params?.version !== undefined) return `${key}:${params.version}`;
      return key;
    },
  }),
}));

const activeJob: Job = {
  id: 'job-1',
  type: 'openclaw-subagent',
  title: 'Active background job',
  session_key: 'agent:main:subagent:child',
  status: 'running',
  progress: 20,
  current_step: 'Running',
  error: null,
  heartbeat_at: null,
  created_at: '2026-08-01 00:00:00',
  updated_at: '2026-08-01 00:00:00',
  completed_at: null,
};

describe('StatusBar background activity placement', () => {
  beforeEach(() => {
    gatewayMock.state = 'connected';
    useChatStore.setState({ tokensIn: 0, tokensOut: 0 });
    useConfigStore.setState({
      theme: 'dark',
      gatewayConfig: { agents: { defaults: { model: { primary: 'deepseek/test' } } } },
    });
    useJobsStore.setState({
      jobs: [activeJob],
      loading: false,
      lastLoadedAt: null,
      actionById: {},
    });
    useUiStore.setState({ appUpdateInfo: null, appUpdateRunning: false });
  });

  afterEach(() => cleanup());

  it('places the active background count directly after heartbeat and before the flexible spacer', () => {
    const { container } = render(<StatusBar />);
    const root = container.firstElementChild as HTMLElement;
    const children = Array.from(root.children) as HTMLElement[];
    const heartbeat = screen.getByText(/^status\.heartbeat:/);
    const background = screen.getByRole('button', { name: /jobs\.backgroundActive:1/ });
    const spacerIndex = children.findIndex((child) => child.style.flex === '1 1 0%');
    const heartbeatIndex = children.indexOf(heartbeat);
    const backgroundIndex = children.indexOf(background);

    expect(heartbeatIndex).toBeGreaterThanOrEqual(0);
    expect(backgroundIndex).toBe(heartbeatIndex + 1);
    expect(backgroundIndex).toBeLessThan(spacerIndex);
  });
});
