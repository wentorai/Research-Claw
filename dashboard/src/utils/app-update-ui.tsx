import type { ReactNode } from 'react';
import { App } from 'antd';
import { useGatewayStore } from '../stores/gateway';
import { useUiStore } from '../stores/ui';
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
  const instance = modal.confirm({
    title: t('settings.updateApplyConfirm'),
    content: t('settings.updateApplyDesc'),
    okText: t('settings.updateApply'),
    cancelText: t('settings.cancel'),
    centered: true,
    styles: buildThemedModalStyles(theme),
    onOk: async () => {
      // Disable cancel — server-side process has started, cannot be aborted
      instance.update({ cancelButtonProps: { disabled: true }, closable: false });
      const client = useGatewayStore.getState().client;
      if (!client?.isConnected) {
        message.warning(t('settings.updateNeedConnection'));
        return Promise.reject(new Error('offline'));
      }
      useUiStore.getState().setAppUpdateRunning(true);
      try {
        const r = await client.request<{ ok: boolean; log?: string }>('rc.app.apply_update', {});
        modal.success({
          title: t('settings.updateApplySuccess'),
          okText: t('settings.updateApplySuccessOk'),
          width: 560,
          styles: buildThemedModalStyles(theme),
          content: r.log ? renderUpdateLog(r.log) : undefined,
        });
      } catch (err) {
        message.error(err instanceof Error ? err.message : t('settings.updateApplyFailed'));
      } finally {
        useUiStore.getState().setAppUpdateRunning(false);
      }
    },
  });
}
