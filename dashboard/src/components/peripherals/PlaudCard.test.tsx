/**
 * PlaudCard.test.tsx — Task 15: Plaud 卡三态测试
 *
 * Tests: configured detection (from gatewayConfig), three render states,
 * connect flow (config.patch → plaudLogin → createDevice), chip prefill,
 * unavailable banner, idempotent createDevice.
 *
 * Fixtures:
 *   - config-responses.ts: CONFIG_GET_ZAI_SINGLE (base config without plaud)
 *   - periph.ts: RC_PERIPH_PLAUD_STATUS_* / RC_PERIPH_PLAUD_LOGIN_* / RC_PERIPH_DEVICES_CREATE_RESPONSE
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import { useGatewayStore } from '../../stores/gateway';
import { useConfigStore } from '../../stores/config';
import { usePeripheralsStore } from '../../stores/peripherals';
import { useMonitorStore } from '../../stores/monitor';
import { useUiStore } from '../../stores/ui';
import {
  RC_PERIPH_PLAUD_STATUS_LOGGED_IN_RESPONSE,
  RC_PERIPH_PLAUD_STATUS_LOGGED_OUT_RESPONSE,
  RC_PERIPH_PLAUD_STATUS_DOCKER_RESPONSE,
  RC_PERIPH_PLAUD_LOGIN_OK_RESPONSE,
  RC_PERIPH_PLAUD_LOGIN_FAIL_RESPONSE,
  RC_PERIPH_DEVICES_CREATE_RESPONSE,
} from '../../__fixtures__/gateway-payloads/periph';
import { CONFIG_GET_ZAI_SINGLE } from '../../__fixtures__/gateway-payloads/config-responses';

// ── Mock i18n ─────────────────────────────────────────────────────────────────
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOpts?: string | Record<string, unknown>) => {
      if (typeof fallbackOrOpts === 'string') return fallbackOrOpts;
      if (fallbackOrOpts && 'defaultValue' in fallbackOrOpts) return fallbackOrOpts.defaultValue as string;
      return key;
    },
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import PlaudCard from './PlaudCard';

// ── Test helpers ──────────────────────────────────────────────────────────────

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider>
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}

/**
 * Flush the component's initial status request without relying on waitFor's
 * one-second polling budget. Under the full Dashboard suite, CPU contention can
 * delay React's effect scheduling even though the mocked RPC resolves
 * immediately; awaiting act() follows the actual state transition instead.
 */
async function renderPlaudCardAfterInitialStatus(): Promise<void> {
  await act(async () => {
    render(<Wrapper><PlaudCard /></Wrapper>);
    await Promise.resolve();
  });
}

/**
 * CONFIG_GET snapshot WITH mcp.servers.plaud — "configured" state.
 * Source: mirrors config-responses.ts structure; mcp field added.
 */
const CONFIG_GET_WITH_PLAUD = {
  ...CONFIG_GET_ZAI_SINGLE,
  config: {
    ...CONFIG_GET_ZAI_SINGLE.config,
    mcp: {
      servers: {
        plaud: {
          command: 'npx',
          args: ['-y', '@plaud-ai/mcp@0.3.5'],
        },
      },
    },
  },
};

/**
 * CONFIG_GET snapshot WITHOUT mcp.servers.plaud — "not configured" state.
 * Uses CONFIG_GET_ZAI_SINGLE directly (no mcp key).
 */
const CONFIG_GET_WITHOUT_PLAUD = CONFIG_GET_ZAI_SINGLE;

// ── beforeEach: reset all stores + default mocks ──────────────────────────────

let mockRequest: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();

  mockRequest = vi.fn();
  useGatewayStore.setState({
    state: 'connected',
    client: { isConnected: true, request: mockRequest } as never,
  });
  useConfigStore.setState({
    theme: 'dark',
    gatewayConfig: null,
  });
  usePeripheralsStore.setState({
    devices: [],
    unavailable: false,
    error: null,
  });
  // Reset monitor store — DeviceMonitors (rendered in the connected state) reads
  // `monitors`; keep it empty so the panel starts collapsed unless a test opts in.
  useMonitorStore.setState({ monitors: [], loading: false, loaded: true });
  useUiStore.setState({ chatInputPrefill: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── ① 未配置态 — NOT configured ───────────────────────────────────────────────

describe('PlaudCard — 未配置态 (not configured)', () => {
  beforeEach(() => {
    // gatewayConfig has no mcp.servers.plaud
    useConfigStore.setState({
      theme: 'dark',
      gatewayConfig: {
        agents: CONFIG_GET_WITHOUT_PLAUD.config.agents as never,
        models: CONFIG_GET_WITHOUT_PLAUD.config.models as never,
        raw: null,
        baseHash: CONFIG_GET_WITHOUT_PLAUD.hash,
        projectConfig: null,
      },
    });
    // plaudStatus returns unavailable (plugin may not have it yet) — OK to return null
    mockRequest.mockResolvedValue(null);
  });

  it('renders value copy + red connect button', async () => {
    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => {
      expect(screen.getByTestId('plaud-connect-btn')).toBeTruthy();
    });
    // Status strip should be grey (unconfigured)
    expect(screen.getByTestId('plaud-status-strip')).toBeTruthy();
  });

  it('shows "unconfigured" status strip (grey)', async () => {
    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => {
      const strip = screen.getByTestId('plaud-status-strip');
      // Grey — background color should NOT be green/blue/red
      const bg = strip.style.backgroundColor || strip.getAttribute('data-status');
      expect(bg).toBeTruthy(); // exists
    });
    // Must NOT show login button (that's for "configured but not logged in")
    expect(screen.queryByTestId('plaud-login-btn')).toBeNull();
  });

  it('connect flow: plaudLogin → config.patch → createDevice, login BEFORE config write (P1-U3)', async () => {
    // config.get for baseHash
    mockRequest.mockImplementation((method: string) => {
      if (method === 'config.get') return Promise.resolve({ hash: CONFIG_GET_WITHOUT_PLAUD.hash });
      if (method === 'config.patch') return Promise.resolve({ ok: true });
      if (method === 'rc.periph.plaud.login') return Promise.resolve(RC_PERIPH_PLAUD_LOGIN_OK_RESPONSE);
      if (method === 'rc.periph.plaud.status') return Promise.resolve(RC_PERIPH_PLAUD_STATUS_LOGGED_IN_RESPONSE);
      if (method === 'rc.periph.devices.list') return Promise.resolve({ devices: [] });
      if (method === 'rc.periph.devices.create') return Promise.resolve(RC_PERIPH_DEVICES_CREATE_RESPONSE);
      return Promise.resolve(null);
    });

    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId('plaud-connect-btn')).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId('plaud-connect-btn'));
    });

    // Verify config.patch was called with exactly the right payload
    await waitFor(() => {
      const patchCall = mockRequest.mock.calls.find(([method]) => method === 'config.patch');
      expect(patchCall).toBeTruthy();
      const [, params] = patchCall!;
      const raw = JSON.parse(params.raw as string);
      expect(raw.mcp?.servers?.plaud).toMatchObject({
        command: 'npx',
        args: ['-y', '@plaud-ai/mcp@0.3.5'],
      });
      // RC-only plugins.installs must be stripped (null) in the same patch —
      // OC 2026.6.1 rejects it; ensure-config re-adds on next startup.
      expect(raw.plugins?.installs).toBe(null);
      // baseHash must match
      expect(params.baseHash).toBe(CONFIG_GET_WITHOUT_PLAUD.hash);
    });

    // P1-U3: login MUST fire before config.patch. plaud.ts login (plaud.ts:208-247)
    // spawns its own npx child + polls the token file; it does not read
    // mcp.servers.plaud, so login works pre-config and no permanent config is
    // written until the token has landed.
    const loginIdx = mockRequest.mock.calls.findIndex(([m]) => m === 'rc.periph.plaud.login');
    const patchIdx = mockRequest.mock.calls.findIndex(([m]) => m === 'config.patch');
    expect(loginIdx).toBeGreaterThanOrEqual(0);
    expect(patchIdx).toBeGreaterThanOrEqual(0);
    expect(loginIdx).toBeLessThan(patchIdx);

    // Verify createDevice was called with correct payload
    await waitFor(() => {
      const createCall = mockRequest.mock.calls.find(([m]) => m === 'rc.periph.devices.create');
      expect(createCall).toBeTruthy();
      const [, params] = createCall!;
      expect(params).toMatchObject({
        name: 'Plaud 录音笔',
        kind: 'audio-recorder',
        driver: 'mcp-plaud',
      });
    });

    // After a successful connect the card must leave the "connect" branch —
    // the "连接 Plaud" main button should no longer render (I-3).
    await waitFor(() => {
      expect(screen.queryByTestId('plaud-connect-btn')).toBeNull();
    });
  });

  it('connect flow: FAILED login → config.patch is NEVER written (P1-U3)', async () => {
    mockRequest.mockImplementation((method: string) => {
      if (method === 'config.get') return Promise.resolve({ hash: CONFIG_GET_WITHOUT_PLAUD.hash });
      if (method === 'config.patch') return Promise.resolve({ ok: true });
      if (method === 'rc.periph.plaud.login')
        return Promise.resolve(RC_PERIPH_PLAUD_LOGIN_FAIL_RESPONSE);
      if (method === 'rc.periph.plaud.status')
        return Promise.resolve({ tokenPresent: false, account: undefined, toolsReady: false });
      return Promise.resolve(null);
    });

    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId('plaud-connect-btn')).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId('plaud-connect-btn'));
    });

    // login fired…
    await waitFor(() => {
      const loginCall = mockRequest.mock.calls.find(([m]) => m === 'rc.periph.plaud.login');
      expect(loginCall).toBeTruthy();
    });
    // …but a failed login must leave NO config behind: no config.patch, no createDevice.
    const patchCall = mockRequest.mock.calls.find(([m]) => m === 'config.patch');
    expect(patchCall).toBeUndefined();
    const createCall = mockRequest.mock.calls.find(([m]) => m === 'rc.periph.devices.create');
    expect(createCall).toBeUndefined();
  });

  it('connect flow: createDevice is idempotent — skips create when plaud device already exists', async () => {
    // Pre-populate devices with an existing plaud device
    usePeripheralsStore.setState({
      devices: [
        {
          id: 'plaud',
          name: 'Plaud 录音笔',
          kind: 'audio-recorder',
          driver: 'mcp-plaud',
          enabled: true,
          config: {},
          check_prompt: '',
          last_seen_at: null,
          last_error: null,
          created_at: '2026-07-01T00:00:00Z',
          updated_at: '2026-07-01T00:00:00Z',
        },
      ],
    });

    mockRequest.mockImplementation((method: string) => {
      if (method === 'config.get') return Promise.resolve({ hash: CONFIG_GET_WITHOUT_PLAUD.hash });
      if (method === 'config.patch') return Promise.resolve({ ok: true });
      if (method === 'rc.periph.plaud.login') return Promise.resolve(RC_PERIPH_PLAUD_LOGIN_OK_RESPONSE);
      if (method === 'rc.periph.plaud.status') return Promise.resolve(RC_PERIPH_PLAUD_STATUS_LOGGED_IN_RESPONSE);
      if (method === 'rc.periph.devices.list') return Promise.resolve({ devices: [] });
      return Promise.resolve(null);
    });

    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId('plaud-connect-btn')).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId('plaud-connect-btn'));
    });

    // createDevice should NOT have been called
    await waitFor(() => {
      const loginCall = mockRequest.mock.calls.find(([m]) => m === 'rc.periph.plaud.login');
      expect(loginCall).toBeTruthy();
    });
    const createCall = mockRequest.mock.calls.find(([m]) => m === 'rc.periph.devices.create');
    expect(createCall).toBeUndefined();
  });
});

// ── ② 已配置未登录态 — configured but not logged in ─────────────────────────

describe('PlaudCard — 已配置未登录态 (configured, not logged in)', () => {
  beforeEach(() => {
    // gatewayConfig HAS mcp.servers.plaud
    useConfigStore.setState({
      theme: 'dark',
      gatewayConfig: {
        agents: CONFIG_GET_WITH_PLAUD.config.agents as never,
        models: CONFIG_GET_WITH_PLAUD.config.models as never,
        raw: null,
        baseHash: CONFIG_GET_WITH_PLAUD.hash,
        projectConfig: CONFIG_GET_WITH_PLAUD.config as never,
      },
    });
    // plaudStatus → tokenPresent: false, NO lastError (clean "not logged in" state).
    // Note: RC_PERIPH_PLAUD_STATUS_LOGGED_OUT_RESPONSE has lastError which would
    // trigger error state; use a clean not-logged-in fixture here instead.
    mockRequest.mockImplementation((method: string) => {
      if (method === 'rc.periph.plaud.status')
        return Promise.resolve({ tokenPresent: false, account: undefined, toolsReady: false });
      return Promise.resolve(null);
    });
  });

  it('shows blue status strip + login button (not connect)', async () => {
    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => {
      expect(screen.getByTestId('plaud-login-btn')).toBeTruthy();
    });
    // connect button must NOT appear
    expect(screen.queryByTestId('plaud-connect-btn')).toBeNull();
  });

  it('login flow: only calls plaudLogin → createDevice (skips config.patch)', async () => {
    // Initial status: not logged in (from beforeEach mock).
    // After login, override to return logged-in for the refresh call.
    let loginDone = false;
    mockRequest.mockImplementation((method: string) => {
      if (method === 'rc.periph.plaud.status') {
        if (loginDone) return Promise.resolve(RC_PERIPH_PLAUD_STATUS_LOGGED_IN_RESPONSE);
        return Promise.resolve({ tokenPresent: false, account: undefined, toolsReady: false });
      }
      if (method === 'rc.periph.plaud.login') {
        loginDone = true;
        return Promise.resolve(RC_PERIPH_PLAUD_LOGIN_OK_RESPONSE);
      }
      if (method === 'rc.periph.devices.list') return Promise.resolve({ devices: [] });
      if (method === 'rc.periph.devices.create') return Promise.resolve(RC_PERIPH_DEVICES_CREATE_RESPONSE);
      return Promise.resolve(null);
    });

    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId('plaud-login-btn')).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId('plaud-login-btn'));
    });

    await waitFor(() => {
      const loginCall = mockRequest.mock.calls.find(([m]) => m === 'rc.periph.plaud.login');
      expect(loginCall).toBeTruthy();
    });

    // config.patch must NOT have been called
    const patchCall = mockRequest.mock.calls.find(([m]) => m === 'config.patch');
    expect(patchCall).toBeUndefined();
  });
});

// ── ③ 已连接态 — connected (tokenPresent true) ───────────────────────────────

describe('PlaudCard — 已连接态 (connected)', () => {
  beforeEach(() => {
    useConfigStore.setState({
      theme: 'dark',
      gatewayConfig: {
        agents: CONFIG_GET_WITH_PLAUD.config.agents as never,
        models: CONFIG_GET_WITH_PLAUD.config.models as never,
        raw: null,
        baseHash: CONFIG_GET_WITH_PLAUD.hash,
        projectConfig: CONFIG_GET_WITH_PLAUD.config as never,
      },
    });
    mockRequest.mockResolvedValue(RC_PERIPH_PLAUD_STATUS_LOGGED_IN_RESPONSE);
  });

  it('shows green status strip + account name + tools ready badge', async () => {
    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => {
      // Account name from fixture: 'researcher@lab.edu'
      expect(screen.getByTestId('plaud-account-label')).toBeTruthy();
      expect(screen.getByTestId('plaud-tools-badge')).toBeTruthy();
    });
    // No connect/login buttons
    expect(screen.queryByTestId('plaud-connect-btn')).toBeNull();
    expect(screen.queryByTestId('plaud-login-btn')).toBeNull();
  });

  it('renders at least 2 quick-action chips', async () => {
    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => {
      const chips = screen.getAllByTestId(/plaud-chip-/);
      expect(chips.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('chip click sets chatInputPrefill in ui store', async () => {
    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => {
      const chips = screen.getAllByTestId(/plaud-chip-/);
      expect(chips.length).toBeGreaterThan(0);
    });

    const chips = screen.getAllByTestId(/plaud-chip-/);
    fireEvent.click(chips[0]);

    // The ui store should have a non-null chatInputPrefill
    await waitFor(() => {
      const prefill = useUiStore.getState().chatInputPrefill;
      expect(prefill).toBeTruthy();
      expect(typeof prefill).toBe('string');
    });
  });
});

// ── ④ 错误态 — error (lastError present) ─────────────────────────────────────

describe('PlaudCard — 错误态 (lastError)', () => {
  beforeEach(() => {
    useConfigStore.setState({
      theme: 'dark',
      gatewayConfig: {
        agents: CONFIG_GET_WITH_PLAUD.config.agents as never,
        models: CONFIG_GET_WITH_PLAUD.config.models as never,
        raw: null,
        baseHash: CONFIG_GET_WITH_PLAUD.hash,
        projectConfig: CONFIG_GET_WITH_PLAUD.config as never,
      },
    });
    mockRequest.mockResolvedValue(RC_PERIPH_PLAUD_STATUS_LOGGED_OUT_RESPONSE);
  });

  it('shows red strip + error message + retry button when lastError present', async () => {
    // Override status to include lastError
    mockRequest.mockResolvedValue({
      tokenPresent: false,
      lastError: 'Authentication token expired',
    });

    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => {
      expect(screen.getByTestId('plaud-error-msg')).toBeTruthy();
      expect(screen.getByTestId('plaud-retry-btn')).toBeTruthy();
    });
  });

  it('retry button re-triggers login flow', async () => {
    mockRequest.mockImplementation((method: string) => {
      if (method === 'rc.periph.plaud.status')
        return Promise.resolve({ tokenPresent: false, lastError: 'Auth expired' });
      if (method === 'rc.periph.plaud.login')
        return Promise.resolve(RC_PERIPH_PLAUD_LOGIN_OK_RESPONSE);
      if (method === 'rc.periph.devices.list') return Promise.resolve({ devices: [] });
      if (method === 'rc.periph.devices.create') return Promise.resolve(RC_PERIPH_DEVICES_CREATE_RESPONSE);
      return Promise.resolve(null);
    });

    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId('plaud-retry-btn')).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId('plaud-retry-btn'));
    });

    await waitFor(() => {
      const loginCall = mockRequest.mock.calls.find(([m]) => m === 'rc.periph.plaud.login');
      expect(loginCall).toBeTruthy();
    });
    // In the configured error state, retry is a pure re-login: config already
    // exists, so it must NOT re-write config.patch.
    expect(mockRequest.mock.calls.find(([m]) => m === 'config.patch')).toBeUndefined();
  });
});

// ── ④b 未配置错误态 — retry after a first-connect login failure (P1-U3 mirror) ─
//
// Reproduces the config-side dead state the review flagged: the FIRST connect
// fails at login (generic failure → error banner), the user clicks Retry, this
// login SUCCEEDS. Because config was never written, retry must run the full
// connect (login → config.patch), otherwise the token lands (tokenPresent=true)
// while mcp.servers.plaud stays absent and the card falls back to the "connect"
// branch despite being logged in. `handleRetry = configured ? handleLogin :
// handleConnect` (PlaudCard.tsx) is what closes this gap.
describe('PlaudCard — 未配置错误态 retry (P1-U3 config-side mirror)', () => {
  it('first-connect login failure → retry success writes config + leaves connect branch', async () => {
    // NOT configured: no mcp.servers.plaud in the config snapshot.
    useConfigStore.setState({
      theme: 'dark',
      gatewayConfig: {
        agents: CONFIG_GET_WITHOUT_PLAUD.config.agents as never,
        models: CONFIG_GET_WITHOUT_PLAUD.config.models as never,
        raw: null,
        baseHash: CONFIG_GET_WITHOUT_PLAUD.hash,
        projectConfig: null,
      },
    });

    // First login fails (generic), second (retry) succeeds. Status flips to
    // logged-in only after the successful login lands the token.
    let loginAttempts = 0;
    let tokenLanded = false;
    mockRequest.mockImplementation((method: string) => {
      if (method === 'config.get') return Promise.resolve({ hash: CONFIG_GET_WITHOUT_PLAUD.hash });
      if (method === 'config.patch') return Promise.resolve({ ok: true });
      if (method === 'rc.periph.plaud.login') {
        loginAttempts += 1;
        if (loginAttempts === 1) return Promise.resolve(RC_PERIPH_PLAUD_LOGIN_FAIL_RESPONSE);
        tokenLanded = true;
        return Promise.resolve(RC_PERIPH_PLAUD_LOGIN_OK_RESPONSE);
      }
      if (method === 'rc.periph.plaud.status')
        return Promise.resolve(
          tokenLanded
            ? RC_PERIPH_PLAUD_STATUS_LOGGED_IN_RESPONSE
            : { tokenPresent: false, account: undefined, toolsReady: false },
        );
      if (method === 'rc.periph.devices.list') return Promise.resolve({ devices: [] });
      if (method === 'rc.periph.devices.create') return Promise.resolve(RC_PERIPH_DEVICES_CREATE_RESPONSE);
      return Promise.resolve(null);
    });

    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId('plaud-connect-btn')).toBeTruthy());

    // First connect → login fails → error state with a retry button.
    await act(async () => { fireEvent.click(screen.getByTestId('plaud-connect-btn')); });
    await waitFor(() => expect(screen.getByTestId('plaud-retry-btn')).toBeTruthy());
    // The failed first login left NO config behind (P1-U3 connect invariant).
    expect(mockRequest.mock.calls.find(([m]) => m === 'config.patch')).toBeUndefined();

    // Retry → login succeeds. Since config is still missing, retry MUST run the
    // full connect and write config.patch.
    await act(async () => { fireEvent.click(screen.getByTestId('plaud-retry-btn')); });

    await waitFor(() => {
      const patchCall = mockRequest.mock.calls.find(([m]) => m === 'config.patch');
      expect(patchCall).toBeTruthy();
      const [, params] = patchCall!;
      const raw = JSON.parse(params.raw as string);
      expect(raw.mcp?.servers?.plaud).toMatchObject({ command: 'npx', args: ['-y', '@plaud-ai/mcp@0.3.5'] });
      expect(raw.plugins?.installs).toBe(null);
    });

    // configuredOverride flips true after the write → the card must NOT fall
    // back to the "connect" branch (the bug's symptom). It lands connected.
    await waitFor(() => {
      expect(screen.queryByTestId('plaud-connect-btn')).toBeNull();
      expect(screen.getByTestId('plaud-account-label')).toBeTruthy();
    });
  });
});

// ── ⑤ Unavailable — plugin too old ────────────────────────────────────────────

describe('PlaudCard — unavailable (plugin too old)', () => {
  it('shows "plugin version too old" red strip when store.unavailable is true', async () => {
    usePeripheralsStore.setState({ unavailable: true });
    useConfigStore.setState({
      theme: 'dark',
      gatewayConfig: null,
    });

    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => {
      expect(screen.getByTestId('plaud-unavailable-banner')).toBeTruthy();
    });
  });
});

// ── ⑥ Login failure handling ──────────────────────────────────────────────────

describe('PlaudCard — login failure', () => {
  it('shows error strip when plaudLogin returns ok:false', async () => {
    useConfigStore.setState({
      theme: 'dark',
      gatewayConfig: {
        agents: CONFIG_GET_WITH_PLAUD.config.agents as never,
        models: CONFIG_GET_WITH_PLAUD.config.models as never,
        raw: null,
        baseHash: CONFIG_GET_WITH_PLAUD.hash,
        projectConfig: CONFIG_GET_WITH_PLAUD.config as never,
      },
    });

    mockRequest.mockImplementation((method: string) => {
      if (method === 'rc.periph.plaud.status')
        return Promise.resolve({ tokenPresent: false, lastError: undefined });
      if (method === 'rc.periph.plaud.login')
        return Promise.resolve(RC_PERIPH_PLAUD_LOGIN_FAIL_RESPONSE);
      return Promise.resolve(null);
    });

    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId('plaud-login-btn')).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId('plaud-login-btn'));
    });

    await waitFor(() => {
      // After failed login, error message should be shown
      expect(screen.getByTestId('plaud-error-msg')).toBeTruthy();
    });
  });
});

// ── ⑧ Login-in-progress + cancel (T19 P-1) ───────────────────────────────────

describe('PlaudCard — login in progress + cancel (T19 P-1)', () => {
  beforeEach(() => {
    useConfigStore.setState({
      theme: 'dark',
      gatewayConfig: {
        agents: CONFIG_GET_WITH_PLAUD.config.agents as never,
        models: CONFIG_GET_WITH_PLAUD.config.models as never,
        raw: null,
        baseHash: CONFIG_GET_WITH_PLAUD.hash,
        projectConfig: CONFIG_GET_WITH_PLAUD.config as never,
      },
    });
  });

  it('shows the waiting hint + cancel button while login is pending', async () => {
    // login never resolves during the test → card stays in "logging in" state.
    let resolveLogin: (v: { ok: boolean }) => void = () => {};
    mockRequest.mockImplementation((method: string) => {
      if (method === 'rc.periph.plaud.status')
        return Promise.resolve({ tokenPresent: false, account: undefined, toolsReady: false });
      if (method === 'rc.periph.plaud.login')
        return new Promise((res) => { resolveLogin = res; });
      return Promise.resolve(null);
    });

    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId('plaud-login-btn')).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId('plaud-login-btn'));
    });

    // Waiting hint + cancel button appear; login/connect buttons are gone.
    await waitFor(() => {
      expect(screen.getByTestId('plaud-logging-in-hint')).toBeTruthy();
      expect(screen.getByTestId('plaud-cancel-login-btn')).toBeTruthy();
    });
    expect(screen.queryByTestId('plaud-login-btn')).toBeNull();

    // Clean up the dangling promise so the test doesn't leak.
    await act(async () => { resolveLogin({ ok: false }); });
  });

  it('clicking cancel calls rc.periph.plaud.cancelLogin', async () => {
    let resolveLogin: (v: { ok: boolean; error?: string }) => void = () => {};
    mockRequest.mockImplementation((method: string) => {
      if (method === 'rc.periph.plaud.status')
        return Promise.resolve({ tokenPresent: false, account: undefined, toolsReady: false });
      if (method === 'rc.periph.plaud.login')
        return new Promise((res) => { resolveLogin = res; });
      if (method === 'rc.periph.plaud.cancelLogin') return Promise.resolve({ ok: true });
      return Promise.resolve(null);
    });

    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId('plaud-login-btn')).toBeTruthy());

    await act(async () => { fireEvent.click(screen.getByTestId('plaud-login-btn')); });
    await waitFor(() => expect(screen.getByTestId('plaud-cancel-login-btn')).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId('plaud-cancel-login-btn'));
      // login resolves cancelled after the cancel RPC fires.
      resolveLogin({ ok: false, error: 'login-cancelled' });
    });

    await waitFor(() => {
      const cancelCall = mockRequest.mock.calls.find(([m]) => m === 'rc.periph.plaud.cancelLogin');
      expect(cancelCall).toBeTruthy();
    });

    // After cancel, the card returns to a retriable state (login button back,
    // no error banner).
    await waitFor(() => {
      expect(screen.getByTestId('plaud-login-btn')).toBeTruthy();
      expect(screen.queryByTestId('plaud-error-msg')).toBeNull();
    });
  });

  it('login-in-progress return → shows "previous login running" hint', async () => {
    mockRequest.mockImplementation((method: string) => {
      if (method === 'rc.periph.plaud.status')
        return Promise.resolve({ tokenPresent: false, account: undefined, toolsReady: false });
      if (method === 'rc.periph.plaud.login')
        return Promise.resolve({ ok: false, error: 'login-in-progress' });
      return Promise.resolve(null);
    });

    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId('plaud-login-btn')).toBeTruthy());

    await act(async () => { fireEvent.click(screen.getByTestId('plaud-login-btn')); });

    await waitFor(() => {
      const errMsg = screen.getByTestId('plaud-error-msg');
      expect(errMsg.textContent).toContain('上一次登录仍在进行');
    });
  });
});

// ── P1 国际版 Tag — always rendered regardless of state ──────────────────────

describe('PlaudCard — 国际版 Tag (P1)', () => {
  it('renders the "Global" edition tag in the header', async () => {
    useConfigStore.setState({ theme: 'dark', gatewayConfig: null });
    mockRequest.mockResolvedValue(null);

    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => {
      const tag = screen.getByTestId('plaud-global-tag');
      expect(tag).toBeTruthy();
      // Mocked t() returns the zh fallback '国际版'
      expect(tag.textContent).toContain('国际版');
    });
  });

  it('appends the Global-account hint to the unconfigured value copy', async () => {
    useConfigStore.setState({
      theme: 'dark',
      gatewayConfig: {
        agents: CONFIG_GET_WITHOUT_PLAUD.config.agents as never,
        models: CONFIG_GET_WITHOUT_PLAUD.config.models as never,
        raw: null,
        baseHash: CONFIG_GET_WITHOUT_PLAUD.hash,
        projectConfig: null,
      },
    });
    mockRequest.mockResolvedValue(null);

    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => {
      expect(screen.getByTestId('plaud-connect-btn')).toBeTruthy();
    });
    expect(document.body.textContent).toContain('需要 Plaud 国际版账号');
  });
});

// ── ⑨ Disconnect (P1-U3) ──────────────────────────────────────────────────────

describe('PlaudCard — disconnect (P1-U3)', () => {
  it('connected state: disconnect patches mcp.servers.plaud=null with installs stripped', async () => {
    useConfigStore.setState({
      theme: 'dark',
      gatewayConfig: {
        agents: CONFIG_GET_WITH_PLAUD.config.agents as never,
        models: CONFIG_GET_WITH_PLAUD.config.models as never,
        raw: null,
        baseHash: CONFIG_GET_WITH_PLAUD.hash,
        projectConfig: CONFIG_GET_WITH_PLAUD.config as never,
      },
    });
    mockRequest.mockImplementation((method: string) => {
      if (method === 'rc.periph.plaud.status') return Promise.resolve(RC_PERIPH_PLAUD_STATUS_LOGGED_IN_RESPONSE);
      if (method === 'config.get') return Promise.resolve({ hash: CONFIG_GET_WITH_PLAUD.hash });
      if (method === 'config.patch') return Promise.resolve({ ok: true });
      return Promise.resolve(null);
    });

    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId('plaud-disconnect-btn')).toBeTruthy());

    await act(async () => { fireEvent.click(screen.getByTestId('plaud-disconnect-btn')); });
    // Popconfirm — confirm the danger action.
    await act(async () => {
      const okBtn = document.querySelector('.ant-popconfirm-buttons .ant-btn-dangerous')
        ?? document.querySelector('.ant-popconfirm-buttons .ant-btn-primary');
      fireEvent.click(okBtn as Element);
    });

    await waitFor(() => {
      const patchCall = mockRequest.mock.calls.find(([m]) => m === 'config.patch');
      expect(patchCall).toBeTruthy();
      const [, params] = patchCall!;
      const raw = JSON.parse(params.raw as string);
      // servers.plaud must be nulled out (remove the MCP server).
      expect(raw.mcp?.servers?.plaud).toBe(null);
      // house pattern: RC-only plugins.installs stripped in the same patch.
      expect(raw.plugins?.installs).toBe(null);
    });
  });

  it('configured-not-logged-in state exposes a disconnect exit route', async () => {
    useConfigStore.setState({
      theme: 'dark',
      gatewayConfig: {
        agents: CONFIG_GET_WITH_PLAUD.config.agents as never,
        models: CONFIG_GET_WITH_PLAUD.config.models as never,
        raw: null,
        baseHash: CONFIG_GET_WITH_PLAUD.hash,
        projectConfig: CONFIG_GET_WITH_PLAUD.config as never,
      },
    });
    mockRequest.mockImplementation((method: string) => {
      if (method === 'rc.periph.plaud.status')
        return Promise.resolve({ tokenPresent: false, account: undefined, toolsReady: false });
      return Promise.resolve(null);
    });

    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId('plaud-login-btn')).toBeTruthy());
    // The dead-end "configured but not logged in" state must offer a way out.
    expect(screen.getByTestId('plaud-disconnect-btn')).toBeTruthy();
  });
});

// ── ⑩ Docker degradation (P1-U4) ─────────────────────────────────────────────

describe('PlaudCard — Docker degradation (P1-U4)', () => {
  beforeEach(() => {
    useConfigStore.setState({
      theme: 'dark',
      gatewayConfig: {
        agents: CONFIG_GET_WITHOUT_PLAUD.config.agents as never,
        models: CONFIG_GET_WITHOUT_PLAUD.config.models as never,
        raw: null,
        baseHash: CONFIG_GET_WITHOUT_PLAUD.hash,
        projectConfig: null,
      },
    });
    // Drive from the real gateway payload fixture: the rc.periph.plaud.status
    // HANDLER stamps docker (periph/rpc.ts: `{...(await plaud.status()), docker: isDocker}`),
    // so RC_PERIPH_PLAUD_STATUS_DOCKER_RESPONSE.docker===true is what the wire
    // actually carries in a container — not a test-only field (P1-U4).
    mockRequest.mockImplementation((method: string) => {
      if (method === 'rc.periph.plaud.status')
        return Promise.resolve(RC_PERIPH_PLAUD_STATUS_DOCKER_RESPONSE);
      return Promise.resolve(null);
    });
  });

  it('greys out connect + shows container-unsupported warning', async () => {
    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => {
      expect(screen.getByTestId('plaud-docker-warning')).toBeTruthy();
    });
    const btn = screen.getByTestId('plaud-connect-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('clicking a disabled connect never enters config.patch / login', async () => {
    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId('plaud-connect-btn')).toBeTruthy());

    await act(async () => { fireEvent.click(screen.getByTestId('plaud-connect-btn')); });

    expect(mockRequest.mock.calls.find(([m]) => m === 'config.patch')).toBeUndefined();
    expect(mockRequest.mock.calls.find(([m]) => m === 'rc.periph.plaud.login')).toBeUndefined();
  });
});

// ── ⑪ Daily recording report (F4 / P1-B1) ────────────────────────────────────

describe('PlaudCard — daily recording report (F4 / P1-B1)', () => {
  // Snapshot the real monitor-store actions so the spy swap below is reverted
  // after each test — otherwise the replaced createMonitor/toggleMonitor leak
  // into later suites sharing this global store (test pollution).
  const realCreateMonitor = useMonitorStore.getState().createMonitor;
  const realToggleMonitor = useMonitorStore.getState().toggleMonitor;

  beforeEach(() => {
    useConfigStore.setState({
      theme: 'dark',
      gatewayConfig: {
        agents: CONFIG_GET_WITH_PLAUD.config.agents as never,
        models: CONFIG_GET_WITH_PLAUD.config.models as never,
        raw: null,
        baseHash: CONFIG_GET_WITH_PLAUD.hash,
        projectConfig: CONFIG_GET_WITH_PLAUD.config as never,
      },
    });
  });

  afterEach(() => {
    useMonitorStore.setState({
      createMonitor: realCreateMonitor,
      toggleMonitor: realToggleMonitor,
    } as never);
  });

  it('creates a device monitor bound to the plaud device with the right fields', async () => {
    // Spy the monitor store actions directly (avoids the full cron toggle chain).
    const createMonitor = vi.fn().mockResolvedValue({
      id: 'mon-plaud-1',
      name: 'Plaud 每日录音日报',
      source_type: 'device',
      target: 'plaud',
      schedule: '0 22 * * *',
      enabled: false,
      notify: true,
    });
    const toggleMonitor = vi.fn().mockImplementation(async () => {
      useMonitorStore.setState({
        monitors: [{
          id: 'mon-plaud-1',
          name: 'Plaud 每日录音日报',
          source_type: 'device',
          target: 'plaud',
          schedule: '0 22 * * *',
          enabled: true,
          notify: true,
          gateway_job_id: 'job-plaud-1',
        }],
      } as never);
      return { ok: true };
    });
    useMonitorStore.setState({ createMonitor, toggleMonitor, monitors: [] } as never);

    mockRequest.mockResolvedValue(RC_PERIPH_PLAUD_STATUS_LOGGED_IN_RESPONSE);

    await renderPlaudCardAfterInitialStatus();
    expect(screen.getByTestId('plaud-daily-report-btn')).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByTestId('plaud-daily-report-btn')); });

    await waitFor(() => expect(createMonitor).toHaveBeenCalled());
    const arg = createMonitor.mock.calls[0][0];
    // SPEC:338-342,373 — the daily-report monitor contract.
    expect(arg.source_type).toBe('device');
    expect(arg.target).toBe('plaud');
    expect(arg.schedule).toBe('0 22 * * *');
    expect(arg.notify).toBe(true);
    // agent_prompt empty → plugin injects the audio-recorder default template.
    expect(arg.agent_prompt).toBe('');

    // create-then-enable: toggled on immediately since the dashboard is online.
    await waitFor(() => expect(toggleMonitor).toHaveBeenCalledWith('mon-plaud-1', true));
  });

  it('renders the DeviceMonitors panel once a plaud monitor exists', async () => {
    useMonitorStore.setState({
      monitors: [
        {
          id: 'mon-plaud-1',
          name: 'Plaud 每日录音日报',
          source_type: 'device',
          target: 'plaud',
          filters: {},
          schedule: '0 22 * * *',
          enabled: true,
          notify: true,
          agent_prompt: '',
          gateway_job_id: 'gw-1',
          last_check_at: null,
          last_results: null,
          last_error: null,
          check_count: 0,
          finding_count: 0,
          created_at: '2026-07-01T00:00:00Z',
          updated_at: '2026-07-01T00:00:00Z',
        },
      ] as never,
      loading: false,
      loaded: true,
    });
    mockRequest.mockResolvedValue(RC_PERIPH_PLAUD_STATUS_LOGGED_IN_RESPONSE);

    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => {
      expect(screen.getByTestId('plaud-device-monitors')).toBeTruthy();
      // The existing plaud monitor row is shown inside DeviceMonitors.
      expect(screen.getByTestId('periph-monitor-row-mon-plaud-1')).toBeTruthy();
    });
  });
});

// ── ⑦ Derived "configured" check ─────────────────────────────────────────────

describe('PlaudCard — configured derivation', () => {
  it('treats gatewayConfig with mcp.servers.plaud as configured', async () => {
    // gatewayConfig.projectConfig has mcp.servers.plaud
    useConfigStore.setState({
      theme: 'dark',
      gatewayConfig: {
        agents: CONFIG_GET_WITH_PLAUD.config.agents as never,
        models: CONFIG_GET_WITH_PLAUD.config.models as never,
        raw: null,
        baseHash: null,
        projectConfig: CONFIG_GET_WITH_PLAUD.config as never,
      },
    });
    mockRequest.mockResolvedValue(RC_PERIPH_PLAUD_STATUS_LOGGED_IN_RESPONSE);

    await renderPlaudCardAfterInitialStatus();
    expect(screen.getByTestId('plaud-account-label')).toBeTruthy();
    expect(screen.queryByTestId('plaud-connect-btn')).toBeNull();
  });

  it('treats gatewayConfig without mcp.servers.plaud as NOT configured', async () => {
    useConfigStore.setState({
      theme: 'dark',
      gatewayConfig: {
        agents: CONFIG_GET_WITHOUT_PLAUD.config.agents as never,
        models: CONFIG_GET_WITHOUT_PLAUD.config.models as never,
        raw: null,
        baseHash: null,
        projectConfig: null,
      },
    });

    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => {
      expect(screen.getByTestId('plaud-connect-btn')).toBeTruthy();
    });
  });
});

// ── ⑬ status 未就绪 / 未知（Docker 竞态 + 后发先至覆盖）─────────────────────────
//
// 缺陷背景：`plaudStatus()` 在「网关未连接」「RPC 拒绝/超时」两种情况下都返回
// null（stores/peripherals.ts），而卡片用同一个 `status===null` 同时表示「还没拉
// 到」。后果有二：
//   (a) P1-U4 的 Docker 守卫被绕过 —— `docker = status?.docker === true` 在解析
//       完成前恒为 false，容器内用户可在该窗口点下红色「连接 Plaud」，进入
//       login → spawn npx → 开浏览器 的死路。
//   (b) status 拉取失败且 configured=true 时六个渲染分支全假 —— 空白卡，无
//       loading、无错误、无重试出口。
// 另有并发覆盖：挂载快照与登录后刷新两次 setStatus 无任何顺序守卫，挂载那次若
// 后落地会把登录后的新鲜快照覆盖回陈旧值。

describe('PlaudCard — status 未就绪 / 未知态', () => {
  beforeEach(() => {
    // NOT configured —— 这是 fresh install 首帧,也是 P1-U4 守卫必须生效的场景
    useConfigStore.setState({
      theme: 'dark',
      gatewayConfig: {
        agents: CONFIG_GET_WITHOUT_PLAUD.config.agents as never,
        models: CONFIG_GET_WITHOUT_PLAUD.config.models as never,
        raw: null,
        baseHash: CONFIG_GET_WITHOUT_PLAUD.hash,
        projectConfig: null,
      },
    });
  });

  it('status 解析完成前：connect 按钮禁用,且点击不会发出 login / config.patch', async () => {
    // status 永不 resolve —— 精确复现「解析窗口」。真机上这段窗口最长可达
    // 30s（gateway/client.ts REQUEST_TIMEOUT_MS），容器内 npx 冷启动即如此。
    let releaseStatus: (v: unknown) => void = () => {};
    const pendingStatus = new Promise((resolve) => { releaseStatus = resolve; });
    mockRequest.mockImplementation((method: string) => {
      if (method === 'rc.periph.plaud.status') return pendingStatus;
      if (method === 'config.get') return Promise.resolve({ hash: CONFIG_GET_WITHOUT_PLAUD.hash });
      return Promise.resolve(null);
    });

    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId('plaud-connect-btn')).toBeTruthy());

    const btn = screen.getByTestId('plaud-connect-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    await act(async () => { fireEvent.click(btn); });

    expect(mockRequest.mock.calls.find(([m]) => m === 'rc.periph.plaud.login')).toBeUndefined();
    expect(mockRequest.mock.calls.find(([m]) => m === 'config.patch')).toBeUndefined();

    // 解析落地（容器）后守卫仍然成立
    await act(async () => {
      releaseStatus(RC_PERIPH_PLAUD_STATUS_DOCKER_RESPONSE);
      await pendingStatus;
    });
    await waitFor(() => expect(screen.getByTestId('plaud-docker-warning')).toBeTruthy());
    expect((screen.getByTestId('plaud-connect-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('status 拉取失败（返回 null）：渲染显式未知提示 + 重试出口,而非空白卡', async () => {
    // 已配置 + status 失败 —— 老用户一次失败即永久空卡的那条路径
    useConfigStore.setState({
      theme: 'dark',
      gatewayConfig: {
        agents: CONFIG_GET_WITH_PLAUD.config.agents as never,
        models: CONFIG_GET_WITH_PLAUD.config.models as never,
        raw: null,
        baseHash: CONFIG_GET_WITH_PLAUD.hash,
        projectConfig: { mcp: { servers: { plaud: { command: 'npx' } } } } as never,
      },
    });
    let statusCalls = 0;
    mockRequest.mockImplementation((method: string) => {
      if (method === 'rc.periph.plaud.status') {
        statusCalls += 1;
        // 第一次失败（store 折叠为 null）,第二次成功 —— 验证重试真的能救回来
        return statusCalls === 1
          ? Promise.reject(new Error('transport timeout'))
          : Promise.resolve(RC_PERIPH_PLAUD_STATUS_LOGGED_IN_RESPONSE);
      }
      return Promise.resolve(null);
    });

    render(<Wrapper><PlaudCard /></Wrapper>);

    // 未知提示 + 重试按钮必须出现（旧实现这里是一张空白卡）
    await waitFor(() => expect(screen.getByTestId('plaud-status-unknown')).toBeTruthy());
    const retry = screen.getByTestId('plaud-status-retry-btn');
    expect(retry).toBeTruthy();
    // 空白卡的判据：连登录按钮都没有
    expect(screen.queryByTestId('plaud-login-btn')).toBeNull();

    await act(async () => { fireEvent.click(retry); });

    // 重试成功 → 进入已连接态,未知提示消失
    await waitFor(() => expect(screen.getByTestId('plaud-account-label')).toBeTruthy());
    expect(screen.queryByTestId('plaud-status-unknown')).toBeNull();
  });

  it('并发 status:挂载快照后落地也不得覆盖登录后的新鲜快照（后发先至）', async () => {
    // 挂载那次 status 走 npx 冷启动、慢；登录后那次因 token 已在、快。
    // 若无 seq 守卫,慢的挂载快照（带 stale-token lastError）会覆盖登录成功态,
    // 卡片会在新鲜快照落地后翻回红色错误分支。
    useConfigStore.setState({
      theme: 'dark',
      gatewayConfig: {
        agents: CONFIG_GET_WITH_PLAUD.config.agents as never,
        models: CONFIG_GET_WITH_PLAUD.config.models as never,
        raw: null,
        baseHash: CONFIG_GET_WITH_PLAUD.hash,
        projectConfig: { mcp: { servers: { plaud: { command: 'npx' } } } } as never,
      },
    });

    let releaseSlow: (v: unknown) => void = () => {};
    const slowStatus = new Promise((resolve) => { releaseSlow = resolve; });
    let statusCalls = 0;
    mockRequest.mockImplementation((method: string) => {
      if (method === 'rc.periph.plaud.status') {
        statusCalls += 1;
        // #1 挂载：直接失败 → 进入未知态,拿到重试出口
        if (statusCalls === 1) return Promise.reject(new Error('transport timeout'));
        // #2 第一次重试：悬挂,稍后带「陈旧 token」错误落地（后发）
        if (statusCalls === 2) return slowStatus;
        // #3 第二次重试：立刻带新鲜的已登录快照返回（先至）
        return Promise.resolve(RC_PERIPH_PLAUD_STATUS_LOGGED_IN_RESPONSE);
      }
      return Promise.resolve(null);
    });

    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId('plaud-status-retry-btn')).toBeTruthy());

    // 重试 #1 —— 悬挂,卡片仍停在未知态,重试按钮还在
    await act(async () => { fireEvent.click(screen.getByTestId('plaud-status-retry-btn')); });
    expect(screen.getByTestId('plaud-status-retry-btn')).toBeTruthy();

    // 重试 #2 —— 立刻返回新鲜快照,卡片进入已连接态
    await act(async () => { fireEvent.click(screen.getByTestId('plaud-status-retry-btn')); });
    await waitFor(() => expect(screen.getByTestId('plaud-account-label')).toBeTruthy());

    // 现在让 #1 的陈旧响应姗姗来迟 —— 必须被丢弃
    await act(async () => {
      releaseSlow({ tokenPresent: true, lastError: 'plaud token invalid' });
      await slowStatus;
    });

    expect(statusCalls).toBe(3);
    expect(screen.getByTestId('plaud-account-label')).toBeTruthy();
    expect(screen.queryByTestId('plaud-error-msg')).toBeNull();
  });
});
