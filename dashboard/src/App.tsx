import React, { useEffect, useCallback, Suspense, useState } from 'react';
import { App as AntdApp, ConfigProvider, Spin, Result, Button, Input, Space } from 'antd';
import { useTranslation } from 'react-i18next';
import { getAntdThemeConfig } from './styles/theme';
import { useConfigStore } from './stores/config';
import { useGatewayStore } from './stores/gateway';
import { useChatStore } from './stores/chat';
import { useUiStore, type PanelTab } from './stores/ui';
import { useSessionsStore, MAIN_SESSION_KEY } from './stores/sessions';
import ErrorBoundary from './components/ErrorBoundary';
import TopBar from './components/TopBar';
import LeftNav from './components/LeftNav';
import ChatView from './components/chat/ChatView';
import RightPanel from './components/RightPanel';
import StatusBar from './components/StatusBar';
import SetupWizard from './components/setup/SetupWizard';
import CronEventListener from './components/CronEventListener';
import ConfigRestartListener from './components/ConfigRestartListener';
import type { ChatStreamEvent } from './gateway/types';
import { useToolStreamStore } from './stores/tool-stream';

/** Derive WebSocket URL from page origin so Docker port mapping always works.
 *  When served by the gateway (port 28789), origin already points to gateway.
 *  When served by Vite dev server (different port), fall back to default gateway address. */
const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL ??
  (window.location.port && window.location.port !== '28789'
    ? 'ws://127.0.0.1:28789'
    : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`);

/** Default token for local Docker deployment */
const DEFAULT_TOKEN = 'research-claw';

/** Read gateway token: URL ?token=xxx overrides default */
function getGatewayToken(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('token') || DEFAULT_TOKEN;
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

const PANEL_TAB_ORDER: PanelTab[] = ['library', 'workspace', 'tasks', 'monitor', 'extensions', 'settings'];

export default function App() {
  const { t } = useTranslation();
  const theme = useConfigStore((s) => s.theme);
  const bootState = useConfigStore((s) => s.bootState);
  const loadConfig = useConfigStore((s) => s.loadConfig);
  const setBootState = useConfigStore((s) => s.setBootState);
  const connect = useGatewayStore((s) => s.connect);
  const client = useGatewayStore((s) => s.client);
  const connState = useGatewayStore((s) => s.state);
  const connectError = useGatewayStore((s) => s.connectError);
  const handleChatEvent = useChatStore((s) => s.handleChatEvent);
  const loadHistory = useChatStore((s) => s.loadHistory);
  const setAgentStatus = useUiStore((s) => s.setAgentStatus);
  const leftNavCollapsed = useUiStore((s) => s.leftNavCollapsed);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const rightPanelWidth = useUiStore((s) => s.rightPanelWidth);
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
      handleChatEvent(payload as ChatStreamEvent);
      // Clear foreground tool stream when a run completes
      const event = payload as ChatStreamEvent;
      if (event.state === 'final' || event.state === 'aborted' || event.state === 'error') {
        useToolStreamStore.setState({ pendingTools: [] });
      }
    });

    const handleAgentPayload = (payload: unknown) => {
      const status = payload as { state?: string };
      if (status.state) {
        setAgentStatus(status.state as 'idle' | 'thinking' | 'tool_running' | 'streaming' | 'error');
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
  }, [client, handleChatEvent, setAgentStatus]);

  // On connection: restore persisted session, load history + session list + check notifications
  useEffect(() => {
    if (connState === 'connected') {
      // Sync chat store's sessionKey with the persisted active session
      const persistedKey = useSessionsStore.getState().activeSessionKey;
      if (persistedKey && persistedKey !== MAIN_SESSION_KEY) {
        useChatStore.getState().setSessionKey(persistedKey);
      }
      loadHistory();
      useSessionsStore.getState().loadSessions();
      setAgentStatus('idle');
      // Initial notification check
      useUiStore.getState().checkNotifications();
    } else if (connState === 'disconnected' || connState === 'reconnecting') {
      setAgentStatus('disconnected');
    }
  }, [connState, loadHistory, setAgentStatus]);

  // Load session usage once boot completes (after config.get finishes).
  // Deferred from connection effect to avoid competing with the critical config.get RPC.
  useEffect(() => {
    if (bootState === 'ready' && connState === 'connected') {
      useChatStore.getState().loadSessionUsage();
    }
  }, [bootState, connState]);

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
        if (num >= 1 && num <= 6) {
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

  // --- Boot state guards ---

  if (bootState === 'pending') {
    return (
      <ConfigProvider theme={antdTheme}>
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
      <ConfigProvider theme={antdTheme}>
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
    return (
      <ConfigProvider theme={antdTheme}>
        <AntdApp>
          <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
            <Result
              status="warning"
              title={t('boot.needsToken')}
              subTitle={connectError
                ? `${connectError.code}: ${connectError.message}`
                : t('boot.needsTokenHint')}
              extra={
                <Space.Compact style={{ width: 360 }}>
                  <Input.Password
                    id="rc-token-input"
                    placeholder={t('boot.tokenPlaceholder')}
                    onPressEnter={(e) => {
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
              }
            />
          </div>
        </AntdApp>
      </ConfigProvider>
    );
  }

  if (bootState === 'needs_setup') {
    return (
      <ConfigProvider theme={antdTheme}>
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

  return (
    <ConfigProvider theme={antdTheme}>
      <AntdApp>
      <CronEventListener />
      <ConfigRestartListener />
      <div
        style={{
          height: '100vh',
          display: 'grid',
          gridTemplateRows: '48px 1fr 28px',
          gridTemplateColumns: `${leftNavWidth}px 1fr ${showInlinePanel ? `${rightPanelWidth}px` : '0px'}`,
          gridTemplateAreas: `
            "topbar topbar topbar"
            "leftnav chat rightpanel"
            "statusbar statusbar statusbar"
          `,
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
          style={{ gridArea: 'chat', overflow: 'hidden' }}
        >
          <ErrorBoundary>
            <Suspense fallback={<Spin style={{ margin: 'auto', display: 'block', paddingTop: '40vh' }} />}>
              <ChatView />
            </Suspense>
          </ErrorBoundary>
        </main>

        {/* Inline right panel (>= 1440px) */}
        <aside
          role="complementary"
          aria-label={t('a11y.sidePanel')}
          style={{
            gridArea: 'rightpanel',
            borderLeft: showInlinePanel ? '1px solid var(--border)' : 'none',
            overflow: 'hidden',
            transition: 'width 0.2s ease',
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

      {/* Overlay/Modal right panel (< 1440px) */}
      {showOverlayPanel && (
        <>
          {/* Backdrop */}
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
          {/* Panel drawer */}
          <div
            role="complementary"
            aria-label={t('a11y.sidePanel')}
            style={{
              position: 'fixed',
              top: 0,
              right: 0,
              bottom: 0,
              width: panelMode === 'modal' ? '100%' : `${Math.min(rightPanelWidth, 480)}px`,
              background: 'var(--surface)',
              borderLeft: panelMode === 'modal' ? 'none' : '1px solid var(--border)',
              zIndex: 1000,
              overflow: 'hidden',
              animation: 'slideInRight 0.2s ease-out',
            }}
          >
            <ErrorBoundary>
              <Suspense fallback={<Spin style={{ margin: 'auto', display: 'block', paddingTop: '40vh' }} />}>
                <RightPanel />
              </Suspense>
            </ErrorBoundary>
          </div>
          <style>{`
            @keyframes slideInRight {
              from { transform: translateX(100%); }
              to { transform: translateX(0); }
            }
          `}</style>
        </>
      )}
      </AntdApp>
    </ConfigProvider>
  );
}
