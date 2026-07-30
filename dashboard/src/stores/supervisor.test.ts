import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGatewayStore } from './gateway';
import { useSupervisorStore, type SupervisorConfig } from './supervisor';

const defaults: SupervisorConfig = {
  enabled: false,
  supervisorModel: '',
  reviewMode: 'off',
  courseCorrection: {
    enabled: true,
    deviationThreshold: 0.5,
    forceRegenerate: false,
    maxRegenerateAttempts: 3,
  },
  highRiskTools: ['exec', 'write', 'edit', 'send_notification', 'browser'],
  dangerousToolPolicy: 'block',
  toolReviewGateMs: 4000,
  grounding: { networkPolicy: 'off', verdictMode: 'flag' },
};

describe('supervisor settings store', () => {
  beforeEach(() => {
    useSupervisorStore.setState({
      status: null,
      config: null,
      configLoading: false,
      error: null,
    });
    useGatewayStore.setState({ client: null, state: 'disconnected' });
  });

  it('restores the plugin-owned complete default object and refreshes status', async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'rc.supervisor.defaults') return { defaults };
      if (method === 'rc.supervisor.config') {
        expect(params).toEqual(defaults);
        return { ok: true, config: defaults };
      }
      if (method === 'rc.supervisor.status') {
        return {
          enabled: false,
          reviewMode: 'off',
          supervisorModel: '',
          courseCorrectionEnabled: true,
          deviationThreshold: 0.5,
          forceRegenerate: false,
          maxRegenerateAttempts: 3,
          highRiskTools: defaults.highRiskTools,
          stats: { total: 0, blocked: 0, corrected: 0, warnings: 0 },
          activeSessions: 0,
          sessionsInfo: [],
        };
      }
      throw new Error(`unexpected RPC: ${method}`);
    });
    useGatewayStore.setState({
      state: 'connected',
      client: { isConnected: true, request } as never,
    });

    await expect(useSupervisorStore.getState().restoreDefaults()).resolves.toEqual(defaults);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'rc.supervisor.defaults',
      'rc.supervisor.config',
      'rc.supervisor.status',
    ]);
    expect(useSupervisorStore.getState().config).toEqual(defaults);
    expect(useSupervisorStore.getState().configLoading).toBe(false);
  });
});
