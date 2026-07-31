import React, { useEffect, useCallback, Suspense, useState } from 'react';
import { App as AntdApp, ConfigProvider, Spin, Result, Button, Input, Space, Typography } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import enUS from 'antd/locale/en_US';
import { useTranslation } from 'react-i18next';
import { buildAppShellGrid, buildOverlayPanelLayout } from './utils/config-panel-layout';
import { getAntdThemeConfig } from './styles/theme';
import { useConfigStore } from './stores/config';
import { useGatewayStore } from './stores/gateway';
import { useChatStore } from './stores/chat';
import { useUiStore, type PanelTab } from './stores/ui';
import { useSessionsStore, MAIN_SESSION_KEY } from './stores/sessions';
import { useOnboardingStore } from './stores/onboarding';
import ErrorBoundary from './components/ErrorBoundary';
import TopBar from './components/TopBar';
import LeftNav from './components/LeftNav';
import ChatView from './components/chat/ChatView';
import RightPanel from './components/RightPanel';
import StatusBar from './components/StatusBar';
import SetupWizard from './components/setup/SetupWizard';
import CronEventListener from './components/CronEventListener';
import PaperReviewRunListener from './components/PaperReviewRunListener';
import ConfigRestartListener from './components/ConfigRestartListener';
import ModelCatalogAligner from './components/ModelCatalogAligner';
import JobsActivityListener from './components/JobsActivityListener';
import PeriphCaptureListener from './components/PeriphCaptureListener';
import PluginApprovalListener from './components/PluginApprovalListener';
import SupervisorReviewListener from './components/SupervisorReviewListener';
import type { ChatStreamEvent } from './gateway/types';
import { useToolStreamStore } from './stores/tool-stream';
import { useStagedWritingStore } from './stores/staged-writing';
import { useSessionRunsStore } from './stores/session-runs';
import { normalizeSessionKey } from './utils/session-key';
import { resolveObservedRunActivity } from './utils/run-status-presentation';

/** Derive WebSocket URL from page origin so Docker port mapping always works.
 *  When served by the gateway (port 28789), origin already points to gateway.
 *  When served by Vite dev server (different port), fall back to default gateway address. */
const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL ??
  (window.location.port && window.location.port !== '28789'
    ? 'ws://127.0.0.1:28789'
    : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`);

/** Default token for local deployment (matches OPENCLAW_GATEWAY_TOKEN default in run.sh) */
const DEFAULT_TOKEN = 'research-claw';
const TOKEN_STORAGE_KEY = 'rc-gateway-token';

/** Read gateway token: URL param > localStorage (remote users) > hardcoded default */
function getGatewayToken(): string {
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');
  if (urlToken) return urlToken;
  try {
    const stored = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (stored) return stored;
  } catch { /* non-fatal */ }
  return DEFAULT_TOKEN;
}

const BP_MOBILE = 1024;
const BP_TABLET = 1440;

/** Timeout (ms) before showing "gateway unreachable" */
const BOOT_TIMEOUT_MS = 10_000;

type PanelMode = 'inline' | 'overlay' | 'modal';

function usePanelMode(): PanelMode {
  const [mode, setMode] = useState<PanelMode>(() => {
    const w = window.innerWidth;
    if (w >= BP_TABLET) return 'inline';
    if (w >= BP_MOBILE) return 'overlay';
    return 'modal';
  });

  useEffect(() => {
    const handler = () => {
      const w = window.innerWidth;
      if (w >= BP_TABLET) setMode('inline');
      else if (w >= BP_MOBILE) setMode('overlay');
      else setMode('modal');
    };
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  return mode;
}

const PANEL_TAB_ORDER: PanelTab[] = ['library', 'workspace', 'review', 'tasks', 'monitor', 'supervisor', 'extensions', 'settings'];

export default function App() {
  const { t } = useTranslation();
  const theme = useConfigStore((s) => s.theme);
  const locale = useConfigStore((s) => s.locale);
  const bootState = useConfigStore((s) => s.bootState);
  const loadConfig = useConfigStore((s) => s.loadConfig);
  const setBootState = useConfigStore((s) => s.setBootState);
  const connect = useGatewayStore((s) => s.connect);
  const client = useGatewayStore((s) => s.client);
  const connState = useGatewayStore((s) => s.state);
  const connectError = useGatewayStore((s) => s.connectError);
  const handleChatEvent = useChatStore((s) => s.handleChatEvent);
  const loadHistory = useChatStore((s) => s.loadHistory);
  const leftNavCollapsed = useUiStore((s) => s.leftNavCollapsed);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const rightPanelWidth = useUiStore((s) => s.rightPanelWidth);
  const configPanelHeight = useUiStore((s) => s.configPanelHeight);
  const configPanelPlacement = useUiStore((s) => s.configPanelPlacement);
  const setRightPanelTab = useUiStore((s) => s.setRightPanelTab);
  const setRightPanelOpen = useUiStore((s) => s.setRightPanelOpen);
  const setLeftNavCollapsed = useUiStore((s) => s.setLeftNavCollapsed);

  const panelMode = usePanelMode();

  // Load persisted UI config (theme/locale) on mount
  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // Always connect to gateway on mount
  useEffect(() => {
    connect(GATEWAY_URL, getGatewayToken());
  }, [connect]);

  // Persist token on successful connection (remote users don't re-enter on next visit)
  useEffect(() => {
    if (connState === 'connected') {
      const token = getGatewayToken();
      try {
        if (token !== DEFAULT_TOKEN) {
          localStorage.setItem(TOKEN_STORAGE_KEY, token);
        } else {
          // Using default — clear any stale custom token
          localStorage.removeItem(TOKEN_STORAGE_KEY);
        }
      } catch { /* non-fatal */ }
    }
  }, [connState]);

  // Boot timeout: if still pending after 10s and not connected, show unreachable
  useEffect(() => {
    if (bootState !== 'pending') return;
    const timer = setTimeout(() => {
      const { bootState: current } = useConfigStore.getState();
      const { state } = useGatewayStore.getState();
      if (current === 'pending' && state !== 'connected') {
        setBootState('gateway_unreachable');
      }
    }, BOOT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [bootState, setBootState]);

  // Expose gateway client for console smoke tests (e.g. SMOKE-TEST-CRON-NOTIFICATION.md).
  // RC is a local-only tool — no security concern exposing the client on window.
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__RC_CLIENT__ = client;
  }, [client]);

  // Subscribe to chat events
  useEffect(() => {
    if (!client) return;

    const unsubChat = client.subscribe('chat', (payload) => {
      const event = payload as ChatStreamEvent;
      const chatBeforeEvent = useChatStore.getState();
      if (event.sessionKey && event.state === 'delta') {
        useSessionRunsStore.getState().observeActivity({
          sessionKey: event.sessionKey,
          runId: event.runId,
          kind: 'streaming',
          label: 'streaming',
          observedAt: Date.now(),
          source: 'chat-event',
        });
      }
      handleChatEvent(event);
      // Clear foreground tool stream when a run completes
      if (
        normalizeSessionKey(event.sessionKey) === normalizeSessionKey(chatBeforeEvent.sessionKey)
        && (!event.runId || !chatBeforeEvent.runId || event.runId === chatBeforeEvent.runId)
        && (event.state === 'final' || event.state === 'aborted' || event.state === 'error')
      ) {
        useToolStreamStore.setState({ pendingTools: [] });
      }
    });

    const handleAgentPayload = (payload: unknown) => {
      const status = payload as {
        runId?: string;
        sessionKey?: string;
        state?: string;
        stream?: string;
        data?: { phase?: string; name?: string; toolName?: string };
      };

      if (status.stream === 'compaction' && status.data?.phase) {
        useChatStore.getState().handleCompactionAgentEvent(status);
      } else if (
        status.stream === 'lifecycle'
        && status.data?.phase === 'error'
      ) {
        useChatStore.getState().handleAgentFailureEvent(status);
      } else if (status.stream === 'error') {
        useChatStore.getState().handleAgentFailureEvent(status);
      }
      if (status.sessionKey) {
        const activity = resolveObservedRunActivity(status);
        useSessionRunsStore.getState().observeActivity({
          sessionKey: status.sessionKey,
          runId: status.runId,
          kind: activity.kind,
          label: activity.label,
          observedAt: Date.now(),
          source: status.stream === 'tool' ? 'tool-event' : 'agent-event',
        });
      }
      // Feed tool stream store for P1-2 (inline tool display) and P1-3 (bg activity)
      const chatRunId = useChatStore.getState().runId;
      const activeSessionKey = useChatStore.getState().sessionKey;
      useToolStreamStore.getState().handleAgentEvent(payload, chatRunId, activeSessionKey);
    };

    const unsubAgent = client.subscribe('agent', handleAgentPayload);
    // session.tool mirrors tool events to late-joining operator UIs (reconnect scenario).
    // Source: openclaw/src/gateway/server-chat.ts:747-751
    const unsubSessionTool = client.subscribe('session.tool', handleAgentPayload);

    return () => {
      unsubChat();
      unsubAgent();
      unsubSessionTool();
    };
  }, [client, handleChatEvent]);

  // On connection: restore persisted session, load history + session list + check notifications
  useEffect(() => {
    if (connState === 'connected') {
      // Sync chat store's sessionKey with the persisted active session
      const persistedKey = useSessionsStore.getState().activeSessionKey;
      if (persistedKey && persistedKey !== MAIN_SESSION_KEY) {
        useChatStore.getState().setSessionKey(persistedKey);
      }
      const historyPromise = loadHistory();
      const sessionsPromise = useSessionsStore.getState().loadSessions();
      // First-run probe runs in parallel; the welcome decision needs history +
      // sessions resolved too, so it waits for all three (fail-safe on errors).
      const onboardingPromise = useOnboardingStore.getState().fetchStatus();
      void Promise.all([historyPromise, sessionsPromise, onboardingPromise]).then(() => {
        useOnboardingStore.getState().markProbesReady();
      });
      // Initial notification check
      useUiStore.getState().checkNotifications();
      void useStagedWritingStore.getState().restoreJob();
    }
  }, [connState, loadHistory]);

  // Load session usage once boot completes (after config.get finishes).
  // Deferred from connection effect to avoid competing with the critical config.get RPC.
  useEffect(() => {
    if (bootState === 'ready' && connState === 'connected') {
      useChatStore.getState().loadSessionUsage();
    }
  }, [bootState, connState]);

  // First-run welcome: decide only after boot probes resolved AND the app shell
  // is up (if the setup wizard is showing, this defers until bootState turns ready).
  const onboardingProbesReady = useOnboardingStore((s) => s.probesReady);
  useEffect(() => {
    if (bootState === 'ready' && connState === 'connected' && onboardingProbesReady) {
      useOnboardingStore.getState().maybeShowWelcome();
    }
  }, [bootState, connState, onboardingProbesReady]);

  // Page visibility resume: check tick liveness to detect zombie connections.
  // Chrome throttles background tab timers to ≥1min, so the tick watchdog
  // interval may not fire in time. On tab resume, immediately check whether
  // the last tick is stale and force reconnect if so.
  //
  // Layer 1 fix (#33): when connection is alive (background < 60s), still
  // refresh messages — events may have been dropped by session-key filters
  // or lost during browser JS throttling. 5s debounce prevents RPC spam
  // from rapid tab switching.
  useEffect(() => {
    let lastVisibilitySyncAt = 0;
    const VISIBILITY_SYNC_DEBOUNCE_MS = 5_000;

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      const { client: c } = useGatewayStore.getState();
      const wasStale = c?.checkTickLiveness(); // closes socket + triggers reconnect if stale

      // If connection is alive, proactively sync current session messages.
      // The reconnect path (wasStale=true) already calls loadHistory via onHello.
      if (!wasStale && c?.isConnected) {
        const now = Date.now();
        if (now - lastVisibilitySyncAt >= VISIBILITY_SYNC_DEBOUNCE_MS) {
          lastVisibilitySyncAt = now;
          setTimeout(() => {
            useChatStore.getState().loadHistory();
            void useSessionRunsStore.getState().requestReconcile(
              useSessionsStore.getState().activeSessionKey,
              'visibility',
            );
          }, 300);
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  // Poll for deadline notifications every 60s while connected
  useEffect(() => {
    if (connState !== 'connected') return;
    const timer = setInterval(() => {
      useUiStore.getState().checkNotifications();
    }, 60_000);
    return () => clearInterval(timer);
  }, [connState]);

  // Responsive breakpoint listener
  const handleResize = useCallback(() => {
    const w = window.innerWidth;
    if (w < BP_MOBILE) {
      setLeftNavCollapsed(true);
      setRightPanelOpen(false);
    } else if (w < BP_TABLET) {
      setRightPanelOpen(false);
    }
  }, [setLeftNavCollapsed, setRightPanelOpen]);

  useEffect(() => {
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [handleResize]);

  // Keyboard shortcut: Ctrl+1-6 to switch panel tabs
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        const num = parseInt(e.key, 10);
        if (num >= 1 && num <= 7) {
          e.preventDefault();
          const tab = PANEL_TAB_ORDER[num - 1];
          setRightPanelTab(tab);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setRightPanelTab]);

  const antdTheme = getAntdThemeConfig(theme);
  const antdLocale = locale === 'zh-CN' ? zhCN : enUS;

  // --- Boot state guards ---

  if (bootState === 'pending') {
    return (
      <ConfigProvider theme={antdTheme} locale={antdLocale}>
        <AntdApp>
          <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', gap: 16 }}>
            <Spin size="large" />
            <span style={{ color: 'var(--text-secondary)', fontSize: 14 }}>{t('boot.connecting')}</span>
          </div>
        </AntdApp>
      </ConfigProvider>
    );
  }

  if (bootState === 'gateway_unreachable') {
    return (
      <ConfigProvider theme={antdTheme} locale={antdLocale}>
        <AntdApp>
          <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
            <Result
              status="error"
              title={t('boot.gatewayUnreachable')}
              subTitle={connectError
                ? `${connectError.code}: ${connectError.message}`
                : t('boot.gatewayHint')}
              extra={
                <Button type="primary" onClick={() => { setBootState('pending'); connect(GATEWAY_URL, getGatewayToken()); }}>
                  {t('boot.retryConnect')}
                </Button>
              }
            />
          </div>
        </AntdApp>
      </ConfigProvider>
    );
  }

  if (bootState === 'needs_token') {
    // Clear stale cached token so we don't keep retrying a bad value
    try { localStorage.removeItem(TOKEN_STORAGE_KEY); } catch { /* non-fatal */ }
    return (
      <ConfigProvider theme={antdTheme} locale={antdLocale}>
        <AntdApp>
          <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
            <Result
              status="warning"
              title={t('boot.needsToken')}
              subTitle={connectError
                ? `${connectError.code}: ${connectError.message}`
                : t('boot.needsTokenHint')}
              extra={
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
                  <Space.Compact style={{ width: 360 }}>
                    <Input.Password
                      id="rc-token-input"
                      placeholder={t('boot.tokenPlaceholder')}
                      onPressEnter={(e) => {
                        // IME composition guard (CJK input). rc-input derives
                        // onPressEnter straight from keydown with no composition
                        // guard, and this handler navigates the whole page away —
                        // an Enter that merely confirms an IME candidate would
                        // discard whatever the user had typed so far.
                        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                        const val = (e.target as HTMLInputElement).value.trim();
                        if (val) {
                          window.location.href = `${window.location.pathname}?token=${encodeURIComponent(val)}`;
                        }
                      }}
                    />
                    <Button type="primary" onClick={() => {
                      const input = document.getElementById('rc-token-input') as HTMLInputElement;
                      const val = input?.value?.trim();
                      if (val) {
                        window.location.href = `${window.location.pathname}?token=${encodeURIComponent(val)}`;
                      }
                    }}>
                      {t('boot.connectWithToken')}
                    </Button>
                  </Space.Compact>
                  <Button
                    type="link"
                    onClick={() => {
                      window.location.href = `${window.location.pathname}?token=research-claw`;
                    }}
                  >
                    {t('boot.tryDefaultToken')}
                  </Button>
                  <Typography.Text type="secondary" style={{ maxWidth: 460, textAlign: 'left', fontSize: 12, lineHeight: 1.8, whiteSpace: 'pre-line' }}>
                    {t('boot.tokenGuide')}
                  </Typography.Text>
                  <div style={{ maxWidth: 460, width: '100%', borderTop: '1px solid var(--border, #333)', paddingTop: 16, marginTop: 4 }}>
                    <Typography.Text strong style={{ fontSize: 13 }}>
                      {t('boot.tokenFixTitle')}
                    </Typography.Text>
                    {[
                      { label: 'boot.tokenFixDocker', cmd: 'boot.tokenFixDockerCmd' },
                      { label: 'boot.tokenFixNative', cmd: 'boot.tokenFixNativeCmd' },
                      { label: 'boot.tokenFixSystemd', cmd: 'boot.tokenFixSystemdCmd' },
                    ].map(({ label, cmd }) => (
                      <div key={label} style={{ marginTop: 8 }}>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {t(label)}
                        </Typography.Text>
                        <Typography.Paragraph
                          code
                          copyable
                          style={{ marginTop: 4, marginBottom: 0, fontSize: 12 }}
                        >
                          {t(cmd)}
                        </Typography.Paragraph>
                      </div>
                    ))}
                  </div>
                </div>
              }
            />
          </div>
        </AntdApp>
      </ConfigProvider>
    );
  }

  if (bootState === 'needs_setup') {
    return (
      <ConfigProvider theme={antdTheme} locale={antdLocale}>
        <AntdApp>
          <SetupWizard />
        </AntdApp>
      </ConfigProvider>
    );
  }

  // bootState === 'ready'
  const leftNavWidth = leftNavCollapsed ? 56 : 240;
  const isInline = panelMode === 'inline';
  const showInlinePanel = isInline && rightPanelOpen;
  const showOverlayPanel = !isInline && rightPanelOpen;

  const shellGrid = buildAppShellGrid({
    leftNavWidth,
    placement: configPanelPlacement,
    panelOpen: showInlinePanel,
    panelWidth: rightPanelWidth,
    panelHeight: configPanelHeight,
  });

  const overlayLayout = showOverlayPanel
    ? buildOverlayPanelLayout({
        placement: configPanelPlacement,
        panelMode: panelMode === 'modal' ? 'modal' : 'overlay',
        leftNavWidth,
        panelWidth: rightPanelWidth,
        panelHeight: configPanelHeight,
      })
    : null;

  return (
    <ConfigProvider theme={antdTheme} locale={antdLocale}>
      <AntdApp>
      <CronEventListener />
      <PaperReviewRunListener />
      <ConfigRestartListener />
      <ModelCatalogAligner />
      <JobsActivityListener />
      <PeriphCaptureListener />
      <PluginApprovalListener />
      <SupervisorReviewListener />
      <div
        style={{
          height: '100vh',
          display: 'grid',
          gridTemplateRows: shellGrid.gridTemplateRows,
          gridTemplateColumns: shellGrid.gridTemplateColumns,
          gridTemplateAreas: shellGrid.gridTemplateAreas,
          background: 'var(--bg)',
          overflow: 'hidden',
        }}
      >
        <header style={{ gridArea: 'topbar' }}>
          <TopBar />
        </header>

        <aside
          role="navigation"
          aria-label={t('a11y.navigation')}
          style={{
            gridArea: 'leftnav',
            borderRight: '1px solid var(--border)',
            overflow: 'hidden',
            transition: 'width 0.2s ease',
          }}
        >
          <LeftNav />
        </aside>

        <main
          role="main"
          aria-label={t('a11y.mainContent')}
          style={{
            gridArea: shellGrid.chatGridArea,
            overflow: 'hidden',
            minHeight: 0,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <ErrorBoundary>
            <Suspense fallback={<Spin style={{ margin: 'auto', display: 'block', paddingTop: '40vh' }} />}>
              <div className="chat-view-host">
                <ChatView />
              </div>
            </Suspense>
          </ErrorBoundary>
        </main>

        <aside
          role="complementary"
          aria-label={t('a11y.sidePanel')}
          style={{
            gridArea: shellGrid.configGridArea,
            overflow: 'hidden',
            minHeight: 0,
            minWidth: 0,
            ...shellGrid.configBorderStyle,
          }}
        >
          {showInlinePanel && (
            <ErrorBoundary>
              <Suspense fallback={<Spin style={{ margin: 'auto', display: 'block', paddingTop: '40vh' }} />}>
                <RightPanel />
              </Suspense>
            </ErrorBoundary>
          )}
        </aside>

        <footer style={{ gridArea: 'statusbar', borderTop: '1px solid var(--border)' }}>
          <StatusBar />
        </footer>
      </div>

      {showOverlayPanel && overlayLayout && (
        <>
          <div
            aria-hidden="true"
            onClick={() => setRightPanelOpen(false)}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0, 0, 0, 0.5)',
              zIndex: 900,
            }}
          />
          <div
            role="complementary"
            aria-label={t('a11y.sidePanel')}
            style={{
              ...overlayLayout.style,
              animation: `${overlayLayout.animationName} 0.2s ease-out`,
            }}
          >
            <ErrorBoundary>
              <Suspense fallback={<Spin style={{ margin: 'auto', display: 'block', paddingTop: '40vh' }} />}>
                <RightPanel />
              </Suspense>
            </ErrorBoundary>
          </div>
          <style>{`
            @keyframes rcPanelSlideInRight {
              from { transform: translateX(100%); }
              to { transform: translateX(0); }
            }
            @keyframes rcPanelSlideInLeft {
              from { transform: translateX(-100%); }
              to { transform: translateX(0); }
            }
            @keyframes rcPanelSlideInTop {
              from { transform: translateY(-100%); }
              to { transform: translateY(0); }
            }
            @keyframes rcPanelSlideInBottom {
              from { transform: translateY(100%); }
              to { transform: translateY(0); }
            }
            @keyframes rcPanelFadeIn {
              from { opacity: 0; }
              to { opacity: 1; }
            }
          `}</style>
        </>
      )}
      </AntdApp>
    </ConfigProvider>
  );
}
