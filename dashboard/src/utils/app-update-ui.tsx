import type { ReactNode } from 'react';
import { App } from 'antd';
import { useGatewayStore } from '../stores/gateway';
import { getThemeTokens } from '../styles/theme';

type ModalApi = ReturnType<typeof App.useApp>['modal'];
type MessageApi = ReturnType<typeof App.useApp>['message'];
type Translate = (key: string, options?: Record<string, unknown>) => string;
type ThemeMode = Parameters<typeof getThemeTokens>[0];

export function buildThemedModalStyles(theme: ThemeMode) {
  const tokens = getThemeTokens(theme);
  return {
    mask: { backdropFilter: 'blur(4px)' },
    content: {
      background: tokens.bg.surface,
      borderRadius: 12,
      border: `1px solid ${tokens.border.default}`,
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      padding: '20px 24px',
    },
    header: { background: 'transparent', borderBottom: 'none', padding: 0, marginBottom: 8 },
    body: { padding: 0, color: tokens.text.secondary },
    footer: { borderTop: 'none', marginTop: 16, padding: 0 },
  };
}

function renderUpdateLog(log: string): ReactNode {
  return (
    <pre
      style={{
        maxHeight: 320,
        overflow: 'auto',
        fontSize: 11,
        margin: 0,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {log}
    </pre>
  );
}

export function confirmApplyAppUpdate({
  modal,
  message,
  theme,
  t,
}: {
  modal: ModalApi;
  message: MessageApi;
  theme: ThemeMode;
  t: Translate;
}) {
  modal.confirm({
    title: t('settings.updateApplyConfirm'),
    content: t('settings.updateApplyDesc'),
    okText: t('settings.updateApply'),
    cancelText: t('settings.cancel'),
    centered: true,
    styles: buildThemedModalStyles(theme),
    onOk: async () => {
      const client = useGatewayStore.getState().client;
      if (!client?.isConnected) {
        message.warning(t('settings.updateNeedConnection'));
        return Promise.reject(new Error('offline'));
      }
      try {
        const r = await client.request<{ ok: boolean; log?: string }>('rc.app.apply_update', {});
        modal.success({
          title: t('settings.updateApplySuccess'),
          width: 560,
          content: renderUpdateLog(r.log ?? ''),
        });
      } catch (err) {
        message.error(err instanceof Error ? err.message : t('settings.updateApplyFailed'));
      }
    },
  });
}
