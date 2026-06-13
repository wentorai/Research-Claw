import React from 'react';
import { App, Button, List, Space, Tag, Typography } from 'antd';
import { CheckOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import type { ApiProfile } from '../../utils/api-profiles';

const { Text } = Typography;

export interface ApiProfilesSectionProps {
  profiles: ApiProfile[];
  /** Currently edited provider key in the form. */
  activeProviderId: string;
  loading?: boolean;
  /** Load profile fields into the editor (no save). */
  onSelectProfile: (profile: ApiProfile) => void;
  /** Switch agents.defaults.model.primary to this profile and save. */
  onActivateProfile: (profile: ApiProfile) => Promise<void>;
  /** Create a new custom profile slot (same flow as provider picker → Custom). */
  onAddProfile: () => void;
  /** Remove profile from config on save. */
  onDeleteProfile: (profile: ApiProfile) => Promise<void>;
}

function summarizeUrl(url: string): string {
  if (!url) return '—';
  try {
    const u = new URL(url);
    return u.host + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    return url.length > 36 ? `${url.slice(0, 36)}…` : url;
  }
}

export default function ApiProfilesSection({
  profiles,
  activeProviderId,
  loading,
  onSelectProfile,
  onActivateProfile,
  onAddProfile,
  onDeleteProfile,
}: ApiProfilesSectionProps) {
  const { t } = useTranslation();
  const { modal } = App.useApp();

  const hasProfiles = profiles.length > 0;

  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <Text style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {t('settings.apiProfilesTitle', { defaultValue: 'Saved API profiles' })}
        </Text>
        <Button
          type="link"
          size="small"
          icon={<PlusOutlined />}
          onClick={onAddProfile}
          style={{ padding: 0, height: 'auto' }}
        >
          {t('settings.apiProfilesAdd', { defaultValue: 'Add' })}
        </Button>
      </div>

      <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 8 }}>
        {t('settings.apiProfilesDesc', {
          defaultValue:
            'Save multiple custom gateways (base URL, API key, model). Switch without re-entering.',
        })}
      </Text>

      {!hasProfiles ? (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('settings.apiProfilesEmpty', {
            defaultValue:
              'No saved profiles yet. Click Add or choose Custom under Provider, then fill in URL, key, and model below and Save.',
          })}
        </Text>
      ) : (
        <List
          size="small"
          dataSource={profiles}
          style={{
            background: 'var(--surface-hover)',
            borderRadius: 8,
            border: '1px solid var(--border)',
          }}
          renderItem={(profile) => {
            const selected = profile.id === activeProviderId;
            return (
              <List.Item
                style={{
                  padding: '8px 10px',
                  cursor: 'pointer',
                  background: selected ? 'rgba(59, 130, 246, 0.1)' : undefined,
                }}
                onClick={() => onSelectProfile(profile)}
                actions={[
                  profile.isActive ? (
                    <Tag color="blue" style={{ margin: 0 }}>
                      {t('settings.apiProfilesInUse', { defaultValue: 'In use' })}
                    </Tag>
                  ) : (
                    <Button
                      type="link"
                      size="small"
                      disabled={loading}
                      onClick={(e) => {
                        e.stopPropagation();
                        // The handler surfaces its own success/error feedback; catch
                        // here only to avoid an unhandled promise rejection.
                        onActivateProfile(profile).catch(() => {});
                      }}
                    >
                      {t('settings.apiProfilesUse', { defaultValue: 'Use' })}
                    </Button>
                  ),
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    disabled={loading}
                    onClick={(e) => {
                      e.stopPropagation();
                      modal.confirm({
                        title: t('settings.apiProfilesDeleteTitle', { defaultValue: 'Delete profile?' }),
                        content: t('settings.apiProfilesDeleteDesc', {
                          defaultValue: 'This removes saved credentials for "{{name}}".',
                          name: profile.label,
                        }),
                        okText: t('common.delete', { defaultValue: 'Delete' }),
                        okButtonProps: { danger: true },
                        cancelText: t('settings.cancel'),
                        centered: true,
                        onOk: () => onDeleteProfile(profile),
                      });
                    }}
                  />,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space size={6}>
                      {profile.isActive ? <CheckOutlined style={{ color: 'var(--accent-secondary)' }} /> : null}
                      <span style={{ fontWeight: 500 }}>{profile.label}</span>
                    </Space>
                  }
                  description={
                    <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                      {summarizeUrl(profile.baseUrl)} · {profile.modelId || '—'}
                      {!profile.requiresApiKey
                        ? ` · ${t('settings.apiProfilesOAuth', { defaultValue: 'OAuth' })}`
                        : profile.apiKeyConfigured
                          ? ` · ${t('settings.providerConfigured')}`
                          : ` · ${t('settings.apiKeyMissing')}`}
                    </span>
                  }
                />
              </List.Item>
            );
          }}
        />
      )}
    </div>
  );
}
