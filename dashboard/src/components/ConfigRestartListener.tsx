/**
 * Global listener: show a toast when the gateway reconnects after config.apply.
 *
 * Must be rendered INSIDE <AntdApp> so App.useApp().message inherits
 * the ConfigProvider theme. Renders nothing — purely a side-effect component.
 *
 * Pattern: mirrors CronEventListener.tsx
 */

import { useEffect, useRef } from 'react';
import { App } from 'antd';
import { useTranslation } from 'react-i18next';
import { useGatewayStore } from '../stores/gateway';
import { useConfigStore } from '../stores/config';
import { useSessionsStore } from '../stores/sessions';
import { useChatStore } from '../stores/chat';

export default function ConfigRestartListener() {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const connState = useGatewayStore((s) => s.state);
  const client = useGatewayStore((s) => s.client);
  const gatewayConfig = useConfigStore((s) => s.gatewayConfig);
  const pendingConfigRestart = useConfigStore((s) => s.pendingConfigRestart);
  const configOperationPhase = useConfigStore((s) => s.configOperation?.phase);
  const prevStateRef = useRef(connState);
  const awaitingFreshConfigRef = useRef(false);
  const reconnectBaselineConfigRef = useRef<typeof gatewayConfig>(null);

  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = connState;

    const configStore = useConfigStore.getState();
    if (pendingConfigRestart && (connState === 'disconnected' || connState === 'reconnecting')) {
      configStore.setConfigOperationPhase('reconnecting');
    }
    const readyToVerify = configOperationPhase !== 'persisting' && configOperationPhase !== 'validating';
    if (pendingConfigRestart && readyToVerify && connState === 'connected' && (!awaitingFreshConfigRef.current || prev !== 'connected')) {
      awaitingFreshConfigRef.current = true;
      reconnectBaselineConfigRef.current = configStore.gatewayConfig;
      configStore.setConfigOperationPhase('verifying_runtime');
      void configStore.loadGatewayConfig();
    }
  }, [configOperationPhase, connState, pendingConfigRestart]);

  useEffect(() => {
    if (!pendingConfigRestart) return;
    const timer = setTimeout(() => {
      const configStore = useConfigStore.getState();
      if (!configStore.pendingConfigRestart) return;
      configStore.setPendingConfigRestart(false);
      configStore.setConfigOperationPhase('failed', 'Gateway configuration verification timed out');
      awaitingFreshConfigRef.current = false;
      reconnectBaselineConfigRef.current = null;
    }, 45_000);
    return () => clearTimeout(timer);
  }, [pendingConfigRestart]);

  useEffect(() => {
    const { pendingConfigRestart, setPendingConfigRestart } = useConfigStore.getState();
    if (!pendingConfigRestart || connState !== 'connected' || !awaitingFreshConfigRef.current || !gatewayConfig) {
      return;
    }
    if (gatewayConfig === reconnectBaselineConfigRef.current) {
      return;
    }

    awaitingFreshConfigRef.current = false;
    reconnectBaselineConfigRef.current = null;
    setPendingConfigRestart(false);
    useConfigStore.getState().setConfigOperationPhase('syncing_session');
    message.success(t('settings.reconnected'));

    // After config.apply + gateway restart, active sessions may keep their
    // previous `session.model` snapshot. Wait for the refreshed config snapshot,
    // then sync the active session to the new defaults so runtime model matches
    // what the dashboard shows.
    const modelPrimary = gatewayConfig.agents?.defaults?.model?.primary;
    const activeSessionKey = useSessionsStore.getState().activeSessionKey;

    if (client?.isConnected && activeSessionKey && typeof modelPrimary === 'string' && modelPrimary) {
      void (async () => {
        try {
          await client.request('sessions.patch', { key: activeSessionKey, model: modelPrimary });
          void useChatStore.getState().loadSessionUsage();
          useConfigStore.getState().setConfigOperationPhase('completed');
        } catch (error) {
          useConfigStore.getState().setConfigOperationPhase(
            'failed',
            error instanceof Error ? error.message : String(error),
          );
        }
      })();
    } else {
      void useChatStore.getState().loadSessionUsage();
      useConfigStore.getState().setConfigOperationPhase('completed');
    }
  }, [client, connState, gatewayConfig, message, t]);

  return null;
}
