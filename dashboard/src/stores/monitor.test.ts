/**
 * Monitor store — behavioral tests
 *
 * Following DEVELOPMENT_SOP.md §3 Layer 1 (Behavioral Parity Tests):
 *   - Use real fixture payloads from monitor-responses.ts
 *   - Verify behavior, not implementation details
 *   - Each test answers: "if this passes, can I tell the user it works?"
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isDeviceMonitorSource,
  resetMonitorReconciled,
  useMonitorStore,
} from './monitor';
import { useGatewayStore } from './gateway';
import { useProductPolicyStore } from './product-policy';
import {
  RC_MONITOR_LIST_RESPONSE,
  RC_MONITOR_TOGGLE_ENABLED,
  RC_MONITOR_TOGGLE_DISABLED,
  CRON_ADD_RESPONSE,
  CHANNELS_STATUS_NO_BOUND,
  NO_CHANNEL_DELIVERY,
} from '../__fixtures__/gateway-payloads/monitor-responses';

// ── Mock gateway client ──────────────────────────────────────────────────
//
// Method-aware queued mock. F7 added a `channels.status` round-trip inside the
// cron registration path (notify=true); a purely positional mockResolvedValueOnce
// chain would have that call consume the wrong queued value. Instead each method
// keeps its own FIFO queue (last entry repeats), and `channels.status` defaults
// to CHANNELS_STATUS_NO_BOUND (no bound external channel → mode:none).

const mockRequest = vi.fn();

// Per-method response queues; last value repeats when exhausted.
let _queues: Record<string, unknown[]> = {};

function queueResponse(method: string, ...values: unknown[]) {
  _queues[method] = [...(_queues[method] ?? []), ...values];
}

function installMethodRouter() {
  _queues = {};
  mockRequest.mockImplementation((method: string) => {
    const q = _queues[method];
    if (q && q.length > 0) {
      const value = q.length > 1 ? q.shift() : q[0];
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    }
    if (method === 'channels.status') return Promise.resolve(CHANNELS_STATUS_NO_BOUND);
    if (method === 'rc.monitor.list') return Promise.resolve(RC_MONITOR_LIST_RESPONSE);
    // Fallback for trailing/unlisted calls so a stray reload never throws.
    return Promise.resolve({ ok: true });
  });
}

function setConnected(connected: boolean) {
  useGatewayStore.setState({
    state: connected ? 'connected' : 'disconnected',
    client: connected ? { isConnected: true, request: mockRequest } as unknown as ReturnType<typeof useGatewayStore.getState>['client'] : null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMonitorReconciled();
  useMonitorStore.setState({ monitors: [], loading: false, loaded: false, error: null });
  installMethodRouter();
  setConnected(true);
});

function disablePeripherals() {
  useProductPolicyStore.getState().loadFromConfig({
    plugins: { entries: { 'research-claw-core': { config: { productPolicy: {
      capabilities: {
        settings: 'enabled', extensions: 'enabled', supervisor: 'enabled', peripherals: 'disabled',
      },
    } } } } },
  });
}

describe('disabled peripheral monitor fail-closed gates', () => {
  const staleDevice = {
    ...RC_MONITOR_LIST_RESPONSE.items[0],
    id: 'stale-device-monitor',
    source_type: 'device',
    target: 'dev-camera-stale',
    enabled: true,
    gateway_job_id: null,
  };

  beforeEach(() => {
    disablePeripherals();
    useMonitorStore.setState({ monitors: [staleDevice], loaded: true });
  });

  it.each([
    ['canonical', 'device'],
    ['legacy whitespace/case', '\tDEVICE\n'],
    ['legacy non-breaking spaces', '\u00a0DeViCe\u00a0'],
  ])('classifies %s source_type as a device monitor', (_label, sourceType) => {
    expect(isDeviceMonitorSource(sourceType)).toBe(true);
  });

  it.each(['\tDEVICE\n', '\u00a0DeViCe\u00a0'])(
    'rejects legacy device source_type %j at every mutation boundary before RPC',
    async (sourceType) => {
      const legacyDevice = { ...staleDevice, source_type: sourceType };
      useMonitorStore.setState({ monitors: [legacyDevice], loaded: true });

      expect(await useMonitorStore.getState().createMonitor({
        name: 'legacy hidden camera', source_type: sourceType, target: legacyDevice.target,
      })).toBeNull();
      expect(await useMonitorStore.getState().toggleMonitor(legacyDevice.id, true)).toEqual({
        ok: false,
        error: 'peripherals-disabled',
      });
      await useMonitorStore.getState().updateMonitor(legacyDevice.id, { schedule: '*/5 * * * *' });
      await useMonitorStore.getState().runMonitor(legacyDevice.id);
      await useMonitorStore.getState().deleteMonitor(legacyDevice.id);

      expect(mockRequest).not.toHaveBeenCalled();
    },
  );

  it('rejects create/update/enable/run device entry points before any RPC', async () => {
    expect(await useMonitorStore.getState().createMonitor({
      name: 'hidden camera', source_type: 'device', target: 'dev-camera-stale',
    })).toBeNull();
    expect(await useMonitorStore.getState().toggleMonitor(staleDevice.id, true)).toEqual({
      ok: false,
      error: 'peripherals-disabled',
    });
    await useMonitorStore.getState().updateMonitor(staleDevice.id, { schedule: '*/5 * * * *' });
    await useMonitorStore.getState().runMonitor(staleDevice.id);

    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('rejects unknown mutation ids while disabled but preserves known ordinary monitors', async () => {
    for (const unknownId of ['unknown-toggle', 'unknown-update', 'unknown-run', 'unknown-delete']) {
      if (unknownId.endsWith('toggle')) {
        expect(await useMonitorStore.getState().toggleMonitor(unknownId, true)).toEqual({
          ok: false,
          error: 'peripherals-disabled',
        });
      } else if (unknownId.endsWith('update')) {
        await useMonitorStore.getState().updateMonitor(unknownId, { schedule: '*/5 * * * *' });
      } else if (unknownId.endsWith('run')) {
        await useMonitorStore.getState().runMonitor(unknownId);
      } else {
        await useMonitorStore.getState().deleteMonitor(unknownId);
      }
    }
    expect(mockRequest).not.toHaveBeenCalled();

    const ordinary = { ...RC_MONITOR_LIST_RESPONSE.items[1], enabled: false };
    useMonitorStore.setState({ monitors: [ordinary], loaded: true });
    queueResponse('rc.monitor.toggle', { ...ordinary, enabled: true });
    queueResponse('cron.add', CRON_ADD_RESPONSE);
    queueResponse('rc.monitor.setJobId', { ok: true });
    queueResponse('rc.monitor.list', { items: [{ ...ordinary, enabled: true }], total: 1 });
    queueResponse('cron.list', {});

    expect((await useMonitorStore.getState().toggleMonitor(ordinary.id, true)).ok).toBe(true);
    expect(mockRequest).toHaveBeenCalledWith('rc.monitor.toggle', { id: ordinary.id, enabled: true });
  });

  it('does not reconcile or expose a stale enabled device row returned by the backend', async () => {
    queueResponse('rc.monitor.list', { items: [staleDevice], total: 1 });
    queueResponse('cron.list', { jobs: [] });
    useMonitorStore.setState({ monitors: [], loaded: false });

    await useMonitorStore.getState().loadMonitors();

    expect(useMonitorStore.getState().monitors).toEqual([]);
    expect(mockRequest).not.toHaveBeenCalledWith('cron.add', expect.anything());
    expect(mockRequest).not.toHaveBeenCalledWith('rc.monitor.toggle', expect.anything());
  });

  it.each(['\tDEVICE\n', '\u00a0DeViCe\u00a0'])(
    'does not reconcile or expose legacy source_type %j returned by the backend',
    async (sourceType) => {
      const legacyDevice = { ...staleDevice, source_type: sourceType };
      queueResponse('rc.monitor.list', { items: [legacyDevice], total: 1 });
      queueResponse('cron.list', { jobs: [] });
      useMonitorStore.setState({ monitors: [], loaded: false });

      await useMonitorStore.getState().loadMonitors();

      expect(useMonitorStore.getState().monitors).toEqual([]);
      expect(mockRequest).not.toHaveBeenCalledWith('cron.add', expect.anything());
      expect(mockRequest).not.toHaveBeenCalledWith('rc.monitor.toggle', expect.anything());
    },
  );

  it('does not issue ordinary monitor hydration RPCs while policy is pending', async () => {
    useProductPolicyStore.getState().resetPending();
    useMonitorStore.setState({ monitors: [], loaded: false });

    await useMonitorStore.getState().loadMonitors();

    expect(mockRequest).not.toHaveBeenCalled();
    expect(useMonitorStore.getState().loaded).toBe(false);
  });

  it('keeps device reconciliation active for enabled-hidden peripherals', async () => {
    useProductPolicyStore.getState().loadFromConfig({
      plugins: { entries: { 'research-claw-core': { config: { productPolicy: {
        capabilities: {
          settings: 'enabled', extensions: 'enabled', supervisor: 'enabled',
          peripherals: 'enabled-hidden',
        },
      } } } } },
    });
    const repaired = { ...staleDevice, gateway_job_id: CRON_ADD_RESPONSE.id };
    queueResponse('rc.monitor.list',
      { items: [staleDevice], total: 1 },
      { items: [repaired], total: 1 });
    queueResponse('cron.list', { jobs: [] });
    queueResponse('cron.add', CRON_ADD_RESPONSE);
    queueResponse('rc.monitor.setJobId', { ok: true });
    useMonitorStore.setState({ monitors: [], loaded: false });

    await useMonitorStore.getState().loadMonitors();

    expect(mockRequest).toHaveBeenCalledWith('cron.add', expect.objectContaining({
      sessionKey: `cron:rc-monitor:${staleDevice.id}`,
    }));
    expect(useMonitorStore.getState().monitors).toEqual([repaired]);
  });
});

// ── loadMonitors ─────────────────────────────────────────────────────────

describe('loadMonitors', () => {
  it('fetches monitors from rc.monitor.list and stores them', async () => {
    queueResponse('rc.monitor.list', RC_MONITOR_LIST_RESPONSE);
    // Unparseable cron.list shape → reconcile no-ops (extractCronJobs → null),
    // isolating this test to the load path.
    queueResponse('cron.list', {});

    await useMonitorStore.getState().loadMonitors();

    expect(mockRequest).toHaveBeenCalledWith('rc.monitor.list', { limit: 100 });
    expect(useMonitorStore.getState().monitors).toHaveLength(3);
    expect(useMonitorStore.getState().loaded).toBe(true);
  });

  it('skips when not connected', async () => {
    setConnected(false);

    await useMonitorStore.getState().loadMonitors();

    expect(mockRequest).not.toHaveBeenCalled();
    expect(useMonitorStore.getState().loaded).toBe(false);
  });

  it('does not duplicate calls when already loading', async () => {
    useMonitorStore.setState({ loading: true });

    await useMonitorStore.getState().loadMonitors();

    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('handles RPC errors gracefully', async () => {
    queueResponse('rc.monitor.list', new Error('network'));

    await useMonitorStore.getState().loadMonitors();

    expect(useMonitorStore.getState().monitors).toHaveLength(0);
    expect(useMonitorStore.getState().loading).toBe(false);
  });

  it('repairs an enabled monitor whose gateway cron job is missing', async () => {
    const missingJobMonitor = {
      ...RC_MONITOR_LIST_RESPONSE.items[0],
      gateway_job_id: 'stale-job-id',
    };
    const repairedMonitor = {
      ...missingJobMonitor,
      gateway_job_id: CRON_ADD_RESPONSE.id,
    };

    queueResponse('rc.monitor.list', { items: [missingJobMonitor], total: 1 }, { items: [repairedMonitor], total: 1 });
    queueResponse('cron.list', { jobs: [] });
    queueResponse('cron.add', CRON_ADD_RESPONSE);
    queueResponse('rc.monitor.setJobId', { ok: true });
    // channels.status defaults to CHANNELS_STATUS_NO_BOUND → mode:none.

    await useMonitorStore.getState().loadMonitors();

    // cron.list is paged: the RPC schema caps limit at 100 and a limit-less call
    // silently truncates at 200 (listPage, server-cron:1968), which would make
    // every monitor past the cut look orphaned and get re-registered.
    expect(mockRequest).toHaveBeenCalledWith('cron.list', { limit: 100, offset: 0 });
    expect(mockRequest).toHaveBeenCalledWith('cron.add', expect.objectContaining({
      name: '[rc-monitor] arXiv Daily Digest',
      sessionKey: 'cron:rc-monitor:arxiv-daily',
      sessionTarget: 'isolated',
      delivery: NO_CHANNEL_DELIVERY,
      payload: expect.objectContaining({
        kind: 'agentTurn',
        message: expect.stringContaining('MONITOR_ID: arxiv-daily'),
        timeoutSeconds: 900,
      }),
    }));
    const cronAddCall = mockRequest.mock.calls.find((c) => c[0] === 'cron.add');
    expect(cronAddCall?.[1]).toEqual(expect.objectContaining({
      payload: expect.objectContaining({
        message: expect.stringContaining('monitor_get_context with {"monitor_id":"arxiv-daily"}'),
      }),
    }));
    expect(cronAddCall?.[1]).toEqual(expect.objectContaining({
      payload: expect.objectContaining({
        message: expect.stringContaining('monitor_collect_candidates with {"monitor_id":"arxiv-daily"}'),
      }),
    }));
    expect(mockRequest).toHaveBeenCalledWith('rc.monitor.setJobId', {
      id: 'arxiv-daily',
      job_id: CRON_ADD_RESPONSE.id,
    });
    expect(useMonitorStore.getState().monitors[0].gateway_job_id).toBe(CRON_ADD_RESPONSE.id);
  });

  it('removes duplicate gateway cron jobs for one enabled monitor', async () => {
    const monitor = {
      ...RC_MONITOR_LIST_RESPONSE.items[0],
      gateway_job_id: 'gw-job-001',
    };

    queueResponse('rc.monitor.list', { items: [monitor], total: 1 });
    queueResponse('cron.list', {
      jobs: [
        {
          id: 'gw-job-001',
          name: '[rc-monitor] arXiv Daily Digest',
          sessionKey: 'cron:rc-monitor:arxiv-daily',
          schedule: { kind: 'cron', expr: monitor.schedule },
          payload: {},
          state: { lastRunStatus: 'success' },
        },
        {
          id: 'gw-job-duplicate',
          name: '[rc-monitor] arXiv Daily Digest',
          sessionKey: 'cron:rc-monitor:arxiv-daily',
          schedule: { kind: 'cron', expr: monitor.schedule },
          payload: {},
          state: { lastRunStatus: 'success' },
        },
      ],
    });
    queueResponse('cron.remove', { ok: true });

    await useMonitorStore.getState().loadMonitors();

    expect(mockRequest).toHaveBeenCalledWith('cron.remove', { id: 'gw-job-duplicate' });
    expect(mockRequest).not.toHaveBeenCalledWith('cron.add', expect.anything());
  });

  it('refreshes an enabled monitor job that has no explicit timeout', async () => {
    const monitor = {
      ...RC_MONITOR_LIST_RESPONSE.items[0],
      gateway_job_id: 'gw-job-001',
    };

    queueResponse('rc.monitor.list',
      { items: [monitor], total: 1 },
      { items: [{ ...monitor, gateway_job_id: CRON_ADD_RESPONSE.id }], total: 1 });
    queueResponse('cron.list', {
      jobs: [{
        id: 'gw-job-001',
        name: '[rc-monitor] arXiv Daily Digest',
        sessionKey: 'cron:rc-monitor:arxiv-daily',
        schedule: { kind: 'cron', expr: monitor.schedule },
        payload: { kind: 'agentTurn', message: 'old' },
        state: { lastRunStatus: 'success' },
      }],
    });
    queueResponse('cron.remove', { ok: true });
    queueResponse('cron.add', CRON_ADD_RESPONSE);
    queueResponse('rc.monitor.setJobId', { ok: true });

    await useMonitorStore.getState().loadMonitors();

    expect(mockRequest).toHaveBeenCalledWith('cron.remove', { id: 'gw-job-001' });
    expect(mockRequest).toHaveBeenCalledWith('cron.add', expect.objectContaining({
      payload: expect.objectContaining({ timeoutSeconds: 900 }),
    }));
  });

  it('removes stale gateway cron jobs for disabled monitors', async () => {
    const disabled = {
      ...RC_MONITOR_LIST_RESPONSE.items[1],
      enabled: false,
      gateway_job_id: 'gw-disabled-monitor',
    };

    queueResponse('rc.monitor.list',
      { items: [disabled], total: 1 },
      { items: [{ ...disabled, gateway_job_id: null }], total: 1 });
    queueResponse('cron.list', {
      jobs: [{
        id: 'gw-disabled-monitor',
        name: '[rc-monitor] GitHub Release Tracker',
        sessionKey: 'cron:rc-monitor:github-releases',
        schedule: { kind: 'cron', expr: disabled.schedule },
        payload: { kind: 'agentTurn', message: 'stale', timeoutSeconds: 900 },
        state: { lastRunStatus: 'success' },
      }],
    });
    queueResponse('cron.remove', { ok: true });
    queueResponse('rc.monitor.setJobId', { ok: true });

    await useMonitorStore.getState().loadMonitors();

    expect(mockRequest).toHaveBeenCalledWith('cron.remove', { id: 'gw-disabled-monitor' });
    expect(mockRequest).toHaveBeenCalledWith('rc.monitor.setJobId', {
      id: 'github-releases',
      job_id: '',
    });
    // Disabled monitor never announces → no channels.status round-trip.
    expect(mockRequest).not.toHaveBeenCalledWith('channels.status', expect.anything());
  });
});

// ── toggleMonitor ────────────────────────────────────────────────────────

describe('toggleMonitor', () => {
  beforeEach(() => {
    useMonitorStore.setState({ monitors: [...RC_MONITOR_LIST_RESPONSE.items], loaded: true });
  });

  it('enables a monitor: toggle → channels.status → cron.add → setJobId → reload', async () => {
    queueResponse('rc.monitor.toggle', RC_MONITOR_TOGGLE_ENABLED);
    queueResponse('cron.add', CRON_ADD_RESPONSE);
    queueResponse('rc.monitor.setJobId', { ok: true });
    queueResponse('rc.monitor.list', RC_MONITOR_LIST_RESPONSE);
    queueResponse('cron.list', {}); // reload reconcile no-ops

    await useMonitorStore.getState().toggleMonitor('github-releases', true);

    // Verify RPC sequence: registration now consults channels.status (F7) to
    // derive the delivery target before cron.add.
    expect(mockRequest).toHaveBeenNthCalledWith(1, 'rc.monitor.toggle', { id: 'github-releases', enabled: true });
    expect(mockRequest).toHaveBeenNthCalledWith(2, 'channels.status', {});
    expect(mockRequest).toHaveBeenNthCalledWith(3, 'cron.add', expect.objectContaining({
      name: '[rc-monitor] GitHub Release Tracker',
      sessionKey: 'cron:rc-monitor:github-releases',
      sessionTarget: 'isolated',
      // Default fixture = no bound external channel → announce/last fallback.
      delivery: NO_CHANNEL_DELIVERY,
      payload: expect.objectContaining({
        kind: 'agentTurn',
        message: expect.stringContaining('MONITOR_ID: github-releases'),
        timeoutSeconds: 900,
      }),
    }));
    const cronAddCall = mockRequest.mock.calls.find((c) => c[0] === 'cron.add');
    expect(cronAddCall?.[1]).not.toHaveProperty('message');
    expect(mockRequest).toHaveBeenNthCalledWith(4, 'rc.monitor.setJobId', {
      id: 'github-releases',
      job_id: CRON_ADD_RESPONSE.id,
    });
  });

  it('reports cron registration failure without rolling back persisted enabled state', async () => {
    queueResponse('rc.monitor.toggle', RC_MONITOR_TOGGLE_ENABLED);
    queueResponse('cron.add', {});

    const result = await useMonitorStore.getState().toggleMonitor('github-releases', true);

    expect(result).toEqual({
      ok: false,
      error: 'cron registration failed: cron-add-missing-id',
    });
    const monitor = useMonitorStore.getState().monitors
      .find((item) => item.id === 'github-releases');
    expect(monitor?.enabled).toBe(true);
    expect(monitor?.gateway_job_id).toBeNull();
    expect(useMonitorStore.getState().error).toBe(
      'cron registration failed: cron-add-missing-id',
    );
    // No immediate reload: that would invoke F1 reconciliation and hide the
    // initiating action's failure before the UI can report it.
    expect(mockRequest).not.toHaveBeenCalledWith('rc.monitor.list', expect.anything());
  });

  it('disables a monitor: toggle → cron.remove → setJobId(clear) → reload', async () => {
    const monitorWithJob = { ...RC_MONITOR_LIST_RESPONSE.items[0] }; // arxiv-daily, has gw-job-001
    useMonitorStore.setState({ monitors: [monitorWithJob], loaded: true });

    queueResponse('rc.monitor.toggle', { ...monitorWithJob, enabled: false });
    queueResponse('cron.remove', { ok: true });
    queueResponse('rc.monitor.setJobId', { ok: true });
    queueResponse('rc.monitor.list', { items: [{ ...monitorWithJob, enabled: false, gateway_job_id: null }], total: 1 });
    queueResponse('cron.list', {}); // reload reconcile no-ops

    await useMonitorStore.getState().toggleMonitor('arxiv-daily', false);

    // Should have called cron.remove with the old gateway_job_id
    const cronRemoveCall = mockRequest.mock.calls.find((c) => c[0] === 'cron.remove');
    expect(cronRemoveCall).toBeDefined();
  });

  it('applies optimistic update before RPC completes', async () => {
    let resolveToggle: (v: unknown) => void;
    const togglePromise = new Promise((r) => { resolveToggle = r; });
    // Defer only the toggle (router unwraps the queued thenable via
    // Promise.resolve); the disable path's cron.remove/setJobId/reload follow.
    queueResponse('rc.monitor.toggle', togglePromise);
    queueResponse('cron.remove', { ok: true });
    queueResponse('rc.monitor.setJobId', { ok: true });
    queueResponse('rc.monitor.list', RC_MONITOR_LIST_RESPONSE);
    queueResponse('cron.list', {});

    // Start: arxiv-daily is enabled=true
    expect(useMonitorStore.getState().monitors[0].enabled).toBe(true);

    const p = useMonitorStore.getState().toggleMonitor('arxiv-daily', false);

    // Optimistic update should apply synchronously (after set() microtask)
    await new Promise((r) => setTimeout(r, 0));
    expect(useMonitorStore.getState().monitors[0].enabled).toBe(false);

    // Resolve the RPC so the toggle completes and cleans up _inflightOps
    resolveToggle!(RC_MONITOR_TOGGLE_DISABLED);
    await p;
  });
});

// ── deleteMonitor ────────────────────────────────────────────────────────

describe('deleteMonitor', () => {
  beforeEach(() => {
    useMonitorStore.setState({ monitors: [...RC_MONITOR_LIST_RESPONSE.items], loaded: true });
  });

  it('removes gateway job and deletes from DB', async () => {
    // arxiv-daily has gateway_job_id='gw-job-001'
    queueResponse('cron.remove', { ok: true });
    queueResponse('rc.monitor.delete', { ok: true, deleted: 'arxiv-daily' });

    await useMonitorStore.getState().deleteMonitor('arxiv-daily');

    expect(mockRequest).toHaveBeenCalledWith('cron.remove', { id: 'gw-job-001' });
    expect(mockRequest).toHaveBeenCalledWith('rc.monitor.delete', { id: 'arxiv-daily' });

    // Monitor should be removed from local state
    expect(useMonitorStore.getState().monitors.find((m) => m.id === 'arxiv-daily')).toBeUndefined();
  });

  it('skips cron.remove when no gateway_job_id', async () => {
    // github-releases has no gateway_job_id
    queueResponse('rc.monitor.delete', { ok: true, deleted: 'github-releases' });

    await useMonitorStore.getState().deleteMonitor('github-releases');

    // Should NOT have called cron.remove
    expect(mockRequest).not.toHaveBeenCalledWith('cron.remove', expect.anything());
  });
});

// ── runMonitor ───────────────────────────────────────────────────────────

describe('runMonitor', () => {
  beforeEach(() => {
    useMonitorStore.setState({ monitors: [...RC_MONITOR_LIST_RESPONSE.items], loaded: true });
  });

  it('triggers cron.run with gateway_job_id', async () => {
    queueResponse('cron.run', { ok: true });
    queueResponse('rc.monitor.list', RC_MONITOR_LIST_RESPONSE);
    // Unparseable cron.list → reload reconcile no-ops.
    queueResponse('cron.list', {});

    await useMonitorStore.getState().runMonitor('arxiv-daily');

    expect(mockRequest).toHaveBeenCalledWith('cron.run', { id: 'gw-job-001', mode: 'force' });
    expect(mockRequest).toHaveBeenCalledWith('rc.monitor.list', { limit: 100 });
  });

  it('warns when no gateway_job_id', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await useMonitorStore.getState().runMonitor('github-releases'); // no gateway_job_id

    expect(mockRequest).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ── updateMonitor ───────────────────────────────────────────────────────

describe('updateMonitor', () => {
  beforeEach(() => {
    useMonitorStore.setState({ monitors: [...RC_MONITOR_LIST_RESPONSE.items], loaded: true });
  });

  it('re-registers an enabled monitor when schedule changes even if gateway_job_id is missing', async () => {
    const updated = {
      ...RC_MONITOR_LIST_RESPONSE.items[0],
      schedule: '*/5 * * * *',
      gateway_job_id: null,
    };

    queueResponse('rc.monitor.update', updated);
    queueResponse('cron.add', CRON_ADD_RESPONSE);
    queueResponse('rc.monitor.setJobId', { ok: true });
    queueResponse('rc.monitor.list', { items: [{ ...updated, gateway_job_id: CRON_ADD_RESPONSE.id }], total: 1 });
    queueResponse('cron.list', {}); // reload reconcile no-ops

    await useMonitorStore.getState().updateMonitor('arxiv-daily', { schedule: '*/5 * * * *' });

    expect(mockRequest).toHaveBeenCalledWith('cron.add', expect.objectContaining({
      schedule: { kind: 'cron', expr: '*/5 * * * *' },
      sessionKey: 'cron:rc-monitor:arxiv-daily',
      delivery: NO_CHANNEL_DELIVERY, // F7: notify=true but no routable channel → mode:none
      payload: expect.objectContaining({
        message: expect.stringContaining('MONITOR_ID: arxiv-daily'),
        timeoutSeconds: 900,
      }),
    }));
    expect(mockRequest).toHaveBeenCalledWith('rc.monitor.setJobId', {
      id: 'arxiv-daily',
      job_id: CRON_ADD_RESPONSE.id,
    });
  });

  it('syncs a failed gateway cron run into monitor last_error', async () => {
    const monitor = {
      ...RC_MONITOR_LIST_RESPONSE.items[0],
      last_check_at: '2026-03-17T07:00:00.000Z',
      last_error: null,
    };
    const refreshed = {
      ...monitor,
      last_check_at: '2026-03-18T07:00:00.000Z',
      last_error: 'Gateway cron run error (timeout): Error: LLM idle timeout',
      check_count: monitor.check_count + 1,
    };

    queueResponse('rc.monitor.list', { items: [monitor], total: 1 }, { items: [refreshed], total: 1 });
    queueResponse('cron.list', {
      jobs: [{
        id: 'gw-job-001',
        state: {
          lastRunAtMs: Date.parse('2026-03-18T07:00:00.000Z'),
          lastRunStatus: 'error',
          lastErrorReason: 'timeout',
          lastError: 'Error: LLM idle timeout',
        },
      }],
    });
    queueResponse('rc.monitor.reportError', { ok: true, monitor: refreshed });

    await useMonitorStore.getState().loadMonitors();

    expect(mockRequest).toHaveBeenCalledWith('rc.monitor.reportError', {
      id: 'arxiv-daily',
      error: 'Gateway cron run error (timeout): Error: LLM idle timeout',
    });
    expect(useMonitorStore.getState().monitors[0].last_error).toContain('LLM idle timeout');
  });

  it('does not re-sync an already recorded cron failure timestamp', async () => {
    const monitor = {
      ...RC_MONITOR_LIST_RESPONSE.items[0],
      last_check_at: '2026-03-18 07:00:00',
      last_error: 'Gateway cron run error (timeout): Error: LLM idle timeout',
    };

    queueResponse('rc.monitor.list', { items: [monitor], total: 1 });
    queueResponse('cron.list', {
      jobs: [{
        id: 'gw-job-001',
        state: {
          lastRunAtMs: Date.parse('2026-03-18T07:00:00.000Z'),
          lastRunStatus: 'error',
          lastErrorReason: 'timeout',
          lastError: 'Error: LLM idle timeout',
        },
      }],
    });

    await useMonitorStore.getState().loadMonitors();

    expect(mockRequest).not.toHaveBeenCalledWith('rc.monitor.reportError', expect.anything());
  });
});
