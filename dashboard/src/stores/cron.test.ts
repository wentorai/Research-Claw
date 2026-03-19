/**
 * Cron Store — Unit Tests
 *
 * Tests for the Zustand cron store:
 * - loadPresets: RPC call, state update
 * - activatePreset: DB activate + gateway cron.add + setJobId + reload
 * - deactivatePreset: gateway cron.remove + DB deactivate + reload
 * - deletePreset: gateway cron.remove + DB rc.cron.presets.delete + reload (GAP-14)
 * - Error handling and no-op guards
 * - Mutex: inflight preset protection
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useCronStore, type CronPreset } from './cron';

// ── Mock Gateway ────────────────────────────────────────────────────────────

const mockRequest = vi.fn();
const mockGatewayClient = {
  isConnected: true,
  request: mockRequest,
};

vi.mock('./gateway', () => ({
  useGatewayStore: {
    getState: () => ({
      client: mockGatewayClient,
    }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}));

// ── Fixtures ────────────────────────────────────────────────────────────────

function makePreset(overrides: Partial<CronPreset> = {}): CronPreset {
  return {
    id: 'arxiv_daily_scan',
    name: 'arXiv Daily Scan',
    description: 'Scan arXiv for new papers matching your research interests daily.',
    schedule: '0 7 * * *',
    enabled: false,
    config: {},
    last_run_at: null,
    next_run_at: null,
    gateway_job_id: null,
    ...overrides,
  };
}

const FIVE_PRESETS: CronPreset[] = [
  makePreset({ id: 'arxiv_daily_scan', name: 'arXiv Daily Scan', schedule: '0 7 * * *' }),
  makePreset({ id: 'citation_tracking_weekly', name: 'Citation Tracking Weekly', schedule: '0 8 * * 1' }),
  makePreset({ id: 'deadline_reminders_daily', name: 'Deadline Reminders Daily', schedule: '0 9 * * *', enabled: true }),
  makePreset({ id: 'group_meeting_prep', name: 'Group Meeting Prep', schedule: '0 9 * * 1-5' }),
  makePreset({ id: 'weekly_report', name: 'Weekly Report', schedule: '0 17 * * 5' }),
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Cron Store', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGatewayClient.isConnected = true;
    useCronStore.setState({
      presets: [],
      presetsLoaded: false,
    });
  });

  // ── loadPresets ────────────────────────────────────────────────────────

  describe('loadPresets', () => {
    it('calls rc.cron.presets.list RPC and stores result', async () => {
      mockRequest.mockResolvedValueOnce({ presets: FIVE_PRESETS });

      await useCronStore.getState().loadPresets();

      expect(mockRequest).toHaveBeenCalledWith('rc.cron.presets.list', {});
      expect(useCronStore.getState().presets).toHaveLength(5);
      expect(useCronStore.getState().presetsLoaded).toBe(true);
    });

    it('is a no-op when client is not connected', async () => {
      mockGatewayClient.isConnected = false;

      await useCronStore.getState().loadPresets();

      expect(mockRequest).not.toHaveBeenCalled();
      expect(useCronStore.getState().presetsLoaded).toBe(false);
    });

    it('warns but does not throw on RPC failure', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockRequest.mockRejectedValueOnce(new Error('RPC timeout'));

      await useCronStore.getState().loadPresets();

      expect(warnSpy).toHaveBeenCalledWith(
        '[CronStore] loadPresets failed:',
        expect.any(Error),
      );
      expect(useCronStore.getState().presetsLoaded).toBe(false);
      warnSpy.mockRestore();
    });
  });

  // ── activatePreset ─────────────────────────────────────────────────────

  describe('activatePreset', () => {
    it('calls rc.cron.presets.activate, cron.add, setJobId, then reloads', async () => {
      useCronStore.setState({ presets: FIVE_PRESETS, presetsLoaded: true });

      // 1. activate in DB
      mockRequest.mockResolvedValueOnce({ ok: true });
      // 2. cron.add → returns gateway job ID
      mockRequest.mockResolvedValueOnce({ id: 'gw-job-001' });
      // 3. setJobId
      mockRequest.mockResolvedValueOnce({ ok: true });
      // 4. reload presets
      mockRequest.mockResolvedValueOnce({ presets: FIVE_PRESETS });

      await useCronStore.getState().activatePreset('arxiv_daily_scan');

      expect(mockRequest).toHaveBeenNthCalledWith(1, 'rc.cron.presets.activate', {
        preset_id: 'arxiv_daily_scan',
        config: undefined,
      });
      expect(mockRequest).toHaveBeenNthCalledWith(2, 'cron.add', {
        name: 'arXiv Daily Scan',
        schedule: { kind: 'cron', expr: '0 7 * * *' },
        message: 'Run cron preset: arxiv_daily_scan',
        sessionKey: 'cron:rc-preset:arxiv_daily_scan',
      });
      expect(mockRequest).toHaveBeenNthCalledWith(3, 'rc.cron.presets.setJobId', {
        preset_id: 'arxiv_daily_scan',
        job_id: 'gw-job-001',
      });
      expect(mockRequest).toHaveBeenNthCalledWith(4, 'rc.cron.presets.list', {});
    });

    it('uses default message for presets without PRESET_AGENT_TURNS entry', async () => {
      useCronStore.setState({ presets: FIVE_PRESETS, presetsLoaded: true });

      mockRequest.mockResolvedValueOnce({ ok: true }); // activate
      mockRequest.mockResolvedValueOnce({ id: 'gw-job-002' }); // cron.add
      mockRequest.mockResolvedValueOnce({ ok: true }); // setJobId
      mockRequest.mockResolvedValueOnce({ presets: FIVE_PRESETS }); // reload

      await useCronStore.getState().activatePreset('group_meeting_prep');

      expect(mockRequest).toHaveBeenNthCalledWith(2, 'cron.add', expect.objectContaining({
        message: 'Run cron preset: group_meeting_prep',
        sessionKey: 'cron:rc-preset:group_meeting_prep',
      }));
    });

    it('passes stable sessionKey based on preset ID (not gateway job ID)', async () => {
      useCronStore.setState({ presets: FIVE_PRESETS, presetsLoaded: true });

      mockRequest.mockResolvedValueOnce({ ok: true }); // activate
      mockRequest.mockResolvedValueOnce({ id: 'gw-job-new' }); // cron.add
      mockRequest.mockResolvedValueOnce({ ok: true }); // setJobId
      mockRequest.mockResolvedValueOnce({ presets: FIVE_PRESETS }); // reload

      await useCronStore.getState().activatePreset('deadline_reminders_daily');

      // sessionKey must be derived from preset ID (stable), not gateway job ID (volatile)
      const cronAddCall = mockRequest.mock.calls.find(
        (c: unknown[]) => c[0] === 'cron.add',
      );
      expect(cronAddCall).toBeDefined();
      expect(cronAddCall![1]).toHaveProperty(
        'sessionKey',
        'cron:rc-preset:deadline_reminders_daily',
      );
    });

    it('passes config to activate RPC when provided', async () => {
      useCronStore.setState({ presets: FIVE_PRESETS, presetsLoaded: true });

      mockRequest.mockResolvedValueOnce({ ok: true });
      mockRequest.mockResolvedValueOnce({ id: 'gw-job-003' });
      mockRequest.mockResolvedValueOnce({ ok: true });
      mockRequest.mockResolvedValueOnce({ presets: FIVE_PRESETS });

      const config = { reminder_window_hours: 72 };
      await useCronStore.getState().activatePreset('deadline_reminders_daily', config);

      expect(mockRequest).toHaveBeenNthCalledWith(1, 'rc.cron.presets.activate', {
        preset_id: 'deadline_reminders_daily',
        config,
      });
    });

    it('is a no-op when client is not connected', async () => {
      mockGatewayClient.isConnected = false;
      useCronStore.setState({ presets: FIVE_PRESETS, presetsLoaded: true });

      await useCronStore.getState().activatePreset('arxiv_daily_scan');

      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('reloads presets on error for consistency', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      useCronStore.setState({ presets: FIVE_PRESETS, presetsLoaded: true });

      mockRequest.mockRejectedValueOnce(new Error('activate failed'));
      // reload after error
      mockRequest.mockResolvedValueOnce({ presets: FIVE_PRESETS });

      await useCronStore.getState().activatePreset('arxiv_daily_scan');

      // Should have attempted activate (failed) then reload
      expect(mockRequest).toHaveBeenCalledTimes(2);
      expect(mockRequest).toHaveBeenNthCalledWith(2, 'rc.cron.presets.list', {});
      errorSpy.mockRestore();
    });
  });

  // ── deactivatePreset ───────────────────────────────────────────────────

  describe('deactivatePreset', () => {
    it('calls cron.remove with gateway_job_id, then deactivate, then reloads', async () => {
      const presetsWithJob = FIVE_PRESETS.map((p) =>
        p.id === 'deadline_reminders_daily'
          ? { ...p, gateway_job_id: 'gw-job-active' }
          : p,
      );
      useCronStore.setState({ presets: presetsWithJob, presetsLoaded: true });

      mockRequest.mockResolvedValueOnce({}); // cron.remove
      mockRequest.mockResolvedValueOnce({ ok: true }); // deactivate
      mockRequest.mockResolvedValueOnce({ presets: FIVE_PRESETS }); // reload

      await useCronStore.getState().deactivatePreset('deadline_reminders_daily');

      expect(mockRequest).toHaveBeenNthCalledWith(1, 'cron.remove', {
        id: 'gw-job-active',
      });
      expect(mockRequest).toHaveBeenNthCalledWith(2, 'rc.cron.presets.deactivate', {
        preset_id: 'deadline_reminders_daily',
      });
      expect(mockRequest).toHaveBeenNthCalledWith(3, 'rc.cron.presets.list', {});
    });

    it('skips cron.remove when preset has no gateway_job_id', async () => {
      useCronStore.setState({ presets: FIVE_PRESETS, presetsLoaded: true });

      mockRequest.mockResolvedValueOnce({ ok: true }); // deactivate
      mockRequest.mockResolvedValueOnce({ presets: FIVE_PRESETS }); // reload

      await useCronStore.getState().deactivatePreset('arxiv_daily_scan');

      expect(mockRequest).toHaveBeenNthCalledWith(1, 'rc.cron.presets.deactivate', {
        preset_id: 'arxiv_daily_scan',
      });
    });

    it('continues to deactivate in DB even if cron.remove fails', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const presetsWithJob = FIVE_PRESETS.map((p) =>
        p.id === 'arxiv_daily_scan'
          ? { ...p, gateway_job_id: 'gw-stale' }
          : p,
      );
      useCronStore.setState({ presets: presetsWithJob, presetsLoaded: true });

      mockRequest.mockRejectedValueOnce(new Error('job not found')); // cron.remove fails
      mockRequest.mockResolvedValueOnce({ ok: true }); // deactivate succeeds
      mockRequest.mockResolvedValueOnce({ presets: FIVE_PRESETS }); // reload

      await useCronStore.getState().deactivatePreset('arxiv_daily_scan');

      expect(mockRequest).toHaveBeenNthCalledWith(2, 'rc.cron.presets.deactivate', {
        preset_id: 'arxiv_daily_scan',
      });
      warnSpy.mockRestore();
    });

    it('is a no-op when client is not connected', async () => {
      mockGatewayClient.isConnected = false;
      useCronStore.setState({ presets: FIVE_PRESETS, presetsLoaded: true });

      await useCronStore.getState().deactivatePreset('arxiv_daily_scan');

      expect(mockRequest).not.toHaveBeenCalled();
    });
  });

  // ── deletePreset (GAP-14) ──────────────────────────────────────────────

  describe('deletePreset (GAP-14)', () => {
    it('calls cron.remove + rc.cron.presets.delete + reload', async () => {
      const presetsWithJob = FIVE_PRESETS.map((p) =>
        p.id === 'arxiv_daily_scan'
          ? { ...p, enabled: true, gateway_job_id: 'gw-to-delete' }
          : p,
      );
      useCronStore.setState({ presets: presetsWithJob, presetsLoaded: true });

      mockRequest.mockResolvedValueOnce({}); // cron.remove
      mockRequest.mockResolvedValueOnce({ ok: true, deleted: 'arxiv_daily_scan', gateway_job_id: 'gw-to-delete' }); // rc.cron.presets.delete
      const remainingPresets = FIVE_PRESETS.filter((p) => p.id !== 'arxiv_daily_scan');
      mockRequest.mockResolvedValueOnce({ presets: remainingPresets }); // reload

      await useCronStore.getState().deletePreset('arxiv_daily_scan');

      expect(mockRequest).toHaveBeenNthCalledWith(1, 'cron.remove', { id: 'gw-to-delete' });
      expect(mockRequest).toHaveBeenNthCalledWith(2, 'rc.cron.presets.delete', {
        preset_id: 'arxiv_daily_scan',
      });
      expect(mockRequest).toHaveBeenNthCalledWith(3, 'rc.cron.presets.list', {});

      // After reload, preset count should reflect deletion
      expect(useCronStore.getState().presets).toHaveLength(4);
    });

    it('skips cron.remove when preset has no gateway_job_id', async () => {
      useCronStore.setState({ presets: FIVE_PRESETS, presetsLoaded: true });

      mockRequest.mockResolvedValueOnce({ ok: true, deleted: 'arxiv_daily_scan', gateway_job_id: null }); // delete
      const remainingPresets = FIVE_PRESETS.filter((p) => p.id !== 'arxiv_daily_scan');
      mockRequest.mockResolvedValueOnce({ presets: remainingPresets }); // reload

      await useCronStore.getState().deletePreset('arxiv_daily_scan');

      // First call should be delete (no cron.remove)
      expect(mockRequest).toHaveBeenNthCalledWith(1, 'rc.cron.presets.delete', {
        preset_id: 'arxiv_daily_scan',
      });
    });

    it('continues with delete even if cron.remove fails', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const presetsWithJob = FIVE_PRESETS.map((p) =>
        p.id === 'weekly_report'
          ? { ...p, gateway_job_id: 'gw-stale' }
          : p,
      );
      useCronStore.setState({ presets: presetsWithJob, presetsLoaded: true });

      mockRequest.mockRejectedValueOnce(new Error('job not found')); // cron.remove fails
      mockRequest.mockResolvedValueOnce({ ok: true, deleted: 'weekly_report', gateway_job_id: 'gw-stale' }); // delete succeeds
      const remaining = FIVE_PRESETS.filter((p) => p.id !== 'weekly_report');
      mockRequest.mockResolvedValueOnce({ presets: remaining }); // reload

      await useCronStore.getState().deletePreset('weekly_report');

      // Should still call delete after cron.remove failure
      expect(mockRequest).toHaveBeenNthCalledWith(2, 'rc.cron.presets.delete', {
        preset_id: 'weekly_report',
      });
      warnSpy.mockRestore();
    });

    it('reloads presets on delete error for consistency', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      useCronStore.setState({ presets: FIVE_PRESETS, presetsLoaded: true });

      mockRequest.mockRejectedValueOnce(new Error('delete failed')); // rc.cron.presets.delete fails
      mockRequest.mockResolvedValueOnce({ presets: FIVE_PRESETS }); // reload

      await useCronStore.getState().deletePreset('arxiv_daily_scan');

      expect(mockRequest).toHaveBeenCalledTimes(2);
      expect(mockRequest).toHaveBeenNthCalledWith(2, 'rc.cron.presets.list', {});
      errorSpy.mockRestore();
    });

    it('is a no-op when client is not connected', async () => {
      mockGatewayClient.isConnected = false;
      useCronStore.setState({ presets: FIVE_PRESETS, presetsLoaded: true });

      await useCronStore.getState().deletePreset('arxiv_daily_scan');

      expect(mockRequest).not.toHaveBeenCalled();
    });
  });
});
