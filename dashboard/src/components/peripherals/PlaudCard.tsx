/**
 * PlaudCard — Plaud 录音笔外设卡片 (Task 15)
 *
 * 三态卡（卡内展开模式，不弹详情页）:
 *   - 未配置:  灰色状态条 + "连接 Plaud" 红色主按钮
 *   - 已配置未登录: 蓝色状态条 + "登录 Plaud" 按钮
 *   - 已连接:  绿色状态条 + 账号 + 工具徽标 + 快捷 chips
 *   - 错误态:  红色状态条 + 错误信息 + "重试" 按钮
 *   - unavailable: 红色状态条 "插件版本过旧"
 *
 * 选择卡内展开而非详情页的原因：
 *   Plaud 卡的主交互是"连接/登录"与快捷 chips，无需视频预览等复杂 UI，
 *   与 PeripheralsPanel 槽位同层展开更轻量；Camera 需要全屏 live preview 才
 *   选择了独立详情页。
 *
 * configured 判定：
 *   从 useConfigStore.gatewayConfig.projectConfig（或 gatewayConfig 自身）
 *   读取 mcp?.servers?.plaud 是否存在。projectConfig 是 config.get 返回的
 *   原始项目级配置（未经 OC runtime 默认值覆盖），用于判断用户是否已手动
 *   写入过 mcp 配置。GatewayConfig 中没有 mcp 字段（类型只声明了 agents/
 *   models/env/tools/browser），因此从 projectConfig（Record<string,unknown>）
 *   取值并做类型收窄。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Tag, Typography } from 'antd';
import { AudioOutlined, ReloadOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { getThemeTokens } from '../../styles/theme';
import { useConfigStore } from '../../stores/config';
import { usePeripheralsStore } from '../../stores/peripherals';
import { useGatewayStore } from '../../stores/gateway';
import { useUiStore } from '../../stores/ui';

const { Text } = Typography;

// ── MCP Plaud package version pinned here ─────────────────────────────────────
const PLAUD_MCP_VERSION = '0.3.5';
const PLAUD_MCP_ARG = `@plaud-ai/mcp@${PLAUD_MCP_VERSION}`;

// ── Status bar colors ─────────────────────────────────────────────────────────
const STATUS_COLOR: Record<string, string> = {
  unconfigured: '#6B7280', // grey
  configured: '#3B82F6',   // blue (Academic Blue)
  connected: '#22C55E',    // green
  error: '#EF4444',        // red (Lobster Red)
};

// ── Quick-action chips for connected state ─────────────────────────────────────
const QUICK_CHIPS = [
  { id: 'summarize-today', textKey: 'periph.plaud.chipSummarizeToday', fallback: '汇总今天的录音' },
  { id: 'list-recent', textKey: 'periph.plaud.chipListRecent', fallback: '列出最近的录音' },
  { id: 'transcribe-latest', textKey: 'periph.plaud.chipTranscribeLatest', fallback: '转录最近一条录音' },
] as const;

// ── Helper: derive "configured" from gatewayConfig ────────────────────────────
/**
 * Returns true if mcp.servers.plaud is present in the gateway config snapshot.
 * Checks projectConfig first (raw project-level config before OC runtime defaults)
 * then falls back to the typed fields that DO expose mcp (none in GatewayConfig's
 * declared type, so we cast to unknown).
 */
function isPlaudConfigured(
  gatewayConfig: ReturnType<typeof useConfigStore.getState>['gatewayConfig'],
): boolean {
  if (!gatewayConfig) return false;

  // projectConfig is Record<string,unknown> — raw config object from config.get
  const projectCfg = gatewayConfig.projectConfig as Record<string, unknown> | null;
  if (projectCfg) {
    const mcp = projectCfg.mcp as Record<string, unknown> | undefined;
    if (mcp?.servers && typeof mcp.servers === 'object') {
      return 'plaud' in (mcp.servers as object);
    }
  }

  // Fallback: check raw string for "plaud" key (cheap heuristic when projectConfig absent)
  if (gatewayConfig.raw && gatewayConfig.raw.includes('"plaud"')) {
    return true;
  }

  return false;
}

// ── PlaudStatus type ──────────────────────────────────────────────────────────
interface PlaudStatus {
  tokenPresent: boolean;
  account?: string;
  toolsReady?: boolean;
  lastError?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PlaudCard() {
  const { t } = useTranslation();
  const theme = useConfigStore((s) => s.theme);
  const tokens = getThemeTokens(theme);
  const gatewayConfig = useConfigStore((s) => s.gatewayConfig);
  const unavailable = usePeripheralsStore((s) => s.unavailable);
  const devices = usePeripheralsStore((s) => s.devices);
  const createDevice = usePeripheralsStore((s) => s.createDevice);
  const plaudStatus = usePeripheralsStore((s) => s.plaudStatus);
  const plaudLogin = usePeripheralsStore((s) => s.plaudLogin);
  const client = useGatewayStore((s) => s.client);
  const setChatInputPrefill = useUiStore((s) => s.setChatInputPrefill);

  const loadGatewayConfig = useConfigStore((s) => s.loadGatewayConfig);

  const [status, setStatus] = useState<PlaudStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  // Optimistic override: config.patch triggers a gateway restart, so a fresh
  // config.get may lag behind the write. Once writeConfig succeeds we know the
  // mcp.servers.plaud key was accepted — flip this true so the card leaves the
  // "connect" branch immediately instead of waiting for the reload round-trip.
  const [configuredOverride, setConfiguredOverride] = useState(false);

  // Derived: is Plaud configured (mcp.servers.plaud exists in config)?
  const configured = configuredOverride || isPlaudConfigured(gatewayConfig);

  // ── Mount: load status once ─────────────────────────────────────────────────
  useEffect(() => {
    if (unavailable) return;
    void (async () => {
      const s = await plaudStatus();
      setStatus(s);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** Write mcp.servers.plaud to gateway config via config.get → config.patch */
  const writeConfig = useCallback(async (): Promise<boolean> => {
    if (!client?.isConnected) return false;
    try {
      const snapshot = await client.request<{ hash?: string }>('config.get', {});
      const baseHash = snapshot.hash ?? undefined;
      // OC 2026.6.1 validates the full merged config on config.patch and rejects
      // the RC-only `plugins.installs` key. Strip it in the same patch; run.sh's
      // ensure-config re-adds it on the next startup.
      // (house pattern mirrored from stores/extensions.ts:316-329)
      const patch = {
        mcp: {
          servers: {
            plaud: {
              command: 'npx',
              args: ['-y', PLAUD_MCP_ARG],
            },
          },
        },
        plugins: { installs: null },
      };
      await client.request('config.patch', {
        raw: JSON.stringify(patch),
        ...(baseHash ? { baseHash } : {}),
        note: 'Connect Plaud MCP server',
      });
      // Reflect the write immediately (optimistic) and refresh the config store
      // so `configured` flips true once the gateway settles — otherwise the card
      // stays on the "连接 Plaud" main button even after a successful connect.
      setConfiguredOverride(true);
      void loadGatewayConfig();
      return true;
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, [client, loadGatewayConfig]);

  /** Run plaudLogin and, on success, createDevice (idempotent) */
  const doLoginAndRegister = useCallback(async () => {
    setLocalError(null);
    const loginResult = await plaudLogin();
    if (!loginResult.ok) {
      setLocalError(loginResult.error ?? t('periph.plaud.loginFailed', 'Login failed'));
      return;
    }

    // createDevice — idempotent: skip if plaud device already exists
    const alreadyExists = devices.some((d) => d.id === 'plaud' || d.driver === 'mcp-plaud');
    if (!alreadyExists) {
      await createDevice({
        id: 'plaud',
        name: 'Plaud 录音笔',
        kind: 'audio-recorder',
        driver: 'mcp-plaud',
      });
    }

    // Refresh status
    const fresh = await plaudStatus();
    setStatus(fresh);
  }, [plaudLogin, plaudStatus, createDevice, devices, t]);

  // ── Action handlers ──────────────────────────────────────────────────────────

  /** Connect button: config.patch → login → createDevice */
  const handleConnect = useCallback(async () => {
    setBusy(true);
    try {
      const ok = await writeConfig();
      if (!ok) return;
      await doLoginAndRegister();
    } finally {
      setBusy(false);
    }
  }, [writeConfig, doLoginAndRegister]);

  /** Login button (already configured, not yet logged in) */
  const handleLogin = useCallback(async () => {
    setBusy(true);
    try {
      await doLoginAndRegister();
    } finally {
      setBusy(false);
    }
  }, [doLoginAndRegister]);

  /** Retry button */
  const handleRetry = handleLogin;

  // ── Chip click: prefill chat input ──────────────────────────────────────────
  const handleChip = useCallback(
    (fallback: string) => {
      setChatInputPrefill(fallback);
    },
    [setChatInputPrefill],
  );

  // ── Determine display state ──────────────────────────────────────────────────
  const hasError = localError || status?.lastError;
  const isConnected = !hasError && configured && status?.tokenPresent === true;
  const isConfiguredNotLoggedIn = !hasError && configured && status !== null && !status.tokenPresent;

  // Status strip color
  let stripColor = STATUS_COLOR.unconfigured;
  if (unavailable || hasError) stripColor = STATUS_COLOR.error;
  else if (isConnected) stripColor = STATUS_COLOR.connected;
  else if (isConfiguredNotLoggedIn) stripColor = STATUS_COLOR.configured;

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        border: `1px solid ${tokens.border.default}`,
        borderRadius: 8,
        overflow: 'hidden',
        background: tokens.bg.surface,
      }}
    >
      {/* Status color strip */}
      <div
        data-testid="plaud-status-strip"
        data-status={stripColor}
        style={{
          height: 4,
          background: stripColor,
          transition: 'background 0.3s',
        }}
      />

      {/* Card body */}
      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <AudioOutlined style={{ fontSize: 18, color: tokens.accent?.blue ?? '#3B82F6', flexShrink: 0 }} />
          <Text strong style={{ fontSize: 14, color: tokens.text.primary, flex: 1 }}>
            {t('periph.plaud.title', 'Plaud 录音笔')}
          </Text>
        </div>

        {/* ── Unavailable banner ─────────────────────────────────────── */}
        {unavailable && (
          <Alert
            data-testid="plaud-unavailable-banner"
            type="error"
            showIcon
            message={t('periph.plaud.pluginOutdated', '插件版本过旧,请更新 Research-Claw')}
            style={{ borderRadius: 6 }}
          />
        )}

        {/* ── Error state ─────────────────────────────────────────────── */}
        {!unavailable && hasError && (
          <>
            <div data-testid="plaud-error-msg">
              <Text style={{ fontSize: 12, color: tokens.accent?.red ?? '#EF4444' }}>
                {localError || status?.lastError}
              </Text>
            </div>
            <Button
              data-testid="plaud-retry-btn"
              size="small"
              icon={<ReloadOutlined />}
              loading={busy}
              onClick={handleRetry}
              style={{ alignSelf: 'flex-start' }}
            >
              {t('periph.plaud.retry', '重试')}
            </Button>
          </>
        )}

        {/* ── Connected state ──────────────────────────────────────────── */}
        {!unavailable && !hasError && isConnected && (
          <>
            {/* Account + tools badge */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Text
                data-testid="plaud-account-label"
                style={{ fontSize: 12, color: tokens.text.secondary }}
              >
                {status?.account ?? t('periph.plaud.accountUnknown', '已登录')}
              </Text>
              <Tag
                data-testid="plaud-tools-badge"
                color="blue"
                style={{ fontSize: 11, borderRadius: 4 }}
              >
                {t('periph.plaud.toolsBadge', '7 个工具已就绪,下一次对话生效')}
              </Tag>
            </div>

            {/* Quick-action chips */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {QUICK_CHIPS.map((chip) => (
                <Button
                  key={chip.id}
                  data-testid={`plaud-chip-${chip.id}`}
                  size="small"
                  type="default"
                  onClick={() => handleChip(t(chip.textKey, chip.fallback))}
                  style={{ fontSize: 11, borderRadius: 20, color: tokens.text.secondary }}
                >
                  {t(chip.textKey, chip.fallback)}
                </Button>
              ))}
            </div>
          </>
        )}

        {/* ── Configured but not logged in ─────────────────────────────── */}
        {!unavailable && !hasError && isConfiguredNotLoggedIn && (
          <>
            <Text style={{ fontSize: 12, color: tokens.text.secondary }}>
              {t('periph.plaud.loginHint', '已配置 Plaud MCP,请登录账号后开始使用')}
            </Text>
            <Button
              data-testid="plaud-login-btn"
              type="primary"
              loading={busy}
              size="small"
              onClick={handleLogin}
              style={{ alignSelf: 'flex-start', background: tokens.accent?.blue ?? '#3B82F6', borderColor: tokens.accent?.blue ?? '#3B82F6' }}
            >
              {t('periph.plaud.login', '登录 Plaud')}
            </Button>
          </>
        )}

        {/* ── Not configured ────────────────────────────────────────────── */}
        {!unavailable && !hasError && !configured && (
          <>
            <Text style={{ fontSize: 12, color: tokens.text.secondary }}>
              {t('periph.plaud.valueHint', '连接 Plaud 录音笔,在对话中直接转录、汇总录音内容')}
            </Text>
            <Button
              data-testid="plaud-connect-btn"
              type="primary"
              loading={busy}
              size="small"
              onClick={handleConnect}
              style={{ alignSelf: 'flex-start', background: tokens.accent?.red ?? '#EF4444', borderColor: tokens.accent?.red ?? '#EF4444' }}
            >
              {t('periph.plaud.connect', '连接 Plaud')}
            </Button>
            <Text style={{ fontSize: 11, color: tokens.text.muted }}>
              {t('periph.plaud.connectHint', '将在浏览器中打开 Plaud 授权页')}
            </Text>
          </>
        )}
      </div>
    </div>
  );
}
