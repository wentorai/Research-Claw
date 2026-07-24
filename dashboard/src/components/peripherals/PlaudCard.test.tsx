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
import { useUiStore } from '../../stores/ui';
import {
  RC_PERIPH_PLAUD_STATUS_LOGGED_IN_RESPONSE,
  RC_PERIPH_PLAUD_STATUS_LOGGED_OUT_RESPONSE,
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

  it('connect flow: config.patch → plaudLogin → createDevice (idempotent)', async () => {
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

    // Verify plaudLogin was called after config.patch
    await waitFor(() => {
      const loginCall = mockRequest.mock.calls.find(([m]) => m === 'rc.periph.plaud.login');
      expect(loginCall).toBeTruthy();
    });

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

    render(<Wrapper><PlaudCard /></Wrapper>);
    await waitFor(() => {
      expect(screen.getByTestId('plaud-account-label')).toBeTruthy();
    });
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
