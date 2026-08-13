import React from 'react';
import { Alert, Button } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useGatewayStore } from '../stores/gateway';

export default function CoreRuntimeAlert({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const failure = useGatewayStore((state) => state.coreFailure);
  if (!failure) return null;

  return (
    <Alert
      type="error"
      showIcon
      message={t('coreRuntime.title')}
      description={compact ? t('coreRuntime.compact') : t('coreRuntime.description')}
      action={
        <Button size="small" icon={<ReloadOutlined />} onClick={() => window.location.reload()}>
          {t('coreRuntime.retry')}
        </Button>
      }
      style={{ margin: compact ? 12 : '8px 12px', flexShrink: 0 }}
    />
  );
}
