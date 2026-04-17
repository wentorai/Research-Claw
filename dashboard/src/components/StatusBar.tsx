import React, { useEffect, useState } from 'react';
import { App } from 'antd';
import { useTranslation } from 'react-i18next';
import { useGatewayStore } from '../stores/gateway';
import { useConfigStore } from '../stores/config';
import { useChatStore } from '../stores/chat';
import { useUiStore } from '../stores/ui';
import { RC_VERSION } from '../version';
import { confirmApplyAppUpdate } from '../utils/app-update-ui';

export default function StatusBar() {
  const { t } = useTranslation();
  const { modal, message } = App.useApp();
  const state = useGatewayStore((s) => s.state);
  const gatewayConfig = useConfigStore((s) => s.gatewayConfig);
  const configTheme = useConfigStore((s) => s.theme);
  const tokensIn = useChatStore((s) => s.tokensIn);
  const tokensOut = useChatStore((s) => s.tokensOut);
  const appUpdateInfo = useUiStore((s) => s.appUpdateInfo);
  const appUpdateRunning = useUiStore((s) => s.appUpdateRunning);
  const [heartbeatAge, setHeartbeatAge] = useState(0);

  // Heartbeat timer — counts seconds since last tick
  useEffect(() => {
    const interval = setInterval(() => {
      setHeartbeatAge((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Reset heartbeat on connection changes
  useEffect(() => {
    if (state === 'connected') {
      setHeartbeatAge(0);
    }
  }, [state]);

  // Periodic update check — every 15 minutes
  useEffect(() => {
    if (state !== 'connected') return;
    const interval = setInterval(() => {
      void useUiStore.getState().maybeNotifyAppUpdate();
    }, 15 * 60 * 1000);
    return () => clearInterval(interval);
  }, [state]);

  const statusColor =
    state === 'connected'
      ? 'var(--success)'
      : state === 'reconnecting' || state === 'connecting'
        ? 'var(--warning)'
        : 'var(--text-tertiary)';

  const statusKey =
    state === 'connected'
      ? 'status.connected'
      : state === 'reconnecting'
        ? 'status.reconnecting'
        : state === 'connecting'
          ? 'status.connecting'
          : state === 'authenticating'
            ? 'status.authenticating'
            : 'status.disconnected';

  const formatTime = (seconds: number): string => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  const modelDisplay = gatewayConfig?.agents?.defaults?.model?.primary ?? t('status.modelNA');

  const hasUpdate = appUpdateInfo && !appUpdateInfo.upToDate && !appUpdateInfo.error && appUpdateInfo.latest;

  const handleUpdateClick = () => {
    if (appUpdateRunning) return;
    confirmApplyAppUpdate({ modal, message, theme: configTheme, t });
  };

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        gap: 16,
        fontSize: 11,
        fontFamily: "'Fira Code', 'JetBrains Mono', Consolas, monospace",
        color: 'var(--text-tertiary)',
        background: 'var(--surface)',
        userSelect: 'none',
      }}
    >
      {/* Connection status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <div
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            backgroundColor: statusColor,
          }}
        />
        <span>{t(statusKey)}</span>
      </div>

      {/* Separator */}
      <div style={{ width: 1, height: 12, background: 'var(--border)' }} />

      {/* Model name */}
      <span style={{ color: 'var(--text-secondary)' }}>
        {t('status.model')}: {modelDisplay}
      </span>

      {/* Separator */}
      <div style={{ width: 1, height: 12, background: 'var(--border)' }} />

      {/* Token counts */}
      <span>
        {t('status.tokensIn')}: {tokensIn.toLocaleString()} | {t('status.tokensOut')}: {tokensOut.toLocaleString()}
      </span>

      {/* Separator */}
      <div style={{ width: 1, height: 12, background: 'var(--border)' }} />

      {/* Heartbeat timer */}
      <span>
        {t('status.heartbeat')}: {formatTime(heartbeatAge)}
      </span>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Update available banner — center-right, prominent */}
      {hasUpdate && (
        <>
          <span
            role="button"
            tabIndex={0}
            onClick={handleUpdateClick}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleUpdateClick(); }}
            style={{
              color: '#EF4444',
              cursor: appUpdateRunning ? 'default' : 'pointer',
              fontWeight: 600,
              opacity: appUpdateRunning ? 0.5 : 1,
            }}
          >
            {t('status.updateAvailable', { latest: appUpdateInfo.latest })}
          </span>
          <div style={{ width: 1, height: 12, background: 'var(--border)' }} />
        </>
      )}

      {/* RC Version */}
      <span>
        {t('status.version', { version: RC_VERSION })}
      </span>
    </div>
  );
}
