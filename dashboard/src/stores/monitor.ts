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

export interface MonitorCreateInput {
  name: string;
  source_type: string;
  target?: string;
  filters?: Record<string, unknown>;
  schedule?: string;
  enabled?: boolean;
  notify?: boolean;
  /** Leave empty to let the plugin call defaultAgentPrompt(source_type, filters). */
  agent_prompt?: string;
}

interface MonitorState {
  monitors: Monitor[];
  loading: boolean;
  loaded: boolean;

  loadMonitors: () => Promise<void>;
  createMonitor: (input: MonitorCreateInput) => Promise<Monitor | null>;
  toggleMonitor: (id: string, enabled: boolean) => Promise<void>;
  deleteMonitor: (id: string) => Promise<void>;
  updateMonitor: (id: string, patch: Partial<Monitor>) => Promise<void>;
  runMonitor: (id: string) => Promise<void>;
}

type CronJobRow = { id?: unknown; state?: unknown; sessionKey?: unknown; name?: unknown };
type CronJobSnapshot = {
  id: string;
  sessionKey: string | null;
  name: string;
  state: Record<string, unknown>;
  schedule: unknown;
  payload: Record<string, unknown>;
  lastRunAtMs: number | null;
  lastStatus: string;
  lastError: string;
};

// Tracks in-flight toggle/delete operations to prevent race conditions
const _inflightOps = new Set<string>();

// Tracks whether we've reconciled monitor cron bindings in this gateway session.
let _reconciled = false;

function extractCronJobs(res: unknown): Map<string, CronJobSnapshot> | null {
  const jobs = Array.isArray(res)
    ? res
    : res && typeof res === 'object'
      ? Object.values(res as Record<string, unknown>).find(Array.isArray)
      : null;

  if (!Array.isArray(jobs)) return null;

  const snapshots = new Map<string, CronJobSnapshot>();
  for (const job of jobs) {
    if (!job || typeof job !== 'object') continue;
    const row = job as CronJobRow & Record<string, unknown>;
    const id = row.id;
    if (typeof id !== 'string' || !id) continue;

    const state = row.state && typeof row.state === 'object'
      ? row.state as Record<string, unknown>
      : {};
    const payload = row.payload && typeof row.payload === 'object'
      ? row.payload as Record<string, unknown>
      : {};
    const lastRunAtMs = typeof state.lastRunAtMs === 'number'
      ? state.lastRunAtMs
      : typeof row.lastRunAtMs === 'number'
        ? row.lastRunAtMs
        : null;
    const lastStatus = String(state.lastRunStatus ?? state.lastStatus ?? row.status ?? '').toLowerCase();
    const lastError = String(state.lastError ?? state.error ?? row.error ?? '');

    const sessionKey = typeof row.sessionKey === 'string' && row.sessionKey ? row.sessionKey : null;
    const name = typeof row.name === 'string' ? row.name : '';

    snapshots.set(id, { id, sessionKey, name, state, schedule: row.schedule, payload, lastRunAtMs, lastStatus, lastError });
  }
  return snapshots;
}

async function loadCronJobs(): Promise<Map<string, CronJobSnapshot> | null> {
  const client = useGatewayStore.getState().client;
  if (!client?.isConnected) return null;

  try {
    return extractCronJobs(await client.request<unknown>('cron.list', {}));
  } catch (err) {
    console.warn('[MonitorStore] cron.list failed:', err);
    return null;
  }
}

function dateMs(value: string | null): number {
  if (!value) return 0;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isFailedCronRun(job: CronJobSnapshot): boolean {
  if (job.lastError) return true;
  return /error|failed|aborted|timeout/.test(job.lastStatus);
}

function formatCronRunError(job: CronJobSnapshot): string {
  const status = job.lastStatus || 'failed';
  const reason = typeof job.state.lastErrorReason === 'string' ? ` (${job.state.lastErrorReason})` : '';
  const detail = job.lastError ? `: ${job.lastError}` : '';
  return `Gateway cron run ${status}${reason}${detail}`.slice(0, 1000);
}

function buildMonitorCronMessage(monitor: Monitor): string {
  const header = [
    `[Research-Claw Monitor Scheduled Run]`,
    `MONITOR_ID: ${monitor.id}`,
    `MONITOR_NAME: ${monitor.name}`,
    `SOURCE_TYPE: ${monitor.source_type}`,
    `TARGET: ${monitor.target || '(none)'}`,
    '',
  ].join('\n');

  if (monitor.source_type === 'device') {
    // Device monitors: no EXECUTION PROTOCOL collector header.
    // The agent_prompt already contains the periph_camera_snap vision protocol
    // (stored via defaultAgentPrompt('device') in the plugin).
    // Dashboard replaces two classes of placeholders:
    //   {target}               → monitor.target (device id)
    //   {check_prompt ...}     → filters.check_prompt (non-empty) or template default
    const checkPrompt =
      typeof monitor.filters?.check_prompt === 'string' && monitor.filters.check_prompt.trim()
        ? monitor.filters.check_prompt.trim()
        : '描述画面中正在发生什么,判断是否存在异常。';

    const body = monitor.agent_prompt
      .replaceAll('{target}', monitor.target)
      .replace(/\{check_prompt[^}]*\}/, checkPrompt);

    return header + body;
  }

  return header + [
    'You are executing a scheduled monitor. Follow this exact protocol:',
    'Tool boundary: use monitor_get_context, monitor_collect_candidates, monitor_report, monitor_note, and send_notification only. Do not call read, task_flow_stage, workspace_* or other task/workspace tools for this scheduled monitor.',
    `1. CONTEXT: call monitor_get_context with {"monitor_id":"${monitor.id}"}.`,
    `2. COLLECT: call monitor_collect_candidates with {"monitor_id":"${monitor.id}"} to gather raw source candidates in the core collector layer.`,
    '3. ANALYZE: inspect/filter the collected candidates against the monitor goal. Only use browser/search if the collector reports errors or lacks enough context.',
    `4. REPORT: call monitor_report with monitor_id="${monitor.id}", final results, and the exact fingerprint values returned by monitor_collect_candidates for accepted candidates; do not invent date-based or summary-based fingerprints.`,
    `5. OBSERVE: call monitor_note with monitor_id="${monitor.id}" if source reliability, errors, or useful patterns should be remembered.`,
    '6. NOTIFY: if the context says notify=true and monitor_report found new items, call send_notification.',
    '',
    'Stored monitor agent prompt:',
    monitor.agent_prompt,
  ].join('\n');
}

async function registerMonitorCronJob(monitor: Monitor): Promise<string | null> {
  const client = useGatewayStore.getState().client;
  if (!client?.isConnected) return null;

  const cronResult = await client.request<{ id: string }>('cron.add', {
    name: `[rc-monitor] ${monitor.name}`,
    description: `Monitor: ${monitor.id}`,
    schedule: { kind: 'cron' as const, expr: monitor.schedule },
    sessionKey: `cron:rc-monitor:${monitor.id}`,
    sessionTarget: 'isolated',
    payload: {
      kind: 'agentTurn',
      message: buildMonitorCronMessage(monitor),
      timeoutSeconds: 900,
    },
    delivery: {
      mode: 'none',
      channel: 'last',
    },
  });

  if (!cronResult?.id) return null;
  await client.request('rc.monitor.setJobId', { id: monitor.id, job_id: cronResult.id });
  return cronResult.id;
}

function expectedMonitorSessionKey(monitor: Monitor): string {
  return `cron:rc-monitor:${monitor.id}`;
}

function expectedMonitorName(monitor: Monitor): string {
  return `[rc-monitor] ${monitor.name}`;
}

function cronJobMatchesMonitor(job: CronJobSnapshot, monitor: Monitor): boolean {
  if (job.sessionKey === expectedMonitorSessionKey(monitor)) return true;
  if (job.id === monitor.gateway_job_id) return true;
  return job.name === expectedMonitorName(monitor);
}

function cronJobNeedsRefresh(monitor: Monitor, job: CronJobSnapshot): boolean {
  if (job.sessionKey && job.sessionKey !== expectedMonitorSessionKey(monitor)) return true;
  const expectedMessage = buildMonitorCronMessage(monitor);
  if (Object.keys(job.payload).length > 0 && job.payload.kind !== 'agentTurn') return true;
  if (typeof job.payload.message === 'string' && job.payload.message !== expectedMessage) return true;
  if (Object.keys(job.payload).length > 0 && job.payload.timeoutSeconds !== 900) return true;

  const schedule = job.schedule && typeof job.schedule === 'object'
    ? job.schedule as Record<string, unknown>
    : {};
  if (Object.keys(schedule).length > 0 && (schedule.kind !== 'cron' || schedule.expr !== monitor.schedule)) return true;

  return false;
}

async function syncMonitorRunErrors(
  monitors: Monitor[],
  cronJobs: Map<string, CronJobSnapshot> | null,
): Promise<boolean> {
  const client = useGatewayStore.getState().client;
  if (!client?.isConnected || !cronJobs) return false;

  let updated = false;
  for (const monitor of monitors) {
    if (!monitor.enabled || !monitor.gateway_job_id) continue;
    const job = cronJobs.get(monitor.gateway_job_id);
    if (!job || !isFailedCronRun(job)) continue;
    if (job.lastRunAtMs !== null && job.lastRunAtMs <= dateMs(monitor.last_check_at)) continue;

    try {
      await client.request('rc.monitor.reportError', {
        id: monitor.id,
        error: formatCronRunError(job),
      });
      updated = true;
    } catch (err) {
      console.warn(`[MonitorStore] failed to sync monitor cron error for ${monitor.id}:`, err);
    }
  }

  return updated;
}

async function reconcileEnabledMonitors(
  monitors: Monitor[],
  cronJobs?: Map<string, CronJobSnapshot> | null,
): Promise<{ verified: boolean; repaired: boolean }> {
  const client = useGatewayStore.getState().client;
  if (!client?.isConnected) return { verified: false, repaired: false };

  const jobs = cronJobs ?? await loadCronJobs();

  // Unknown cron.list shape. Avoid creating duplicates if we cannot verify.
  if (!jobs) return { verified: false, repaired: false };

  let repaired = false;
  let repairFailed = false;
  for (const monitor of monitors) {
    const matches = Array.from(jobs.values()).filter((job) => cronJobMatchesMonitor(job, monitor));

    if (!monitor.enabled) {
      if (_inflightOps.has(monitor.id)) continue;

      _inflightOps.add(monitor.id);
      try {
        for (const job of matches) {
          try { await client.request('cron.remove', { id: job.id }); } catch { /* stale job may already be gone */ }
        }
        if (monitor.gateway_job_id) {
          await client.request('rc.monitor.setJobId', { id: monitor.id, job_id: '' });
          repaired = true;
        }
      } catch (err) {
        console.warn(`[MonitorStore] disabled monitor cleanup failed for ${monitor.id}:`, err);
        repairFailed = true;
      } finally {
        _inflightOps.delete(monitor.id);
      }
      continue;
    }

    const liveJob = matches.find((job) => job.id === monitor.gateway_job_id && !cronJobNeedsRefresh(monitor, job))
      ?? matches.find((job) => !cronJobNeedsRefresh(monitor, job));
    const duplicates = matches.filter((job) => job.id !== liveJob?.id);

    if (duplicates.length === 0 && liveJob && liveJob.id === monitor.gateway_job_id) continue;
    if (_inflightOps.has(monitor.id)) continue;

    _inflightOps.add(monitor.id);
    try {
      for (const job of duplicates) {
        try { await client.request('cron.remove', { id: job.id }); } catch { /* stale job may already be gone */ }
      }

      if (liveJob) {
        if (liveJob.id !== monitor.gateway_job_id) {
          await client.request('rc.monitor.setJobId', { id: monitor.id, job_id: liveJob.id });
          repaired = true;
        }
        continue;
      }

      const jobId = await registerMonitorCronJob(monitor);
      if (jobId) repaired = true;
      else repairFailed = true;
    } catch (err) {
      console.warn(`[MonitorStore] reconcile failed for ${monitor.id}:`, err);
      repairFailed = true;
    } finally {
      _inflightOps.delete(monitor.id);
    }
  }

  return { verified: !repairFailed, repaired };
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
      const cronJobs = await loadCronJobs();

      if (!_reconciled) {
        const outcome = await reconcileEnabledMonitors(result.items, cronJobs);
        _reconciled = outcome.verified;
        if (outcome.repaired) {
          const refreshed = await client.request<{ items: Monitor[]; total: number }>('rc.monitor.list', { limit: 100 });
          items = refreshed.items;
        }
      }

      if (await syncMonitorRunErrors(items, cronJobs)) {
        const refreshed = await client.request<{ items: Monitor[]; total: number }>('rc.monitor.list', { limit: 100 });
        items = refreshed.items;
      }

      set({ monitors: items, loaded: true });
    } catch (err) {
      console.warn('[MonitorStore] loadMonitors failed:', err);
    } finally {
      set({ loading: false });
    }
  },

  createMonitor: async (input: MonitorCreateInput): Promise<Monitor | null> => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return null;

    try {
      // agent_prompt left empty → plugin calls defaultAgentPrompt(source_type, filters)
      const monitor = await client.request<Monitor>('rc.monitor.create', {
        ...input,
        enabled: input.enabled ?? false,
      });
      set((s) => ({ monitors: [...s.monitors, monitor] }));
      return monitor;
    } catch (err) {
      console.error('[MonitorStore] createMonitor failed:', err);
      return null;
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
      if (patch.schedule && updated.enabled) {
        if (updated.gateway_job_id) {
          try {
            await client.request('cron.remove', { id: updated.gateway_job_id });
          } catch { /* */ }
        }

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
      await get().loadMonitors();
    } catch (err) {
      console.error('[MonitorStore] runMonitor failed:', err);
    }
  },
}));

export function resetMonitorReconciled(): void {
  _reconciled = false;
}

/**
 * Test-only export: exposes buildMonitorCronMessage for parity tests without
 * the need to restructure the module. Not intended for production use.
 * @internal
 */
export { buildMonitorCronMessage as testBuildMonitorCronMessage };
