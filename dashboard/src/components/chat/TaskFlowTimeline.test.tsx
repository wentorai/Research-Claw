import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import TaskFlowTimeline from './TaskFlowTimeline';
import { useChatStore } from '../../stores/chat';
import { useSessionRunsStore } from '../../stores/session-runs';
import { useTaskFlowStore } from '../../stores/task-flow';

const gatewayMock = vi.hoisted(() => ({ state: 'connected' }));

vi.mock('../../stores/gateway', () => {
  const useGatewayStore = (selector: (state: { state: string }) => unknown) =>
    selector({ state: gatewayMock.state });
  useGatewayStore.getState = () => ({
    state: gatewayMock.state,
    client: null,
    eventEpoch: 1,
  });
  return { useGatewayStore };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, params?: { tool?: string }) => {
      const strings: Record<string, string> = {
        'taskFlow.runStatus.tool.title': 'Using {{tool}}',
        'taskFlow.runStatus.tool.detail': 'Research-Claw confirms active. Wait or Stop.',
        'taskFlow.runStatus.tool.fallback': 'a research tool',
        'taskFlow.runStatus.processing.title': 'Processing',
        'taskFlow.runStatus.processing.detail': 'Research-Claw confirms active. Wait or Stop.',
        'taskFlow.runStatus.confirming-result.title': 'Confirming result',
        'taskFlow.runStatus.confirming-result.detail': 'Refreshing session history.',
        'taskFlow.runStatus.reconnecting.title': 'Reconnecting to Gateway',
        'taskFlow.runStatus.reconnecting.detail': 'Checking Research-Claw session state.',
      };
      return (strings[key] ?? key).replace('{{tool}}', params?.tool ?? '');
    },
  }),
}));

describe('TaskFlowTimeline truthful long-run UI', () => {
  beforeEach(() => {
    gatewayMock.state = 'connected';
    useChatStore.setState({ sessionKey: 'main' });
    useSessionRunsStore.getState().resetForTests();
    useTaskFlowStore.getState().clear();
  });

  afterEach(() => {
    cleanup();
    useSessionRunsStore.getState().resetForTests();
  });

  it('replaces inferred progress stages with OC activity and a sanitized tool name', () => {
    useSessionRunsStore.getState().ingestSnapshot(
      { key: 'main', status: 'running', hasActiveRun: true },
      { eventEpoch: 1, observedAt: 1 },
    );
    useSessionRunsStore.getState().observeActivity({
      sessionKey: 'main',
      kind: 'tool',
      label: 'mcp__wentor_network__search /Users/private/query.json',
      observedAt: 2,
      source: 'tool-event',
    });
    useTaskFlowStore.getState().startRun('run-1', 'main');

    const { container } = render(<TaskFlowTimeline />);

    expect(screen.getByText('Using search')).toBeTruthy();
    expect(screen.getByText('Research-Claw confirms active. Wait or Stop.')).toBeTruthy();
    expect(container.textContent).not.toContain('/Users/');
    expect(container.querySelector('.task-flow-steps')).toBeNull();
  });

  it('does not spin when status=running conflicts with hasActiveRun=false', () => {
    useSessionRunsStore.getState().ingestSnapshot(
      { key: 'main', status: 'running', hasActiveRun: false },
      { eventEpoch: 1, observedAt: 1 },
    );

    const { container } = render(<TaskFlowTimeline />);

    expect(screen.getByText('Confirming result')).toBeTruthy();
    expect(container.querySelector('.anticon-loading')).toBeNull();
  });

  it('shows transport recovery without calling the task failed', () => {
    gatewayMock.state = 'reconnecting';
    useSessionRunsStore.getState().ingestSnapshot(
      { key: 'main', status: 'running', hasActiveRun: true },
      { eventEpoch: 1, observedAt: 1 },
    );

    const { container } = render(<TaskFlowTimeline />);

    expect(screen.getByText('Reconnecting to Gateway')).toBeTruthy();
    expect(container.textContent).not.toMatch(/failed|timeout/i);
  });

  it('does not create a task card for an idle disconnected session', () => {
    gatewayMock.state = 'disconnected';

    const { container } = render(<TaskFlowTimeline />);

    expect(container).toBeEmptyDOMElement();
  });
});
