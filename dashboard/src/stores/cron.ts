import { create } from 'zustand';
import { useGatewayStore } from './gateway';

export interface CronPreset {
  id: string;
  name: string;
  description: string;
  schedule: string;
  enabled: boolean;
  config: Record<string, unknown>;
  last_run_at: string | null;
  next_run_at: string | null;
  gateway_job_id: string | null;
}

// Agent turn messages for each preset
const PRESET_AGENT_TURNS: Record<string, string> = {
  arxiv_daily_scan:
    'Use monitor_get_context to check my active monitors, then search arXiv for new papers and use monitor_report to log findings. Summarize any interesting results.',
  citation_tracking_weekly:
    'Check for new citations of my tracked papers using library_citation_graph.',
  deadline_reminders_daily:
    'List tasks due within 24 hours using task_list and send me a summary.',
};

interface CronState {
  presets: CronPreset[];
  presetsLoaded: boolean;

  loadPresets: () => Promise<void>;
  activatePreset: (presetId: string, config?: Record<string, unknown>) => Promise<void>;
  deactivatePreset: (presetId: string) => Promise<void>;
  deletePreset: (presetId: string) => Promise<void>;
  updatePresetSchedule: (presetId: string, schedule: string) => Promise<void>;
}

// Mutex: tracks which presets have an activate/deactivate operation in-flight
const _inflightPresets = new Set<string>();

// Tracks whether we've reconciled cron jobs in the current gateway session.
// Reset when presetsLoaded goes back to false (gateway disconnect → reconnect).
let _reconciled = false;

/**
 * Re-register enabled cron presets with the gateway after a restart.
 *
 * Gateway cron jobs are in-memory only — they vanish on gateway restart.
 * RC persists enabled state + gateway_job_id in SQLite, so after reconnect
 * we detect enabled presets and re-create their gateway jobs.
 *
 * Flow per enabled preset:
 *   1. cron.remove(old job id) — silent fail if job doesn't exist
 *   2. cron.add(schedule, message) — create fresh gateway job
 *   3. rc.cron.presets.setJobId — persist new job id in plugin DB
 */
async function reconcileEnabledPresets(presets: CronPreset[]): Promise<void> {
  const client = useGatewayStore.getState().client;
  if (!client?.isConnected) return;

  const enabled = presets.filter((p) => p.enabled);
  if (enabled.length === 0) return;

  for (const preset of enabled) {
    if (_inflightPresets.has(preset.id)) continue;
    _inflightPresets.add(preset.id);
    try {
      // 1. Remove stale gateway job (silent fail — job may not exist after restart)
      if (preset.gateway_job_id) {
        try {
          await client.request('cron.remove', { id: preset.gateway_job_id });
        } catch {
          // Expected after gateway restart — job no longer exists
        }
      }

      // 2. Create fresh gateway cron job
      const message = PRESET_AGENT_TURNS[preset.id] ?? `Run cron preset: ${preset.id}`;
      const cronResult = await client.request<{ id: string }>('cron.add', {
        name: preset.name,
        schedule: { kind: 'cron' as const, expr: preset.schedule },
        message,
      });

      // 3. Persist new gateway job ID
      if (cronResult?.id) {
        await client.request('rc.cron.presets.setJobId', {
          preset_id: preset.id,
          job_id: cronResult.id,
        });
      }
    } catch (err) {
      console.warn(`[CronStore] reconcile failed for ${preset.id}:`, err);
    } finally {
      _inflightPresets.delete(preset.id);
    }
  }
}

export const useCronStore = create<CronState>()((set, get) => ({
  presets: [],
  presetsLoaded: false,

  loadPresets: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    try {
      const result = await client.request<{ presets: CronPreset[] }>('rc.cron.presets.list', {});
      set({ presets: result.presets, presetsLoaded: true });

      // On first load after (re)connect, reconcile enabled presets with gateway.
      // This re-registers cron jobs that were lost during gateway restart.
      if (!_reconciled) {
        _reconciled = true;
        reconcileEnabledPresets(result.presets).then(() => {
          // Reload to reflect updated gateway_job_ids
          get().loadPresets();
        });
      }
    } catch (err) {
      console.warn('[CronStore] loadPresets failed:', err);
    }
  },

  activatePreset: async (presetId: string, config?: Record<string, unknown>) => {
    if (_inflightPresets.has(presetId)) return;
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    _inflightPresets.add(presetId);
    try {
      // 1. Activate in our DB
      await client.request('rc.cron.presets.activate', { preset_id: presetId, config });

      // 2. Find preset definition for schedule
      const preset = get().presets.find((p) => p.id === presetId);
      if (!preset) return;

      // 3. Create actual gateway cron job
      const message = PRESET_AGENT_TURNS[presetId] ?? `Run cron preset: ${presetId}`;
      const cronResult = await client.request<{ id: string }>('cron.add', {
        name: preset.name,
        schedule: { kind: 'cron' as const, expr: preset.schedule },
        message,
      });

      // 4. Store the gateway job ID in our DB
      if (cronResult?.id) {
        await client.request('rc.cron.presets.setJobId', {
          preset_id: presetId,
          job_id: cronResult.id,
        });
      }

      // 5. Reload presets to reflect new state
      await get().loadPresets();
    } catch (err) {
      console.error('[CronStore] activatePreset failed:', err);
      // Reload to get consistent state
      await get().loadPresets();
    } finally {
      _inflightPresets.delete(presetId);
    }
  },

  deactivatePreset: async (presetId: string) => {
    if (_inflightPresets.has(presetId)) return;
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    _inflightPresets.add(presetId);
    try {
      // 1. Find preset to get gateway_job_id
      const preset = get().presets.find((p) => p.id === presetId);

      // 2. Remove gateway cron job if we have a job ID
      if (preset?.gateway_job_id) {
        try {
          await client.request('cron.remove', { id: preset.gateway_job_id });
        } catch (err) {
          console.warn('[CronStore] cron.remove failed (job may not exist):', err);
        }
      }

      // 3. Deactivate in our DB
      await client.request('rc.cron.presets.deactivate', { preset_id: presetId });

      // 4. Reload presets
      await get().loadPresets();
    } catch (err) {
      console.error('[CronStore] deactivatePreset failed:', err);
      await get().loadPresets();
    } finally {
      _inflightPresets.delete(presetId);
    }
  },

  updatePresetSchedule: async (presetId: string, schedule: string) => {
    if (_inflightPresets.has(presetId)) return;
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    _inflightPresets.add(presetId);
    try {
      // 1. Persist new schedule in plugin DB
      const result = await client.request<{ ok: true; preset: CronPreset }>(
        'rc.cron.presets.updateSchedule',
        { preset_id: presetId, schedule },
      );
      const preset = result.preset;

      // 2. If preset is active, re-register gateway cron job with new schedule
      if (preset.enabled && preset.gateway_job_id) {
        // Remove old gateway job
        try {
          await client.request('cron.remove', { id: preset.gateway_job_id });
        } catch {
          // Old job may not exist
        }

        // Create new gateway job with updated schedule
        const message = PRESET_AGENT_TURNS[presetId] ?? `Run cron preset: ${presetId}`;
        const cronResult = await client.request<{ id: string }>('cron.add', {
          name: preset.name,
          schedule: { kind: 'cron' as const, expr: schedule },
          message,
        });

        // Store new gateway job ID
        if (cronResult?.id) {
          await client.request('rc.cron.presets.setJobId', {
            preset_id: presetId,
            job_id: cronResult.id,
          });
        }
      }

      // 3. Reload presets to reflect all changes
      await get().loadPresets();
    } catch (err) {
      console.error('[CronStore] updatePresetSchedule failed:', err);
      await get().loadPresets();
    } finally {
      _inflightPresets.delete(presetId);
    }
  },

  deletePreset: async (presetId: string) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    try {
      // 1. If enabled, remove gateway cron job first
      const preset = get().presets.find((p) => p.id === presetId);
      if (preset?.gateway_job_id) {
        try {
          await client.request('cron.remove', { id: preset.gateway_job_id });
        } catch (err) {
          console.warn('[CronStore] cron.remove failed during delete:', err);
        }
      }

      // 2. Delete from plugin DB
      await client.request('rc.cron.presets.delete', { preset_id: presetId });

      // 3. Reload presets
      await get().loadPresets();
    } catch (err) {
      console.error('[CronStore] deletePreset failed:', err);
      await get().loadPresets();
    }
  },
}));

// DISABLED: Old cron preset reconciliation is replaced by the monitor system.
// The subscribe below was creating duplicate gateway cron jobs that conflicted
// with rc_monitors. Kept commented for reference during migration period.
//
// if (typeof useGatewayStore.subscribe === 'function') {
//   useGatewayStore.subscribe((state) => {
//     if (state.state !== 'connected') {
//       _reconciled = false;
//       useCronStore.setState({ presetsLoaded: false });
//     }
//   });
// }
