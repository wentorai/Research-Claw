import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SupervisorReviewListener from './SupervisorReviewListener';
import { useGatewayStore } from '../stores/gateway';
import { useSupervisorStore } from '../stores/supervisor';

type EventHandler = (payload: unknown) => void;

function makeClient() {
  const handlers = new Map<string, Set<EventHandler>>();
  const request = vi.fn(async (method: string) => {
    if (method === 'rc.supervisor.status') {
      return {
        enabled: true,
        reviewMode: 'correct',
        supervisorModel: '',
        courseCorrectionEnabled: false,
        deviationThreshold: 0.5,
        forceRegenerate: false,
        maxRegenerateAttempts: 1,
        highRiskTools: [],
        stats: { total: 1, blocked: 1, corrected: 0, warnings: 0 },
        activeSessions: 0,
        sessionsInfo: [],
      };
    }
    if (method === 'rc.supervisor.log') {
      return {
        entries: [{
          id: 1,
          sessionId: 'agent:main:push',
          type: 'tool_review',
          action: 'block',
          details: 'persisted row',
          timestamp: 1000,
        }],
        total: 1,
      };
    }
    throw new Error(`unexpected method: ${method}`);
  });
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

describe('SupervisorReviewListener', () => {
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
    useSupervisorStore.getState().stopPolling();
    useSupervisorStore.setState({
      status: null,
      auditLog: [],
      auditLogTotal: 0,
      statusLoading: false,
      pollingTimer: null,
    });
  });

  it('hydrates the persisted status and log immediately on a review notification without waiting for polling', async () => {
    const h = makeClient();
    useGatewayStore.setState({ client: h.client as never, state: 'connected' });
    render(<SupervisorReviewListener />);
    // Initial DB hydration is also what gives the plugin this connection's
    // GatewayRequestContext.broadcast function.
    await waitFor(() => {
      expect(h.request).toHaveBeenCalledWith('rc.supervisor.status', {});
      expect(h.request).toHaveBeenCalledWith('rc.supervisor.log', { limit: 200 });
    });
    h.request.mockClear();

    act(() => {
      h.emit('plugin.supervisor.review.updated', {
        sessionId: 'agent:main:push',
        type: 'tool_review',
        action: 'block',
        timestamp: 1000,
        persisted: true,
      });
    });

    await waitFor(() => {
      expect(h.request).toHaveBeenCalledWith('rc.supervisor.status', {});
      expect(h.request).toHaveBeenCalledWith('rc.supervisor.log', { limit: 200 });
      expect(useSupervisorStore.getState().auditLog).toHaveLength(1);
    });
  });

  it('rehydrates after another window clears review history', async () => {
    const h = makeClient();
    useGatewayStore.setState({ client: h.client as never, state: 'connected' });
    render(<SupervisorReviewListener />);
    await waitFor(() => expect(h.request).toHaveBeenCalledWith('rc.supervisor.log', { limit: 200 }));
    h.request.mockClear();

    act(() => {
      h.emit('plugin.supervisor.review.cleared', { deleted: 1, timestamp: 2000 });
    });

    await waitFor(() => {
      expect(h.request).toHaveBeenCalledWith('rc.supervisor.status', {});
      expect(h.request).toHaveBeenCalledWith('rc.supervisor.log', { limit: 200 });
    });
  });
});
