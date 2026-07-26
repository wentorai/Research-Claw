import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PluginApprovalListener from './PluginApprovalListener';
import { useGatewayStore } from '../stores/gateway';
import { useApprovalsStore } from '../stores/approvals';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

type EventHandler = (payload: unknown) => void;

function makeClient() {
  const handlers = new Map<string, Set<EventHandler>>();
  const request = vi.fn().mockResolvedValue({ ok: true });
  return {
    request,
    client: {
      isConnected: true,
      request,
      subscribe(event: string, handler: EventHandler) {
        const set = handlers.get(event) ?? new Set<EventHandler>();
        set.add(handler);
        handlers.set(event, set);
        return () => set.delete(handler);
      },
    },
    emit(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
  };
}

describe('PluginApprovalListener — OC native approval path', () => {
  beforeEach(() => {
    useGatewayStore.setState({
      client: null,
      state: 'disconnected',
      serverVersion: null,
      assistantName: 'Research-Claw',
      connId: null,
      sessionDefaults: null,
      connectError: null,
    });
    useApprovalsStore.getState().clear();
  });

  it('renders a real plugin.approval.requested event and resolves it through plugin.approval.resolve', async () => {
    const h = makeClient();
    useGatewayStore.setState({
      client: h.client as never,
      state: 'connected',
    });

    render(<PluginApprovalListener />);

    act(() => {
      h.emit('plugin.approval.requested', {
        id: 'plugin:approval-1',
        request: {
          pluginId: 'dual-model-supervisor',
          title: 'Approve dangerous tool: exec',
          description: 'Dangerous command detected in exec call',
          severity: 'critical',
          toolName: 'exec',
          toolCallId: 'tool-1',
          sessionKey: 'agent:main:approval-test',
          allowedDecisions: ['allow-once', 'allow-always', 'deny'],
        },
        createdAtMs: 1000,
        expiresAtMs: 121000,
      });
    });

    expect(screen.getByText('Approve dangerous tool: exec')).toBeInTheDocument();
    expect(screen.getByText('Dangerous command detected in exec call')).toBeInTheDocument();
    expect(screen.getByText('card.approval.riskHigh')).toBeInTheDocument();

    fireEvent.click(screen.getByText('card.approval.approve'));
    await waitFor(() => {
      expect(h.request).toHaveBeenCalledWith('plugin.approval.resolve', {
        id: 'plugin:approval-1',
        decision: 'allow-once',
      });
    });

    act(() => {
      h.emit('plugin.approval.resolved', {
        id: 'plugin:approval-1',
        decision: 'allow-once',
        ts: 1100,
      });
    });
    expect(screen.queryByText('Approve dangerous tool: exec')).not.toBeInTheDocument();
  });

  it('deduplicates repeated requested events and keeps a failed resolution pending without a chat fallback', async () => {
    const h = makeClient();
    h.request.mockRejectedValueOnce(new Error('gateway rejected resolution'));
    useGatewayStore.setState({
      client: h.client as never,
      state: 'connected',
    });
    render(<PluginApprovalListener />);

    const event = {
      id: 'plugin:approval-2',
      request: {
        title: 'One native request',
        description: 'Must remain pending on RPC failure',
        severity: 'warning',
      },
      createdAtMs: 2000,
      expiresAtMs: 122000,
    };
    act(() => {
      h.emit('plugin.approval.requested', event);
      h.emit('plugin.approval.requested', event);
    });

    expect(screen.getAllByText('One native request')).toHaveLength(1);
    fireEvent.click(screen.getByText('card.approval.approve'));
    await waitFor(() => {
      expect(screen.getByText('One native request')).toBeInTheDocument();
      expect(screen.getByText('card.approval.resolveFailed')).toBeInTheDocument();
    });
    expect(useApprovalsStore.getState().pending).toHaveLength(1);
  });
});
