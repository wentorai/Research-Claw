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

export default function ConfigRestartListener() {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const connState = useGatewayStore((s) => s.state);
  const prevStateRef = useRef(connState);

  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = connState;

    if (connState === 'connected' && prev !== 'connected') {
      const { pendingConfigRestart, setPendingConfigRestart } = useConfigStore.getState();
      if (pendingConfigRestart) {
        setPendingConfigRestart(false);
        message.success(t('settings.reconnected'));
      }
    }
  }, [connState, message, t]);

  return null;
}
