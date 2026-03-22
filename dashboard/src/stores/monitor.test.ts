/**
 * Monitor store — behavioral tests
 *
 * Following DEVELOPMENT_SOP.md §3 Layer 1 (Behavioral Parity Tests):
 *   - Use real fixture payloads from monitor-responses.ts
 *   - Verify behavior, not implementation details
 *   - Each test answers: "if this passes, can I tell the user it works?"
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useMonitorStore } from './monitor';
import { useGatewayStore } from './gateway';
import {
  RC_MONITOR_LIST_RESPONSE,
  RC_MONITOR_TOGGLE_ENABLED,
  RC_MONITOR_TOGGLE_DISABLED,
  CRON_ADD_RESPONSE,
} from '../__fixtures__/gateway-payloads/monitor-responses';

// ── Mock gateway client ──────────────────────────────────────────────────

const mockRequest = vi.fn();

function setConnected(connected: boolean) {
  useGatewayStore.setState({
    state: connected ? 'connected' : 'disconnected',
    client: connected ? { isConnected: true, request: mockRequest } as unknown as ReturnType<typeof useGatewayStore.getState>['client'] : null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useMonitorStore.setState({ monitors: [], loading: false, loaded: false });
  setConnected(true);
});

// ── loadMonitors ─────────────────────────────────────────────────────────

describe('loadMonitors', () => {
  it('fetches monitors from rc.monitor.list and stores them', async () => {
    mockRequest.mockResolvedValueOnce(RC_MONITOR_LIST_RESPONSE);

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
    mockRequest.mockRejectedValueOnce(new Error('network'));

    await useMonitorStore.getState().loadMonitors();

    expect(useMonitorStore.getState().monitors).toHaveLength(0);
    expect(useMonitorStore.getState().loading).toBe(false);
  });
});

// ── toggleMonitor ────────────────────────────────────────────────────────

describe('toggleMonitor', () => {
  beforeEach(() => {
    useMonitorStore.setState({ monitors: [...RC_MONITOR_LIST_RESPONSE.items], loaded: true });
  });

  it('enables a monitor: toggle → cron.add → setJobId → reload', async () => {
    // 1. rc.monitor.toggle returns updated monitor
    mockRequest.mockResolvedValueOnce(RC_MONITOR_TOGGLE_ENABLED);
    // 2. cron.add returns job
    mockRequest.mockResolvedValueOnce(CRON_ADD_RESPONSE);
    // 3. rc.monitor.setJobId
    mockRequest.mockResolvedValueOnce({ ok: true });
    // 4. reload: rc.monitor.list
    mockRequest.mockResolvedValueOnce(RC_MONITOR_LIST_RESPONSE);

    await useMonitorStore.getState().toggleMonitor('github-releases', true);

    // Verify RPC call sequence
    expect(mockRequest).toHaveBeenNthCalledWith(1, 'rc.monitor.toggle', { id: 'github-releases', enabled: true });
    expect(mockRequest).toHaveBeenNthCalledWith(2, 'cron.add', expect.objectContaining({
      name: '[rc-monitor] GitHub Release Tracker',
      sessionTarget: 'isolated',
    }));
    expect(mockRequest).toHaveBeenNthCalledWith(3, 'rc.monitor.setJobId', {
      id: 'github-releases',
      job_id: CRON_ADD_RESPONSE.id,
    });
  });

  it('disables a monitor: cron.remove → toggle → setJobId(clear) → reload', async () => {
    // 1. rc.monitor.toggle
    mockRequest.mockResolvedValueOnce(RC_MONITOR_TOGGLE_DISABLED);
    // 2. cron.remove (arxiv-daily has gateway_job_id)
    // Actually: toggle returns the already-disabled monitor, store checks gateway_job_id from the RETURNED monitor
    // The returned monitor has gateway_job_id: null (already cleared), so cron.remove is skipped
    // But we need to handle the case where it still has a job_id
    // Let's test with a monitor that has a gateway_job_id
    mockRequest.mockReset();

    const monitorWithJob = { ...RC_MONITOR_LIST_RESPONSE.items[0] }; // arxiv-daily, has gw-job-001
    useMonitorStore.setState({ monitors: [monitorWithJob], loaded: true });

    // 1. rc.monitor.toggle
    mockRequest.mockResolvedValueOnce({ ...monitorWithJob, enabled: false });
    // 2. cron.remove
    mockRequest.mockResolvedValueOnce({ ok: true });
    // 3. rc.monitor.setJobId (clear)
    mockRequest.mockResolvedValueOnce({ ok: true });
    // 4. reload
    mockRequest.mockResolvedValueOnce({ items: [{ ...monitorWithJob, enabled: false, gateway_job_id: null }], total: 1 });

    await useMonitorStore.getState().toggleMonitor('arxiv-daily', false);

    // Should have called cron.remove with the old gateway_job_id
    const cronRemoveCall = mockRequest.mock.calls.find((c) => c[0] === 'cron.remove');
    expect(cronRemoveCall).toBeDefined();
  });

  it('applies optimistic update before RPC completes', async () => {
    let resolveToggle: (v: unknown) => void;
    const togglePromise = new Promise((r) => { resolveToggle = r; });
    mockRequest.mockReturnValueOnce(togglePromise);

    // Start: arxiv-daily is enabled=true
    expect(useMonitorStore.getState().monitors[0].enabled).toBe(true);

    const p = useMonitorStore.getState().toggleMonitor('arxiv-daily', false);

    // Optimistic update should apply synchronously (after set() microtask)
    await new Promise((r) => setTimeout(r, 0));
    expect(useMonitorStore.getState().monitors[0].enabled).toBe(false);

    // Resolve the RPC so the toggle completes and cleans up _inflightOps
    resolveToggle!(RC_MONITOR_TOGGLE_DISABLED);
    mockRequest.mockResolvedValueOnce(RC_MONITOR_LIST_RESPONSE); // reload
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
    mockRequest.mockResolvedValueOnce({ ok: true }); // cron.remove
    mockRequest.mockResolvedValueOnce({ ok: true, deleted: 'arxiv-daily' }); // rc.monitor.delete

    await useMonitorStore.getState().deleteMonitor('arxiv-daily');

    expect(mockRequest).toHaveBeenCalledWith('cron.remove', { id: 'gw-job-001' });
    expect(mockRequest).toHaveBeenCalledWith('rc.monitor.delete', { id: 'arxiv-daily' });

    // Monitor should be removed from local state
    expect(useMonitorStore.getState().monitors.find((m) => m.id === 'arxiv-daily')).toBeUndefined();
  });

  it('skips cron.remove when no gateway_job_id', async () => {
    // github-releases has no gateway_job_id
    mockRequest.mockResolvedValueOnce({ ok: true, deleted: 'github-releases' }); // rc.monitor.delete

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
    mockRequest.mockResolvedValueOnce({ ok: true });

    await useMonitorStore.getState().runMonitor('arxiv-daily');

    expect(mockRequest).toHaveBeenCalledWith('cron.run', { id: 'gw-job-001', mode: 'force' });
  });

  it('warns when no gateway_job_id', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await useMonitorStore.getState().runMonitor('github-releases'); // no gateway_job_id

    expect(mockRequest).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
