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

export default function ConfigRestartListener() {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const connState = useGatewayStore((s) => s.state);
  const client = useGatewayStore((s) => s.client);
  const gatewayConfig = useConfigStore((s) => s.gatewayConfig);
  const prevStateRef = useRef(connState);
  const awaitingFreshConfigRef = useRef(false);
  const reconnectBaselineConfigRef = useRef<typeof gatewayConfig>(null);

  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = connState;

    if (connState === 'connected' && prev !== 'connected') {
      const { pendingConfigRestart } = useConfigStore.getState();
      if (pendingConfigRestart) {
        awaitingFreshConfigRef.current = true;
        reconnectBaselineConfigRef.current = useConfigStore.getState().gatewayConfig;
      }
    }
  }, [connState]);

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
    message.success(t('settings.reconnected'));

    // After config.apply + gateway restart, active sessions may keep their
    // previous `session.model` snapshot. Wait for the refreshed config snapshot,
    // then sync the active session to the new defaults so runtime model matches
    // what the dashboard shows.
    const modelPrimary = gatewayConfig.agents?.defaults?.model?.primary;
    const imageModelPrimary = gatewayConfig.agents?.defaults?.imageModel?.primary;
    const activeSessionKey = useSessionsStore.getState().activeSessionKey;

    if (client?.isConnected && activeSessionKey && typeof modelPrimary === 'string' && modelPrimary) {
      void (async () => {
        try {
          await client.request('sessions.patch', { key: activeSessionKey, model: modelPrimary });
          // Best-effort: some OC versions may not accept imageModel on sessions.patch.
          if (typeof imageModelPrimary === 'string' && imageModelPrimary) {
            await client.request('sessions.patch', { key: activeSessionKey, imageModel: imageModelPrimary });
          }
        } catch {
          // Non-fatal: even if patch fails, users can still change session model via /model.
        }
      })();
    }
  }, [client, connState, gatewayConfig, message, t]);

  return null;
}
