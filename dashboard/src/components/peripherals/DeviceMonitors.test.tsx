/**
 * DeviceMonitors component tests — T16
 *
 * Tests:
 *   - Filtering: only monitors with source_type==='device' && target===deviceId are shown
 *   - Create payload: rc.monitor.create called with correct fields
 *   - Schedule chips: selecting a chip sets the effective schedule
 *   - "Let agent configure" chip: prefills chat input with deviceId
 *   - Empty state: shown when no matching monitors exist
 *   - Disabled badge: shown when monitor is disabled
 *
 * Fixture notes:
 *   Monitor shape: stores/monitor.ts (Monitor interface)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import React from 'react';
import { useConfigStore } from '../../stores/config';
import { useMonitorStore } from '../../stores/monitor';
import { usePeripheralsStore } from '../../stores/peripherals';
import { useUiStore } from '../../stores/ui';
import type { Monitor } from '../../stores/monitor';

// ── i18n mock ─────────────────────────────────────────────────────────────────
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, optsOrFallback?: string | Record<string, unknown>) => {
      if (typeof optsOrFallback === 'string') return optsOrFallback;
      if (optsOrFallback && 'defaultValue' in optsOrFallback) return String(optsOrFallback.defaultValue);
      return key;
    },
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

// ── Gateway mock ─────────────────────────────────────────────────────────────
const mockRequest = vi.fn();
vi.mock('../../stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({ client: { isConnected: true, request: mockRequest } }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}));

// ObservationTimeline is no longer rendered inside DeviceMonitors (Fix 3, T16).
// No mock needed here.

import DeviceMonitors from './DeviceMonitors';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMonitor(overrides: Partial<Monitor>): Monitor {
  return {
    id: 'mon-1',
    name: 'Lab Check',
    source_type: 'device',
    target: 'dev-cam-001',
    filters: { check_prompt: 'Is the bench clear?' },
    schedule: '*/30 * * * *',
    enabled: true,
    notify: false,
    agent_prompt: '你是外设定时查证代理。目标设备 ID: dev-cam-001。',
    gateway_job_id: 'gw-job-001',
    last_check_at: null,
    last_results: null,
    last_error: null,
    check_count: 3,
    finding_count: 0,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

const DEVICE_MONITOR = makeMonitor({});
const OTHER_DEVICE_MONITOR = makeMonitor({ id: 'mon-2', target: 'dev-cam-999', name: 'Other device' });
const FEED_MONITOR = makeMonitor({ id: 'mon-3', source_type: 'feed', target: '', name: 'RSS Feed' });
const DISABLED_MONITOR = makeMonitor({ id: 'mon-4', name: 'Disabled Check', enabled: false, gateway_job_id: null });

function renderComponent(props?: Partial<React.ComponentProps<typeof DeviceMonitors>>) {
  return render(
    <ConfigProvider>
      <AntdApp>
        <DeviceMonitors
          deviceId="dev-cam-001"
          checkPrompt="Is the bench clear?"
          {...props}
        />
      </AntdApp>
    </ConfigProvider>,
  );
}

function mockSuccessfulCreateFlow(createdMonitor: Monitor) {
  mockRequest.mockImplementation(async (method: string) => {
    switch (method) {
      case 'rc.monitor.create': return createdMonitor;
      case 'rc.monitor.toggle': return { ...createdMonitor, enabled: true };
      case 'cron.add': return { id: 'gw-job-created' };
      case 'rc.monitor.setJobId': return { ok: true };
      case 'rc.monitor.list':
        return {
          items: [{ ...createdMonitor, enabled: true, gateway_job_id: 'gw-job-created' }],
          total: 1,
        };
      case 'cron.list':
        return { jobs: [], total: 0, offset: 0, limit: 50, hasMore: false, nextOffset: null };
      default: return null;
    }
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('DeviceMonitors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMonitorStore.setState({ monitors: [], loading: false, loaded: true });
    usePeripheralsStore.setState({ devices: [], observations: {}, loading: false, error: null, unavailable: false });
    useUiStore.setState({ chatInputPrefill: null });
    useConfigStore.setState({ gatewayConfig: null });
  });

  // ── Filtering ──────────────────────────────────────────────────────────────

  describe('monitor list filtering', () => {
    it('shows monitors where source_type===device && target===deviceId', () => {
      useMonitorStore.setState({
        monitors: [DEVICE_MONITOR, OTHER_DEVICE_MONITOR, FEED_MONITOR],
      });
      renderComponent();

      expect(screen.getByTestId('periph-monitor-row-mon-1')).toBeDefined();
      expect(screen.queryByTestId('periph-monitor-row-mon-2')).toBeNull(); // other device
      expect(screen.queryByTestId('periph-monitor-row-mon-3')).toBeNull(); // feed
    });

    it.each(['\tDEVICE\n', '\u00a0DeViCe\u00a0'])(
      'includes a legacy device monitor with source_type %j',
      (sourceType) => {
        useMonitorStore.setState({
          monitors: [makeMonitor({
            id: 'legacy-device-monitor',
            source_type: sourceType,
            target: 'dev-cam-001',
            name: 'Legacy camera check',
          })],
        });

        renderComponent();

        expect(screen.getByText('Legacy camera check')).toBeDefined();
      },
    );

    it('shows empty state when no device monitors exist', () => {
      useMonitorStore.setState({ monitors: [FEED_MONITOR] });
      renderComponent();
      expect(screen.getByTestId('periph-monitors-empty')).toBeDefined();
    });

    it('shows disabled badge for disabled monitors', () => {
      useMonitorStore.setState({ monitors: [DISABLED_MONITOR] });
      renderComponent({ deviceId: 'dev-cam-001' });
      const row = screen.getByTestId('periph-monitor-row-mon-4');
      expect(row.textContent).toMatch(/disabledBadge|disabled/);
    });
  });

  // ObservationTimeline is now rendered by CameraDetail, not DeviceMonitors (Fix 3, T16).
  // Its placement is tested in CameraDetail.test.tsx.

  // ── Create form ────────────────────────────────────────────────────────────

  describe('create form', () => {
    it('shows form when "New Check" button is clicked', () => {
      renderComponent();
      expect(screen.queryByTestId('periph-monitors-form')).toBeNull();
      fireEvent.click(screen.getByTestId('periph-monitors-create-btn'));
      expect(screen.getByTestId('periph-monitors-form')).toBeDefined();
    });

    it('sends correct rc.monitor.create payload on submit', async () => {
      const createdMonitor = makeMonitor({ id: 'mon-new', name: 'New Lab Check', enabled: false });
      mockSuccessfulCreateFlow(createdMonitor);

      renderComponent();
      fireEvent.click(screen.getByTestId('periph-monitors-create-btn'));

      // Fill name
      fireEvent.change(screen.getByTestId('periph-monitors-form-name'), {
        target: { value: 'New Lab Check' },
      });

      // Submit with default schedule
      fireEvent.click(screen.getByTestId('periph-monitors-form-submit'));

      await waitFor(() => {
        expect(mockRequest).toHaveBeenCalledWith('rc.monitor.create', expect.objectContaining({
          name: 'New Lab Check',
          source_type: 'device',
          target: 'dev-cam-001',
          enabled: false,
          // agent_prompt empty → plugin generates defaultAgentPrompt
          agent_prompt: '',
        }));
      });
    });

    it('payload includes filters.check_prompt when custom prompt is set', async () => {
      const createdMonitor = makeMonitor({ id: 'mon-new', name: 'Prompt Test', enabled: false });
      mockSuccessfulCreateFlow(createdMonitor);

      renderComponent({ checkPrompt: 'Initial prompt' });
      fireEvent.click(screen.getByTestId('periph-monitors-create-btn'));

      // Change name
      fireEvent.change(screen.getByTestId('periph-monitors-form-name'), {
        target: { value: 'Prompt Test' },
      });
      // Change prompt
      fireEvent.change(screen.getByTestId('periph-monitors-form-prompt'), {
        target: { value: 'Custom check: verify all equipment' },
      });

      fireEvent.click(screen.getByTestId('periph-monitors-form-submit'));

      await waitFor(() => {
        expect(mockRequest).toHaveBeenCalledWith('rc.monitor.create', expect.objectContaining({
          filters: { check_prompt: 'Custom check: verify all equipment' },
        }));
      });
    });

    it('payload includes empty filters when prompt is blank', async () => {
      const createdMonitor = makeMonitor({ id: 'mon-new', name: 'No Prompt', enabled: false });
      mockSuccessfulCreateFlow(createdMonitor);

      renderComponent({ checkPrompt: '' });
      fireEvent.click(screen.getByTestId('periph-monitors-create-btn'));

      fireEvent.change(screen.getByTestId('periph-monitors-form-name'), {
        target: { value: 'No Prompt' },
      });

      fireEvent.click(screen.getByTestId('periph-monitors-form-submit'));

      await waitFor(() => {
        expect(mockRequest).toHaveBeenCalledWith('rc.monitor.create', expect.objectContaining({
          filters: {},
        }));
      });
    });

    it('uses selected schedule chip expression in payload', async () => {
      const createdMonitor = makeMonitor({ id: 'mon-new', name: 'Hourly', enabled: false, schedule: '0 * * * *' });
      mockSuccessfulCreateFlow(createdMonitor);

      renderComponent();
      fireEvent.click(screen.getByTestId('periph-monitors-create-btn'));

      // Click "Hourly" chip
      fireEvent.click(screen.getByTestId('periph-monitors-chip-0 * * * *'));

      fireEvent.change(screen.getByTestId('periph-monitors-form-name'), {
        target: { value: 'Hourly' },
      });

      fireEvent.click(screen.getByTestId('periph-monitors-form-submit'));

      await waitFor(() => {
        expect(mockRequest).toHaveBeenCalledWith('rc.monitor.create', expect.objectContaining({
          schedule: '0 * * * *',
        }));
      });
    });

    it('uses custom cron expression when custom chip is selected', async () => {
      const createdMonitor = makeMonitor({ id: 'mon-new', name: 'Custom', enabled: false, schedule: '*/15 * * * *' });
      mockSuccessfulCreateFlow(createdMonitor);

      renderComponent();
      fireEvent.click(screen.getByTestId('periph-monitors-create-btn'));

      // Click "Custom cron" chip
      fireEvent.click(screen.getByTestId('periph-monitors-chip-custom'));
      // Enter custom cron
      fireEvent.change(screen.getByTestId('periph-monitors-custom-cron'), {
        target: { value: '*/15 * * * *' },
      });

      fireEvent.change(screen.getByTestId('periph-monitors-form-name'), {
        target: { value: 'Custom' },
      });

      fireEvent.click(screen.getByTestId('periph-monitors-form-submit'));

      await waitFor(() => {
        expect(mockRequest).toHaveBeenCalledWith('rc.monitor.create', expect.objectContaining({
          schedule: '*/15 * * * *',
        }));
      });
    });

    it('does not submit when name is empty', async () => {
      renderComponent();
      fireEvent.click(screen.getByTestId('periph-monitors-create-btn'));
      fireEvent.click(screen.getByTestId('periph-monitors-form-submit'));

      await new Promise((r) => setTimeout(r, 50));
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('cancel hides the form', () => {
      renderComponent();
      fireEvent.click(screen.getByTestId('periph-monitors-create-btn'));
      expect(screen.getByTestId('periph-monitors-form')).toBeDefined();

      fireEvent.click(screen.getByTestId('periph-monitors-form-cancel'));
      expect(screen.queryByTestId('periph-monitors-form')).toBeNull();
    });
  });

  // ── P1-U2: create immediately enables via the toggle path ─────────────────

  describe('create-then-enable (P1-U2)', () => {
    it('enables the created monitor right away and registers its cron job', async () => {
      const createdMonitor = makeMonitor({
        id: 'mon-new', name: 'Auto Enabled', enabled: false, gateway_job_id: null,
      });
      const calls: string[] = [];
      mockRequest.mockImplementation(async (method: string) => {
        calls.push(method);
        switch (method) {
          case 'rc.monitor.create': return createdMonitor;
          case 'rc.monitor.toggle': return { ...createdMonitor, enabled: true };
          case 'cron.add': return { id: 'gw-job-new-001' };
          case 'rc.monitor.setJobId': return { ok: true };
          case 'rc.monitor.list':
            return { items: [{ ...createdMonitor, enabled: true, gateway_job_id: 'gw-job-new-001' }], total: 1 };
          case 'cron.list':
            return { jobs: [], total: 0, offset: 0, limit: 50, hasMore: false, nextOffset: null, deliveryPreviews: {} };
          default: return null;
        }
      });

      renderComponent();
      fireEvent.click(screen.getByTestId('periph-monitors-create-btn'));
      fireEvent.change(screen.getByTestId('periph-monitors-form-name'), {
        target: { value: 'Auto Enabled' },
      });
      fireEvent.click(screen.getByTestId('periph-monitors-form-submit'));

      await waitFor(() => {
        expect(mockRequest).toHaveBeenCalledWith('rc.monitor.toggle', { id: 'mon-new', enabled: true });
      });
      // Toggle path registers the cron immediately (dashboard is online at create time)
      await waitFor(() => {
        expect(calls).toContain('cron.add');
      });
    });

    it('shows an explicit error when cron registration returns no job id', async () => {
      const createdMonitor = makeMonitor({
        id: 'mon-no-job', name: 'No Job', enabled: false, gateway_job_id: null,
      });
      mockRequest.mockImplementation(async (method: string) => {
        switch (method) {
          case 'rc.monitor.create': return createdMonitor;
          case 'rc.monitor.toggle': return { ...createdMonitor, enabled: true };
          case 'cron.add': return {};
          case 'rc.monitor.list':
            return { items: [{ ...createdMonitor, enabled: true, gateway_job_id: null }], total: 1 };
          case 'cron.list': return {};
          default: return null;
        }
      });

      renderComponent();
      fireEvent.click(screen.getByTestId('periph-monitors-create-btn'));
      fireEvent.change(screen.getByTestId('periph-monitors-form-name'), {
        target: { value: 'No Job' },
      });
      fireEvent.click(screen.getByTestId('periph-monitors-form-submit'));

      await waitFor(() => {
        expect(screen.getByTestId('periph-monitors-create-error').textContent).toContain(
          'cron registration failed',
        );
      });
      expect(screen.queryByText(/Created and enabled/)).toBeNull();
    });
  });

  // ── Create form notices (F2b + P1-N1/D9) ──────────────────────────────────

  describe('create form notices', () => {
    it('always shows the presence-prerequisite info bar (P1-N1/D9)', () => {
      renderComponent();
      fireEvent.click(screen.getByTestId('periph-monitors-create-btn'));
      expect(screen.getByTestId('periph-monitors-presence-note')).toBeDefined();
    });

    it('warns when agents.defaults.imageModel is missing without blocking the form (F2b)', () => {
      // gatewayConfig null (beforeEach) → imageModel unresolvable → warn
      renderComponent();
      fireEvent.click(screen.getByTestId('periph-monitors-create-btn'));
      expect(screen.getByTestId('periph-monitors-imagemodel-warning')).toBeDefined();
      // Not blocking: submit button still present
      expect(screen.getByTestId('periph-monitors-form-submit')).toBeDefined();
    });

    it('hides the imageModel warning when agents.defaults.imageModel is configured', () => {
      useConfigStore.setState({
        gatewayConfig: { agents: { defaults: { imageModel: { primary: 'zai/glm-4.6v' } } } },
      });
      renderComponent();
      fireEvent.click(screen.getByTestId('periph-monitors-create-btn'));
      expect(screen.queryByTestId('periph-monitors-imagemodel-warning')).toBeNull();
    });
  });

  // ── "Ask agent" chip ──────────────────────────────────────────────────────

  describe('"Let agent configure" chip', () => {
    it('sets chatInputPrefill with deviceId when clicked', () => {
      renderComponent({ deviceId: 'dev-cam-001', checkPrompt: '' });
      fireEvent.click(screen.getByTestId('periph-monitors-create-btn'));
      fireEvent.click(screen.getByTestId('periph-monitors-ask-agent'));

      const prefill = useUiStore.getState().chatInputPrefill;
      expect(prefill).toContain('dev-cam-001');
    });

    // §14.4 / P1-C1: with a deviceName the prefill addresses the device by
    // NAME + (id) so the chat text disambiguates and never leaks a bare UUID.
    it('prefills with "name (id)" when deviceName is provided', () => {
      renderComponent({ deviceId: 'dev-cam-001', deviceName: 'FaceTime HD Camera', checkPrompt: '' });
      fireEvent.click(screen.getByTestId('periph-monitors-create-btn'));
      fireEvent.click(screen.getByTestId('periph-monitors-ask-agent'));

      const prefill = useUiStore.getState().chatInputPrefill ?? '';
      expect(prefill).toContain('FaceTime HD Camera (dev-cam-001)');
    });
  });

  // ── Row actions ────────────────────────────────────────────────────────────

  describe('monitor row actions', () => {
    it('toggle switch calls toggleMonitor with correct id and state', async () => {
      useMonitorStore.setState({ monitors: [DEVICE_MONITOR] });
      // toggleMonitor calls loadMonitors at the end — stub full chain
      mockRequest
        .mockResolvedValueOnce({ ...DEVICE_MONITOR, enabled: false }) // rc.monitor.toggle
        .mockResolvedValueOnce({ items: [{ ...DEVICE_MONITOR, enabled: false }], total: 1 }) // rc.monitor.list
        .mockResolvedValueOnce(null); // cron.list

      renderComponent();
      const toggle = screen.getByTestId('periph-monitor-toggle-mon-1');
      // The switch is checked=true; click it to toggle off
      fireEvent.click(toggle.querySelector('button') ?? toggle);

      await waitFor(() => {
        expect(mockRequest).toHaveBeenCalledWith('rc.monitor.toggle', { id: 'mon-1', enabled: false });
      });
    });

    it('run-now button is disabled when monitor is disabled', () => {
      useMonitorStore.setState({ monitors: [DISABLED_MONITOR] });
      renderComponent({ deviceId: 'dev-cam-001' });
      const runBtn = screen.getByTestId('periph-monitor-run-mon-4');
      expect(runBtn.hasAttribute('disabled')).toBe(true);
    });
  });
});
