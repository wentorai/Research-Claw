/**
 * PlaudCard — Plaud 录音笔外设卡片 (Task 15)
 *
 * 三态卡（卡内展开模式，不弹详情页）:
 *   - 未配置:  灰色状态条 + "连接 Plaud" 红色主按钮
 *   - 已配置未登录: 蓝色状态条 + "登录 Plaud" 按钮
 *   - 登录中:  蓝色状态条 + "浏览器已打开授权页,等待完成…" + 〔取消〕按钮
 *             (T19 P-1: login 成功语义=token 已落盘;取消调 cancelLogin 回到可重试态)
 *   - 已连接:  绿色状态条 + 账号 + 工具徽标 + 快捷 chips
 *   - 错误态:  红色状态条 + 错误信息 + "重试" 按钮
 *             (login-in-progress → "上一次登录仍在进行,可点取消后重试")
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

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Popconfirm, Tag, Typography } from 'antd';
import { AudioOutlined, DisconnectOutlined, ReloadOutlined, ScheduleOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { getThemeTokens } from '../../styles/theme';
import { useConfigStore } from '../../stores/config';
import { usePeripheralsStore } from '../../stores/peripherals';
import { useMonitorStore } from '../../stores/monitor';
import { useGatewayStore } from '../../stores/gateway';
import { useUiStore } from '../../stores/ui';
import DeviceMonitors from './DeviceMonitors';

const { Text } = Typography;

// ── MCP Plaud package version pinned here ─────────────────────────────────────
const PLAUD_MCP_VERSION = '0.3.5';
const PLAUD_MCP_ARG = `@plaud-ai/mcp@${PLAUD_MCP_VERSION}`;

// ── Registered plaud device id (matches doLoginAndRegister createDevice) ──────
const PLAUD_DEVICE_ID = 'plaud';

// ── Daily recording report cron: 22:00 every day (F4 / P1-B1) ─────────────────
const PLAUD_DAILY_REPORT_SCHEDULE = '0 22 * * *';

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
  /** P1-U4: gateway-reported Docker runtime (browser OAuth login unsupported). */
  docker?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PlaudCard() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const theme = useConfigStore((s) => s.theme);
  const tokens = getThemeTokens(theme);
  const gatewayConfig = useConfigStore((s) => s.gatewayConfig);
  const unavailable = usePeripheralsStore((s) => s.unavailable);
  const devices = usePeripheralsStore((s) => s.devices);
  const createDevice = usePeripheralsStore((s) => s.createDevice);
  const plaudStatus = usePeripheralsStore((s) => s.plaudStatus);
  const plaudLogin = usePeripheralsStore((s) => s.plaudLogin);
  const plaudCancelLogin = usePeripheralsStore((s) => s.plaudCancelLogin);
  const createMonitor = useMonitorStore((s) => s.createMonitor);
  const toggleMonitor = useMonitorStore((s) => s.toggleMonitor);
  // Count of device monitors already bound to the plaud device — drives whether
  // the DeviceMonitors panel shows even before the user creates one this session.
  const plaudMonitorCount = useMonitorStore(
    (s) => s.monitors.filter((m) => m.source_type === 'device' && m.target === PLAUD_DEVICE_ID).length,
  );
  const client = useGatewayStore((s) => s.client);
  const setChatInputPrefill = useUiStore((s) => s.setChatInputPrefill);

  const loadGatewayConfig = useConfigStore((s) => s.loadGatewayConfig);

  const [status, setStatus] = useState<PlaudStatus | null>(null);
  // `status === null` is ambiguous on its own: plaudStatus() folds BOTH "gateway
  // not connected yet" and "the RPC was rejected/timed out" into null. Splitting
  // "not fetched yet" (statusLoaded=false) from "fetched and it failed"
  // (statusLoaded=true && status===null) is what lets the card (a) keep the
  // P1-U4 Docker guard armed during the resolve window and (b) render an
  // explicit unknown state instead of a blank card.
  const [statusLoaded, setStatusLoaded] = useState(false);
  // Monotonic generation counter for status fetches. Two fetches can be in
  // flight at once (mount snapshot vs post-login refresh, or two retries), each
  // backed by an independent `npx` child process gateway-side — their return
  // order is NOT the call order. Only the newest generation may write state.
  const statusSeq = useRef(0);
  const [busy, setBusy] = useState(false);
  // True while a login is actually in flight (browser OAuth page open, gateway
  // polling for the token). Distinct from `busy`, which also covers the brief
  // config.patch phase; `loggingIn` gates the "waiting…" hint + Cancel button.
  const [loggingIn, setLoggingIn] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  // Optimistic override: config.patch triggers a gateway restart, so a fresh
  // config.get may lag behind the write. Once writeConfig succeeds we know the
  // mcp.servers.plaud key was accepted — flip this true so the card leaves the
  // "connect" branch immediately instead of waiting for the reload round-trip.
  const [configuredOverride, setConfiguredOverride] = useState(false);
  // Set false optimistically on disconnect so the card returns to the
  // unconfigured branch immediately, overriding the stale config.get snapshot.
  const [disconnectedOverride, setDisconnectedOverride] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  // F4 / P1-B1: whether the "daily recording report" monitor section is expanded.
  const [showReport, setShowReport] = useState(false);
  const [creatingReport, setCreatingReport] = useState(false);

  // Derived: is Plaud configured (mcp.servers.plaud exists in config)?
  const configured =
    !disconnectedOverride && (configuredOverride || isPlaudConfigured(gatewayConfig));

  // P1-U4: Docker degradation. The gateway reports docker on the plaud status
  // response (see stores/peripherals.ts). In a container the browser OAuth login
  // (spawn npx → open browser) cannot work, so we grey out the connect button
  // and never enter the writeConfig/spawn path.
  const docker = status?.docker === true;

  // Status is only actionable once a fetch has COMPLETED and returned a payload.
  // While it is unresolved the gateway's docker flag is unknown, and `docker`
  // above reads false — so any action gated on `!docker` alone would slip
  // through the P1-U4 guard. Unknown ⇒ block.
  const statusReady = statusLoaded && status !== null;

  /**
   * Fetch status under a generation guard. Late responses from superseded
   * generations are dropped instead of clobbering newer state (this also makes
   * the call safe after unmount — a stale generation simply never writes).
   */
  const refreshStatus = useCallback(async () => {
    const seq = ++statusSeq.current;
    const s = await plaudStatus();
    if (seq !== statusSeq.current) return; // superseded by a newer fetch
    setStatus(s);
    setStatusLoaded(true);
  }, [plaudStatus]);

  // ── Mount: load status once ─────────────────────────────────────────────────
  useEffect(() => {
    if (unavailable) return;
    void refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Patch mcp.servers.plaud via config.get → config.patch.
   *   remove=false → write the npx server spec (Connect)
   *   remove=true  → set mcp.servers.plaud=null (Disconnect)
   *
   * Both paths must strip the RC-only `plugins.installs` key: OC 2026.6.1
   * validates the full merged config on config.patch and rejects it. run.sh's
   * ensure-config re-adds it on the next startup.
   * (house pattern mirrored from stores/extensions.ts:316-329)
   */
  const patchPlaudServer = useCallback(async (remove: boolean): Promise<boolean> => {
    if (!client?.isConnected) return false;
    try {
      const snapshot = await client.request<{ hash?: string }>('config.get', {});
      const baseHash = snapshot.hash ?? undefined;
      const patch = {
        mcp: {
          servers: {
            plaud: remove
              ? null
              : { command: 'npx', args: ['-y', PLAUD_MCP_ARG] },
          },
        },
        plugins: { installs: null },
      };
      await client.request('config.patch', {
        raw: JSON.stringify(patch),
        ...(baseHash ? { baseHash } : {}),
        note: remove ? 'Disconnect Plaud MCP server' : 'Connect Plaud MCP server',
      });
      void loadGatewayConfig();
      return true;
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, [client, loadGatewayConfig]);

  /**
   * Run plaudLogin and, on success (= token persisted), createDevice (idempotent).
   * Returns true iff the login resolved ok (token landed). Callers gate the
   * config write on this so a failed/cancelled login never leaves config behind.
   */
  const doLoginAndRegister = useCallback(async (): Promise<boolean> => {
    setLocalError(null);
    setLoggingIn(true);
    let loginResult: { ok: boolean; error?: string };
    try {
      loginResult = await plaudLogin();
    } finally {
      setLoggingIn(false);
    }

    if (!loginResult.ok) {
      // User cancelled — return to a clean retriable state, no error banner.
      if (loginResult.error === 'login-cancelled') return false;
      // A previous login is still running (its process group holds port 8199).
      // Surface a distinct hint so the user knows to cancel-then-retry.
      if (loginResult.error === 'login-in-progress') {
        setLocalError(
          t('periph.plaud.loginInProgress', '上一次登录仍在进行,可点取消后重试'),
        );
        return false;
      }
      setLocalError(loginResult.error ?? t('periph.plaud.loginFailed', 'Login failed'));
      return false;
    }

    // login ok ⇒ token is persisted. createDevice — idempotent: skip if a plaud
    // device already exists. This must stay AFTER login ok so we never register
    // a device before the token has landed (T19 P-1).
    const alreadyExists = devices.some((d) => d.id === PLAUD_DEVICE_ID || d.driver === 'mcp-plaud');
    if (!alreadyExists) {
      await createDevice({
        id: PLAUD_DEVICE_ID,
        name: 'Plaud 录音笔',
        kind: 'audio-recorder',
        driver: 'mcp-plaud',
      });
    }

    // Refresh status (generation-guarded — a slow mount/retry fetch still in
    // flight must not overwrite this post-login snapshot).
    await refreshStatus();
    return true;
  }, [plaudLogin, refreshStatus, createDevice, devices, t]);

  /** Cancel an in-flight login: kill the gateway login (frees port 8199) → retriable. */
  const handleCancelLogin = useCallback(async () => {
    await plaudCancelLogin();
    // plaudLogin will resolve {ok:false, error:'login-cancelled'} on its own; the
    // finally in doLoginAndRegister clears loggingIn. Reset local error so the
    // card returns to a clean retriable state rather than showing "cancelled".
    setLocalError(null);
    setLoggingIn(false);
  }, [plaudCancelLogin]);

  // ── Action handlers ──────────────────────────────────────────────────────────

  /**
   * Connect button: login → (on success) write config → createDevice.
   *
   * P1-U3: the OAuth login (plaud.ts:279-285) spawns its own `npx @plaud-ai/mcp`
   * child and polls ~/.plaud/tokens-mcp.json (plaud.ts:208-247); it does NOT read
   * mcp.servers.plaud runtime config, so login works BEFORE the server is
   * configured. We therefore run login first and only writeConfig once the token
   * has landed (loginResult.ok) — a failed/cancelled login leaves no permanent
   * mcp.servers.plaud entry, so the user is never stranded in a half-connected
   * "configured but not logged in" state.
   */
  const handleConnect = useCallback(async () => {
    // P1-U4: never enter the spawn path inside a container — and never while
    // the container verdict is still unknown (unresolved/failed status).
    if (docker || !statusReady) return;
    setBusy(true);
    try {
      const loggedIn = await doLoginAndRegister();
      if (!loggedIn) return; // failed/cancelled login → no config written
      await patchPlaudServer(false);
      // Reflect the write immediately (optimistic) so the card leaves the
      // "connect" branch without waiting for the config.get reload round-trip.
      setDisconnectedOverride(false);
      setConfiguredOverride(true);
    } finally {
      setBusy(false);
    }
  }, [docker, statusReady, doLoginAndRegister, patchPlaudServer]);

  /**
   * Disconnect button (configured / connected state): remove mcp.servers.plaud
   * so the user can back out of a mistaken connect. Leaves the OAuth token file
   * alone (harmless; a re-connect reuses it) — this only removes the MCP server
   * wiring so the card returns to the unconfigured branch.
   */
  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      const ok = await patchPlaudServer(true);
      if (!ok) return;
      // Optimistic: drop back to the unconfigured branch immediately.
      setConfiguredOverride(false);
      setDisconnectedOverride(true);
      setShowReport(false);
    } finally {
      setDisconnecting(false);
    }
  }, [patchPlaudServer]);

  /** Login button (already configured, not yet logged in) */
  const handleLogin = useCallback(async () => {
    setBusy(true);
    try {
      await doLoginAndRegister();
    } finally {
      setBusy(false);
    }
  }, [doLoginAndRegister]);

  /**
   * Retry button. The error state is reachable from BOTH the unconfigured
   * connect flow and the configured login flow, so retry must mirror whichever
   * path is still incomplete: if mcp.servers.plaud was never written (config
   * missing), retry the full connect (login → writeConfig), otherwise just
   * re-login. Routing retry through handleLogin unconditionally left a
   * first-connect-failure→retry-success path where the token landed but the
   * config was never written — the card fell back to the "connect" branch
   * despite being logged in (the config-side mirror of the P1-U3 dead state).
   */
  const handleRetry = configured ? handleLogin : handleConnect;

  // ── Chip click: prefill chat input ──────────────────────────────────────────
  const handleChip = useCallback(
    (fallback: string) => {
      setChatInputPrefill(fallback);
    },
    [setChatInputPrefill],
  );

  // ── Daily recording report (F4 / P1-B1) ─────────────────────────────────────
  /**
   * Create a device monitor bound to the plaud device that runs the daily
   * recording report. Fields per SPEC:338-342,373:
   *   source_type='device', target=PLAUD_DEVICE_ID (registered plaud id),
   *   schedule='0 22 * * *', notify=true.
   * agent_prompt is left empty → the plugin's defaultAgentPrompt('device', ...)
   * branches on device.kind='audio-recorder' to inject the audio-recorder
   * template (plaud__list_files/get_transcript → summary → workspace_save →
   * send_notification), so no camera-frame protocol is used.
   */
  const handleCreateDailyReport = useCallback(async () => {
    setCreatingReport(true);
    try {
      const result = await createMonitor({
        name: t('periph.plaud.dailyReportName', 'Plaud 每日录音日报'),
        source_type: 'device',
        target: PLAUD_DEVICE_ID,
        schedule: PLAUD_DAILY_REPORT_SCHEDULE,
        // Audio has no visual check_prompt semantics — leave filters empty so the
        // plugin uses the audio-recorder default template verbatim.
        filters: {},
        agent_prompt: '',
        notify: true,
        enabled: false,
      });
      if (result) {
        // Create-then-enable: the dashboard is online at create time, so the
        // toggle path registers the cron job immediately (mirrors DeviceMonitors).
        const enabledResult = await toggleMonitor(result.id, true);
        const registered = useMonitorStore.getState().monitors
          .find((monitor) => monitor.id === result.id);
        if (!enabledResult.ok || !registered?.gateway_job_id) {
          message.error(
            t('periph.plaud.dailyReportRegistrationFailed', {
              reason: enabledResult.error ?? 'cron-add-missing-id',
              defaultValue: `Daily report was created, but cron registration failed: ${enabledResult.error ?? 'cron-add-missing-id'}`,
            }),
          );
          setShowReport(true);
          return;
        }
        message.success(
          t('periph.plaud.dailyReportCreated', {
            name: result.name,
            defaultValue: `已创建每日录音日报 —— "${result.name}" 每天 22:00 运行`,
          }),
        );
        setShowReport(true);
      }
    } finally {
      setCreatingReport(false);
    }
  }, [createMonitor, toggleMonitor, message, t]);

  // ── Determine display state ──────────────────────────────────────────────────
  const hasError = localError || status?.lastError;
  const isConnected = !hasError && configured && status?.tokenPresent === true;
  const isConfiguredNotLoggedIn = !hasError && configured && status !== null && !status.tokenPresent;

  // Status strip color
  let stripColor = STATUS_COLOR.unconfigured;
  if (unavailable || hasError) stripColor = STATUS_COLOR.error;
  else if (loggingIn) stripColor = STATUS_COLOR.configured; // blue while authorizing
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
          {/* P1: Plaud has no mainland-China edition — label the Global edition. */}
          <Tag data-testid="plaud-global-tag" color="blue" style={{ fontSize: 11, borderRadius: 4, marginInlineEnd: 0 }}>
            {t('periph.plaud.globalTag', '国际版')}
          </Tag>
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

        {/* ── Logging-in state (browser OAuth page open, gateway polling) ─ */}
        {!unavailable && !hasError && loggingIn && (
          <>
            <Text data-testid="plaud-logging-in-hint" style={{ fontSize: 12, color: tokens.text.secondary }}>
              {t('periph.plaud.loginWaiting', '浏览器已打开授权页,等待完成…')}
            </Text>
            <Button
              data-testid="plaud-cancel-login-btn"
              size="small"
              onClick={handleCancelLogin}
              style={{ alignSelf: 'flex-start' }}
            >
              {t('periph.plaud.cancelLogin', '取消')}
            </Button>
          </>
        )}

        {/* ── Error state ─────────────────────────────────────────────── */}
        {!unavailable && !loggingIn && hasError && (
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
        {!unavailable && !loggingIn && !hasError && isConnected && (
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

            {/* Quick-action chips + daily-report entry */}
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
              {/* F4 / P1-B1: create the daily recording-report device monitor. */}
              <Button
                data-testid="plaud-daily-report-btn"
                size="small"
                type="default"
                icon={<ScheduleOutlined />}
                loading={creatingReport}
                onClick={() => { void handleCreateDailyReport(); }}
                style={{ fontSize: 11, borderRadius: 20, color: tokens.text.secondary }}
              >
                {t('periph.plaud.dailyReport', '每日录音日报')}
              </Button>
            </div>

            {/* F4 / P1-B1: device monitors for the plaud device. Reuses the
                shared DeviceMonitors panel — audio has no visual check semantics,
                so checkPrompt is an empty string. Shown after a report is created
                (or when a monitor already exists). */}
            {(showReport || plaudMonitorCount > 0) && (
              <div data-testid="plaud-device-monitors">
                <DeviceMonitors deviceId={PLAUD_DEVICE_ID} checkPrompt="" />
              </div>
            )}

            {/* Disconnect (secondary) */}
            <Popconfirm
              title={t('periph.plaud.disconnectConfirm', '断开 Plaud?将移除 MCP 配置')}
              onConfirm={() => { void handleDisconnect(); }}
              okType="danger"
            >
              <Button
                data-testid="plaud-disconnect-btn"
                size="small"
                type="text"
                danger
                icon={<DisconnectOutlined />}
                loading={disconnecting}
                style={{ alignSelf: 'flex-start', fontSize: 11 }}
              >
                {t('periph.plaud.disconnect', '断开 Plaud')}
              </Button>
            </Popconfirm>
          </>
        )}

        {/* ── Configured but not logged in ─────────────────────────────── */}
        {!unavailable && !loggingIn && !hasError && isConfiguredNotLoggedIn && (
          <>
            <Text style={{ fontSize: 12, color: tokens.text.secondary }}>
              {t('periph.plaud.loginHint', '已配置 Plaud MCP,请登录账号后开始使用')}
            </Text>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Button
                data-testid="plaud-login-btn"
                type="primary"
                loading={busy}
                size="small"
                onClick={handleLogin}
                style={{ background: tokens.accent?.blue ?? '#3B82F6', borderColor: tokens.accent?.blue ?? '#3B82F6' }}
              >
                {t('periph.plaud.login', '登录 Plaud')}
              </Button>
              {/* P1-U3: exit route for the "configured but not logged in" dead end
                  (incl. legacy config-first users). */}
              <Popconfirm
                title={t('periph.plaud.disconnectConfirm', '断开 Plaud?将移除 MCP 配置')}
                onConfirm={() => { void handleDisconnect(); }}
                okType="danger"
              >
                <Button
                  data-testid="plaud-disconnect-btn"
                  size="small"
                  type="text"
                  danger
                  icon={<DisconnectOutlined />}
                  loading={disconnecting}
                  style={{ fontSize: 11 }}
                >
                  {t('periph.plaud.disconnect', '断开 Plaud')}
                </Button>
              </Popconfirm>
            </div>
          </>
        )}

        {/* ── Status unresolved / unknown ──────────────────────────────────
            Splits the two meanings that used to share `status === null`:
              • not fetched yet  → neutral "checking…" line
              • fetched, failed  → explicit unknown notice + retry exit
            Without this, `configured && status===null` fell through every
            branch and rendered a blank card with no way out. */}
        {!unavailable && !loggingIn && !hasError && !statusReady && (
          <>
            {statusLoaded ? (
              <>
                <Text
                  data-testid="plaud-status-unknown"
                  style={{ fontSize: 12, color: tokens.text.secondary }}
                >
                  {t('periph.plaud.statusUnknown', '暂时无法获取 Plaud 状态,请重试')}
                </Text>
                <Button
                  data-testid="plaud-status-retry-btn"
                  size="small"
                  icon={<ReloadOutlined />}
                  onClick={() => { void refreshStatus(); }}
                  style={{ alignSelf: 'flex-start' }}
                >
                  {t('periph.plaud.retry', '重试')}
                </Button>
              </>
            ) : (
              <Text
                data-testid="plaud-status-loading"
                style={{ fontSize: 12, color: tokens.text.muted }}
              >
                {t('periph.plaud.statusLoading', '正在获取 Plaud 状态…')}
              </Text>
            )}
          </>
        )}

        {/* ── Not configured ────────────────────────────────────────────── */}
        {!unavailable && !loggingIn && !hasError && !configured && (
          <>
            <Text style={{ fontSize: 12, color: tokens.text.secondary }}>
              {t('periph.plaud.valueHint', '连接 Plaud 录音笔,在对话中直接转录、汇总录音内容')}
              {' '}
              {t('periph.plaud.globalOnlyHint', '需要 Plaud 国际版账号(plaud.ai)')}
            </Text>
            {/* P1-U4: inside a container the browser OAuth login can't work — warn
                and disable the connect button so the user never enters the
                spawn/writeConfig path that would fail. */}
            {docker && (
              <Alert
                data-testid="plaud-docker-warning"
                type="warning"
                showIcon
                message={t('periph.plaud.dockerUnsupported', '容器内暂不支持浏览器登录')}
                style={{ borderRadius: 6, fontSize: 12 }}
              />
            )}
            {/* P1-U4: `!statusReady` means the gateway's docker verdict is still
                unknown (in flight, or the status RPC failed). Treat unknown as
                blocking — an enabled button here is exactly how a container user
                slipped into the login → spawn npx → open browser dead end. */}
            <Button
              data-testid="plaud-connect-btn"
              type="primary"
              loading={busy}
              disabled={docker || !statusReady}
              size="small"
              onClick={handleConnect}
              style={{ alignSelf: 'flex-start', background: docker || !statusReady ? undefined : (tokens.accent?.red ?? '#EF4444'), borderColor: docker || !statusReady ? undefined : (tokens.accent?.red ?? '#EF4444') }}
            >
              {t('periph.plaud.connect', '连接 Plaud')}
            </Button>
            {!docker && statusReady && (
              <Text style={{ fontSize: 11, color: tokens.text.muted }}>
                {t('periph.plaud.connectHint', '将在浏览器中打开 Plaud 授权页')}
              </Text>
            )}
          </>
        )}
      </div>
    </div>
  );
}
