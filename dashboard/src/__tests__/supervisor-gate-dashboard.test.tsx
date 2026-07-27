/**
 * C13 (Dashboard half) — the deep-review gate is an operator-visible setting.
 *
 * The plugin already defaults to 4s, persists `toolReviewGateMs` and reports it over
 * RPC. If the Dashboard cannot show or change it, the trade-off it encodes — a
 * high-risk tool call stalls for N seconds, and on timeout the deep review is
 * skipped and the call proceeds — stays invisible to the person paying for it, and
 * anyone on a slow or local reviewer model has no way out but hand-editing
 * openclaw.json.
 *
 * The gate value must therefore survive the whole loop: form → buildSaveConfig →
 * gateway → reload. A control that renders but never reaches the saved config is
 * the same defect class this rebuild exists to remove.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React from 'react';

// --- Mock antd App.useApp (save goes through modal.confirm) ---
const mockModalConfirm = vi.fn();
vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  const MockApp = Object.assign(
    (props: Record<string, unknown>) => (actual.App as unknown as (p: unknown) => unknown)(props),
    {
      ...actual.App,
      useApp: () => ({
        modal: { confirm: (...args: unknown[]) => mockModalConfirm(...args), success: vi.fn() },
        message: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
        notification: {},
      }),
    },
  );
  return { ...actual, App: MockApp };
});

// --- Mock i18n: keys pass through, and `seconds` is echoed so the test can prove
//     the UI renders the *seconds* the operator chose, not raw milliseconds. ---
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown> | string) => {
      if (opts && typeof opts === 'object' && 'seconds' in opts) return `${key}:${String(opts.seconds)}`;
      if (opts && typeof opts === 'object' && 'reason' in opts) return `${key}:${String(opts.reason)}`;
      return key;
    },
    i18n: { changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import SettingsPanel, { SUPERVISOR_GATE_DEFAULT_MS, SUPERVISOR_GATE_PRESETS_MS } from '../components/panels/SettingsPanel';
import { buildSaveConfig } from '../utils/config-patch';
import { useGatewayStore } from '../stores/gateway';
import { useConfigStore } from '../stores/config';
import { useSupervisorStore } from '../stores/supervisor';
import { useUiStore } from '../stores/ui';

// ── Fixtures ──────────────────────────────────────────────────────────────

function minimalGatewayConfig() {
  return {
    agents: { defaults: { model: { primary: 'custom/test-model' }, imageModel: { primary: 'custom/test-model' } } },
    models: {
      providers: {
        custom: {
          baseUrl: 'https://api.example.com/v1',
          api: 'openai-completions',
          models: [{ id: 'test-model', name: 'test-model' }],
        },
      },
    },
  };
}

/** Supervision ON, inheriting the main model — the shipping default path. */
function supervisorConfigStub(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    supervisorModel: '',
    reviewMode: 'correct' as const,
    courseCorrection: { enabled: true, deviationThreshold: 0.5, forceRegenerate: false, maxRegenerateAttempts: 3 },
    highRiskTools: ['exec', 'write'],
    ...overrides,
  };
}

function supervisorStatusStub(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    reviewMode: 'correct',
    supervisorModel: '',
    modelSource: 'inherited',
    effectiveSupervisorModel: 'custom/test-model',
    reviewerReady: true,
    highRiskTools: ['exec', 'write'],
    toolReviewGateMs: 4000,
    courseCorrectionEnabled: true,
    deviationThreshold: 0.5,
    forceRegenerate: false,
    maxRegenerateAttempts: 3,
    stats: { total: 0, blocked: 0, corrected: 0, warnings: 0 },
    activeSessions: 0,
    sessionsInfo: [],
    ...overrides,
  };
}

function createMockRequest(supervisorCfg: Record<string, unknown>, supervisorStatus: Record<string, unknown>) {
  return vi.fn().mockImplementation((method: string) => {
    if (method === 'rc.supervisor.config') return Promise.resolve({ ok: true, config: supervisorCfg });
    if (method === 'rc.supervisor.status') return Promise.resolve(supervisorStatus);
    if (method === 'rc.supervisor.log') return Promise.resolve({ entries: [], total: 0 });
    if (method === 'rc.app.check_updates') return Promise.resolve({ upToDate: true, current: '0.0.0', latest: '0.0.0' });
    if (method === 'rc.auth.statuses') return Promise.resolve({ custom: { configured: false } });
    if (method === 'config.get') return Promise.resolve({ config: minimalGatewayConfig(), hash: 'abc123' });
    if (method === 'rc.provider.validate') return Promise.resolve({ ok: true });
    if (method === 'rc.provider.upsert') return Promise.resolve({ ok: true });
    if (method === 'config.apply') return Promise.resolve({});
    return Promise.resolve({});
  });
}

function mountSettings(mockRequest: ReturnType<typeof vi.fn>) {
  useGatewayStore.setState({
    client: { isConnected: true, request: mockRequest, connect: vi.fn(), disconnect: vi.fn() } as unknown as ReturnType<
      typeof useGatewayStore.getState
    >['client'],
    state: 'connected',
    serverVersion: '0.7.5',
  });
  useConfigStore.setState({ gatewayConfig: minimalGatewayConfig(), gatewayConfigLoading: false });
  return render(<SettingsPanel />);
}

/** The gate lives in a collapsed "advanced" section — open it before asserting. */
async function openGateSection(): Promise<void> {
  await waitFor(() => expect(screen.getByText('settings.supervisorAdvancedBehavior')).toBeInTheDocument());
  fireEvent.click(screen.getByText('settings.supervisorAdvancedBehavior'));
  await waitFor(() =>
    expect(document.querySelector('input[type="radio"][value="4000"]')).not.toBeNull(),
  );
}

function gateRadio(ms: number): HTMLInputElement {
  const el = document.querySelector(`input[type="radio"][value="${ms}"]`);
  if (!el) throw new Error(`gate radio ${ms}ms not rendered`);
  return el as HTMLInputElement;
}

function getSaveButton(): HTMLElement {
  const buttons = screen.getAllByRole('button', { name: /settings\.save|setup\.gatewayRestarting/i });
  return buttons.find((b) => b.parentElement?.textContent?.includes('settings.restartHint')) ?? buttons[0];
}

beforeEach(() => {
  mockModalConfirm.mockReset();
  localStorage.clear();
  sessionStorage.clear();
  useGatewayStore.setState({ client: null, state: 'disconnected', serverVersion: null, connId: null });
  useConfigStore.setState({
    theme: 'dark',
    locale: 'en',
    gatewayConfig: null,
    gatewayConfigLoading: false,
    bootState: 'ready',
    pendingConfigRestart: false,
  });
  useUiStore.setState({ notifications: [], unreadCount: 0 });
  useSupervisorStore.getState().stopPolling();
  useSupervisorStore.setState({ status: null, config: null, auditLog: [], auditLogTotal: 0, pollingTimer: null });
});

afterEach(() => {
  useSupervisorStore.getState().stopPolling();
  cleanup();
  vi.restoreAllMocks();
});

// ── buildSaveConfig: the value must reach the plugin entry ────────────────

describe('C13 buildSaveConfig carries the gate into the supervisor plugin config', () => {
  it('writes the chosen gate to plugins.entries[dual-model-supervisor].config', () => {
    const saved = buildSaveConfig(minimalGatewayConfig() as Record<string, unknown>, {
      provider: 'custom',
      baseUrl: 'https://api.example.com/v1',
      api: 'openai-completions',
      apiKey: 'k',
      textModel: 'test-model',
      supervisorEnabled: true,
      supervisorModel: '',
      supervisorReviewMode: 'correct',
      supervisorToolReviewGateMs: 2000,
    }) as { plugins: { entries: Record<string, { config: Record<string, unknown> }> } };

    expect(saved.plugins.entries['dual-model-supervisor'].config.toolReviewGateMs).toBe(2000);
  });

  it('leaves an already-persisted gate alone when the form does not send one', () => {
    // An unrelated save (proxy, vision, …) must not silently reset a deliberately
    // widened gate back to the 4s default.
    const current = {
      ...minimalGatewayConfig(),
      plugins: { entries: { 'dual-model-supervisor': { enabled: true, config: { enabled: true, toolReviewGateMs: 12000 } } } },
    };
    const saved = buildSaveConfig(current as Record<string, unknown>, {
      provider: 'custom',
      baseUrl: 'https://api.example.com/v1',
      api: 'openai-completions',
      apiKey: 'k',
      textModel: 'test-model',
      supervisorEnabled: true,
      supervisorModel: '',
      supervisorReviewMode: 'correct',
    }) as { plugins: { entries: Record<string, { config: Record<string, unknown> }> } };

    expect(saved.plugins.entries['dual-model-supervisor'].config.toolReviewGateMs).toBe(12000);
  });
});

// ── SettingsPanel: show it, change it, save it, read it back ──────────────

describe('C13 the Settings panel exposes the gate in seconds', () => {
  it('shows the 4s default preselected while inheriting the main model', async () => {
    const mockRequest = createMockRequest(supervisorConfigStub(), supervisorStatusStub());
    mountSettings(mockRequest);

    await openGateSection();

    // Inherit mode has no separate reviewer provider — the gate must still be
    // reachable there, because that is the default path since C12.
    expect(gateRadio(4000).checked).toBe(true);
    // Rendered as seconds, never as a raw millisecond input.
    expect(screen.getByText('settings.supervisorToolReviewGateHint:4')).toBeInTheDocument();
  });

  it('changing only the gate dirties the form and saves 2000ms to the gateway', async () => {
    const mockRequest = createMockRequest(supervisorConfigStub(), supervisorStatusStub());
    mountSettings(mockRequest);

    await openGateSection();
    expect(getSaveButton()).toBeDisabled(); // baseline: nothing edited yet

    fireEvent.click(gateRadio(2000));

    await waitFor(() => expect(getSaveButton()).toBeEnabled());
    fireEvent.click(getSaveButton());

    await waitFor(() => expect(mockModalConfirm).toHaveBeenCalledTimes(1));
    const confirm = mockModalConfirm.mock.calls[0][0] as { onOk: () => Promise<void> };
    await confirm.onOk();

    const upsert = mockRequest.mock.calls.find((c) => c[0] === 'rc.provider.upsert');
    expect(upsert, 'rc.provider.upsert was never called').toBeTruthy();
    const desired = (upsert![1] as { desiredConfig: { plugins: { entries: Record<string, { config: Record<string, unknown> }> } } }).desiredConfig;
    expect(desired.plugins.entries['dual-model-supervisor'].config.toolReviewGateMs).toBe(2000);
  });

  it('keeps a hand-set non-preset gate instead of snapping it to a preset', async () => {
    // 12000 is not one of the three buttons. The operator reached it by editing
    // openclaw.json; an unrelated save must not quietly round it to 10s — that
    // would be the settings-page version of a silent no-op.
    const mockRequest = createMockRequest(
      supervisorConfigStub({ toolReviewGateMs: 12000 }),
      supervisorStatusStub({ toolReviewGateMs: 12000 }),
    );
    mountSettings(mockRequest);

    await openGateSection();

    expect(gateRadio(2000).checked).toBe(false);
    expect(gateRadio(4000).checked).toBe(false);
    expect(gateRadio(10000).checked).toBe(false);
    // The value is still the one in force, and it is stated in seconds.
    expect(screen.getByText('settings.supervisorToolReviewGateHint:12')).toBeInTheDocument();

    // …and an unrelated edit saves it back unchanged.
    fireEvent.change(screen.getByDisplayValue('test-model'), { target: { value: 'other-model' } });
    await waitFor(() => expect(getSaveButton()).toBeEnabled());
    fireEvent.click(getSaveButton());
    await waitFor(() => expect(mockModalConfirm).toHaveBeenCalledTimes(1));
    await (mockModalConfirm.mock.calls[0][0] as { onOk: () => Promise<void> }).onOk();

    const upsert = mockRequest.mock.calls.find((c) => c[0] === 'rc.provider.upsert');
    expect(upsert, 'rc.provider.upsert was never called').toBeTruthy();
    const desired = (upsert![1] as { desiredConfig: { plugins: { entries: Record<string, { config: Record<string, unknown> }> } } }).desiredConfig;
    expect(desired.plugins.entries['dual-model-supervisor'].config.toolReviewGateMs).toBe(12000);
  });

  it('preselects a 10s gate loaded from the gateway (reload round-trip)', async () => {
    const mockRequest = createMockRequest(
      supervisorConfigStub({ toolReviewGateMs: 10000 }),
      supervisorStatusStub({ toolReviewGateMs: 10000 }),
    );
    mountSettings(mockRequest);

    await openGateSection();

    expect(gateRadio(10000).checked).toBe(true);
    expect(gateRadio(4000).checked).toBe(false);
    expect(screen.getByText('settings.supervisorToolReviewGateHint:10')).toBeInTheDocument();
  });
});

// ── The Dashboard default must be the plugin's default, not a lookalike ───

describe('C13 the gate default is pinned to the plugin manifest', () => {
  it('SUPERVISOR_GATE_DEFAULT_MS equals the manifest default and sits inside its range', () => {
    // SettingsPanel.tsx documents this constant as "must match the plugin manifest".
    // Reading the manifest here is what makes that comment true: if the two drift,
    // the Dashboard would preselect a value the operator never gets.
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), '../extensions/dual-model-supervisor/openclaw.plugin.json'), 'utf-8'),
    ) as { configSchema: { properties: Record<string, { default?: number; minimum?: number; maximum?: number }> } };
    const gate = manifest.configSchema.properties.toolReviewGateMs;

    expect(gate, 'the manifest no longer declares toolReviewGateMs').toBeDefined();
    expect(SUPERVISOR_GATE_DEFAULT_MS).toBe(gate.default);
    for (const preset of SUPERVISOR_GATE_PRESETS_MS) {
      expect(preset).toBeGreaterThanOrEqual(gate.minimum!);
      expect(preset).toBeLessThanOrEqual(gate.maximum!);
    }
    expect(SUPERVISOR_GATE_PRESETS_MS).toContain(SUPERVISOR_GATE_DEFAULT_MS);
  });
});

// ── SettingsPanel: an unusable reviewer must be stated, not implied ───────

describe('C13/C12 the Settings panel states what inheriting costs and when deep review is down', () => {
  it('names the extra model-call cost of inheriting the main model', async () => {
    const mockRequest = createMockRequest(supervisorConfigStub(), supervisorStatusStub());
    mountSettings(mockRequest);

    await waitFor(() => expect(screen.getByText('settings.supervisorInheritMain')).toBeInTheDocument());
    expect(screen.getByText('settings.supervisorInheritMainHint')).toBeInTheDocument();
  });

  it('surfaces the reviewer-unavailable reason instead of looking healthy', async () => {
    const mockRequest = createMockRequest(
      supervisorConfigStub(),
      supervisorStatusStub({
        reviewerReady: false,
        modelSource: 'unavailable',
        effectiveSupervisorModel: '',
        reviewerUnavailableReason: 'unsupported protocol: models.providers.custom.api=weird-api',
      }),
    );
    mountSettings(mockRequest);

    await waitFor(() =>
      expect(
        screen.getByText('settings.supervisorReviewerUnavailable:unsupported protocol: models.providers.custom.api=weird-api'),
      ).toBeInTheDocument(),
    );
  });
});
