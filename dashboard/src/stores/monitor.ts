/**
 * Monitor Store — unified replacement for radar.ts + cron.ts
 *
 * Manages N independent monitoring targets. Each monitor is backed by a
 * gateway cron job that triggers isolated agent turns on schedule.
 *
 * Key simplification vs the old cron.ts:
 *   - OC persists cron jobs to disk (jobs.json), but RC still verifies that
 *     enabled monitors have a live gateway job after reconnect/manual edits.
 *   - No PRESET_DEFINITIONS hardcoded list — monitors are DB-driven
 *   - No _inflightPresets mutex — use simple loading flag instead
 */

import { create } from 'zustand';
import { useGatewayStore } from './gateway';

export interface Monitor {
  id: string;
  name: string;
  source_type: string;
  target: string;
  filters: Record<string, unknown>;
  schedule: string;
  enabled: boolean;
  notify: boolean;
  agent_prompt: string;
  gateway_job_id: string | null;
  last_check_at: string | null;
  last_results: unknown[] | null;
  last_error: string | null;
  check_count: number;
  finding_count: number;
  created_at: string;
  updated_at: string;
}

interface MonitorState {
  monitors: Monitor[];
  loading: boolean;
  loaded: boolean;

  loadMonitors: () => Promise<void>;
  toggleMonitor: (id: string, enabled: boolean) => Promise<void>;
  deleteMonitor: (id: string) => Promise<void>;
  updateMonitor: (id: string, patch: Partial<Monitor>) => Promise<void>;
  runMonitor: (id: string) => Promise<void>;
}

type CronJobRow = { id?: unknown };

// Tracks in-flight toggle/delete operations to prevent race conditions
const _inflightOps = new Set<string>();

// Tracks whether we've reconciled monitor cron bindings in this gateway session.
let _reconciled = false;

function extractCronJobIds(res: unknown): Set<string> | null {
  const jobs = Array.isArray(res)
    ? res
    : res && typeof res === 'object'
      ? Object.values(res as Record<string, unknown>).find(Array.isArray)
      : null;

  if (!Array.isArray(jobs)) return null;

  const ids = new Set<string>();
  for (const job of jobs) {
    if (!job || typeof job !== 'object') continue;
    const id = (job as CronJobRow).id;
    if (typeof id === 'string' && id) ids.add(id);
  }
  return ids;
}

async function registerMonitorCronJob(monitor: Monitor): Promise<string | null> {
  const client = useGatewayStore.getState().client;
  if (!client?.isConnected) return null;

  const cronResult = await client.request<{ id: string }>('cron.add', {
    name: `[rc-monitor] ${monitor.name}`,
    description: `Monitor: ${monitor.id}`,
    schedule: { kind: 'cron' as const, expr: monitor.schedule },
    sessionTarget: 'isolated',
    payload: { kind: 'agentTurn', message: monitor.agent_prompt },
  });

  if (!cronResult?.id) return null;
  await client.request('rc.monitor.setJobId', { id: monitor.id, job_id: cronResult.id });
  return cronResult.id;
}

async function reconcileEnabledMonitors(monitors: Monitor[]): Promise<{ verified: boolean; repaired: boolean }> {
  const client = useGatewayStore.getState().client;
  if (!client?.isConnected) return { verified: false, repaired: false };

  const enabled = monitors.filter((m) => m.enabled);
  if (enabled.length === 0) return { verified: true, repaired: false };

  let jobIds: Set<string> | null = null;
  try {
    jobIds = extractCronJobIds(await client.request<unknown>('cron.list', {}));
  } catch (err) {
    console.warn('[MonitorStore] cron.list failed during reconcile:', err);
    return { verified: false, repaired: false };
  }

  // Unknown cron.list shape. Avoid creating duplicates if we cannot verify.
  if (!jobIds) return { verified: false, repaired: false };

  let repaired = false;
  for (const monitor of enabled) {
    const hasLiveJob = monitor.gateway_job_id ? jobIds.has(monitor.gateway_job_id) : false;
    if (hasLiveJob) continue;
    if (_inflightOps.has(monitor.id)) continue;

    _inflightOps.add(monitor.id);
    try {
      const jobId = await registerMonitorCronJob(monitor);
      repaired = repaired || Boolean(jobId);
    } catch (err) {
      console.warn(`[MonitorStore] reconcile failed for ${monitor.id}:`, err);
    } finally {
      _inflightOps.delete(monitor.id);
    }
  }

  return { verified: true, repaired };
}

export const useMonitorStore = create<MonitorState>()((set, get) => ({
  monitors: [],
  loading: false,
  loaded: false,

  loadMonitors: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    if (get().loading) return;

    set({ loading: true });
    try {
      const result = await client.request<{ items: Monitor[]; total: number }>('rc.monitor.list', { limit: 100 });
      let items = result.items;

      if (!_reconciled) {
        const outcome = await reconcileEnabledMonitors(result.items);
        _reconciled = outcome.verified;
        if (outcome.repaired) {
          const refreshed = await client.request<{ items: Monitor[]; total: number }>('rc.monitor.list', { limit: 100 });
          items = refreshed.items;
        }
      }

      set({ monitors: items, loaded: true });
    } catch (err) {
      console.warn('[MonitorStore] loadMonitors failed:', err);
    } finally {
      set({ loading: false });
    }
  },

  toggleMonitor: async (id: string, enabled: boolean) => {
    if (_inflightOps.has(id)) return; // Prevent rapid double-toggle
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    _inflightOps.add(id);
    // Optimistic update
    set((s) => ({
      monitors: s.monitors.map((m) => (m.id === id ? { ...m, enabled } : m)),
    }));

    try {
      // 1. Toggle in plugin DB
      const updated = await client.request<Monitor>('rc.monitor.toggle', { id, enabled });

      if (enabled) {
        // 2a. Clean up any stale gateway job before creating new one
        if (updated.gateway_job_id) {
          try { await client.request('cron.remove', { id: updated.gateway_job_id }); } catch { /* */ }
        }

        // 2b/3. Create gateway cron job and store gateway job ID in plugin DB
        await registerMonitorCronJob(updated);
      } else {
        // 2b. Remove gateway cron job
        if (updated.gateway_job_id) {
          try {
            await client.request('cron.remove', { id: updated.gateway_job_id });
          } catch {
            // Job may not exist
          }
        }
        await client.request('rc.monitor.setJobId', { id, job_id: '' });
      }

      // 4. Reload to get consistent state
      await get().loadMonitors();
    } catch (err) {
      console.error('[MonitorStore] toggleMonitor failed:', err);
      await get().loadMonitors(); // Rollback optimistic
    } finally {
      _inflightOps.delete(id);
    }
  },

  deleteMonitor: async (id: string) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    const monitor = get().monitors.find((m) => m.id === id);

    try {
      // 1. Remove gateway cron job if exists
      if (monitor?.gateway_job_id) {
        try {
          await client.request('cron.remove', { id: monitor.gateway_job_id });
        } catch {
          // Job may not exist
        }
      }

      // 2. Delete from plugin DB
      await client.request('rc.monitor.delete', { id });

      // 3. Optimistic remove + reload
      set((s) => ({
        monitors: s.monitors.filter((m) => m.id !== id),
      }));
    } catch (err) {
      console.error('[MonitorStore] deleteMonitor failed:', err);
      await get().loadMonitors();
    }
  },

  updateMonitor: async (id: string, patch: Partial<Monitor>) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    try {
      const updated = await client.request<Monitor>('rc.monitor.update', { id, ...patch });

      // If schedule changed and monitor is enabled, re-register cron job
      if (patch.schedule && updated.enabled && updated.gateway_job_id) {
        // Remove old
        try {
          await client.request('cron.remove', { id: updated.gateway_job_id });
        } catch { /* */ }

        // Create new and persist gateway job ID
        await registerMonitorCronJob(updated);
      }

      await get().loadMonitors();
    } catch (err) {
      console.error('[MonitorStore] updateMonitor failed:', err);
      await get().loadMonitors();
    }
  },

  runMonitor: async (id: string) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    try {
      const monitor = get().monitors.find((m) => m.id === id);
      if (!monitor?.gateway_job_id) {
        console.warn('[MonitorStore] Cannot run monitor without gateway job. Enable it first.');
        return;
      }

      await client.request('cron.run', { id: monitor.gateway_job_id, mode: 'force' });
    } catch (err) {
      console.error('[MonitorStore] runMonitor failed:', err);
    }
  },
}));

export function resetMonitorReconciled(): void {
  _reconciled = false;
}
