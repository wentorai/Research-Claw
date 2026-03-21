import React, { useState, useEffect, useRef } from 'react';
import { AutoComplete, Button, Input, Select, Typography, Space, Alert, Card, Divider, Segmented } from 'antd';
import {
  ApiOutlined,
  GlobalOutlined,
  KeyOutlined,
  LoadingOutlined,
  RocketOutlined,
} from '@ant-design/icons';
import OAuthModal from '../OAuthModal';
import { useTranslation } from 'react-i18next';
import { useGatewayStore } from '../../stores/gateway';
import { useConfigStore } from '../../stores/config';
import { buildSaveConfig, extractConfigFields } from '../../utils/config-patch';
import { PROVIDER_PRESETS, detectPresetFromProvider, getPreset, type ProviderPreset } from '../../utils/provider-presets';

const { Title, Text } = Typography;

/** Shared filter for provider Select: searches both label and id */
const providerFilterOption = (input: string, option?: { label?: unknown; value?: unknown }) => {
  const search = input.toLowerCase();
  return (
    String(option?.label ?? '').toLowerCase().includes(search) ||
    String(option?.value ?? '').toLowerCase().includes(search)
  );
};

export default function SetupWizard() {
  const { t } = useTranslation();
  const client = useGatewayStore((s) => s.client);
  const connState = useGatewayStore((s) => s.state);

  const gatewayConfig = useConfigStore((s) => s.gatewayConfig);

  // --- Text endpoint (initialize from default provider preset) ---
  const defaultPreset = getPreset('zai');
  const [provider, setProvider] = useState('zai');
  const [baseUrl, setBaseUrl] = useState(defaultPreset.baseUrl);
  const [api, setApi] = useState<ProviderPreset['api']>(defaultPreset.api);
  const [apiKey, setApiKey] = useState('');
  const [textModel, setTextModel] = useState(defaultPreset.models[0]?.id ?? '');

  // --- Vision ---
  const [visionEnabled, setVisionEnabled] = useState(false);
  const [visionProvider, setVisionProvider] = useState('zai');
  const [visionModel, setVisionModel] = useState('');
  const [visionBaseUrl, setVisionBaseUrl] = useState('');
  const [visionApi, setVisionApi] = useState<ProviderPreset['api']>('openai-completions');
  const [visionApiKey, setVisionApiKey] = useState('');

  // --- Network ---
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyUrl, setProxyUrl] = useState('http://127.0.0.1:7890');

  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState('');

  const prefilled = useRef(false);
  const hasExistingConfig = useRef(false);

  // Apply text provider preset
  const handleProviderChange = (id: string) => {
    setProvider(id);
    const preset = getPreset(id);
    if (preset.baseUrl) setBaseUrl(preset.baseUrl);
    setApi(preset.api);
    if (preset.models.length > 0 && !textModel) {
      setTextModel(preset.models[0].id);
    }
    // `openai-codex` uses OAuth profiles; do not prompt for API key here.
    if (id === 'openai-codex') {
      setApiKey('');
    }
  };

  // Apply vision provider preset
  const handleVisionProviderChange = (id: string) => {
    setVisionProvider(id);
    const preset = getPreset(id);
    if (preset.baseUrl) setVisionBaseUrl(preset.baseUrl);
    setVisionApi(preset.api);
    // Auto-fill first vision-capable model
    const visionCapable = preset.models.filter((m) => m.input?.includes('image'));
    if (visionCapable.length > 0) {
      setVisionModel(visionCapable[0].id);
    } else if (preset.models.length > 0 && !visionModel) {
      setVisionModel(preset.models[0].id);
    }
  };

  // Pre-fill from existing config
  useEffect(() => {
    if (!gatewayConfig || prefilled.current) return;
    const configRecord = gatewayConfig as unknown as Record<string, unknown>;
    const fields = extractConfigFields(configRecord);

    if (fields.baseUrl || fields.textModel) {
      setBaseUrl(fields.baseUrl);
      setApi(fields.api as ProviderPreset['api']);
      if (fields.apiKey) setApiKey(fields.apiKey);
      setTextModel(fields.textModel);
      setProvider(detectPresetFromProvider(fields.provider, fields.baseUrl));

      if (fields.visionEnabled) {
        setVisionEnabled(true);
        setVisionModel(fields.visionModel);
        setVisionProvider(detectPresetFromProvider(fields.visionProvider, fields.visionBaseUrl));
        setVisionBaseUrl(fields.visionBaseUrl || fields.baseUrl);
        setVisionApi(fields.visionApi as ProviderPreset['api']);
        if (fields.visionApiKey) setVisionApiKey(fields.visionApiKey);
      }

      if (fields.proxyUrl) {
        setProxyEnabled(true);
        setProxyUrl(fields.proxyUrl);
      }

      prefilled.current = true;
      hasExistingConfig.current = true;
    }
  }, [gatewayConfig]);

  // After gateway restart: force config reload
  useEffect(() => {
    if (!restarting || connState !== 'connected') return;
    const timer = setTimeout(() => {
      useConfigStore.getState().loadGatewayConfig();
    }, 2000);
    return () => clearTimeout(timer);
  }, [restarting, connState]);

  const isOpenAICodexOAuth = provider === 'openai-codex';
  const [oauthModalOpen, setOauthModalOpen] = useState(false);
  const canStart =
    (isOpenAICodexOAuth || apiKey.trim().length > 0 || hasExistingConfig.current) &&
    baseUrl.trim().length > 0 &&
    textModel.trim().length > 0;

  const handleStart = async () => {
    if (!client?.isConnected) return;

    setSaving(true);
    setError('');

    try {
      const configSnapshot = await client.request<{
        parsed?: Record<string, unknown>;
        config?: Record<string, unknown>;
        hash?: string;
      }>('config.get', {});

      // OpenClaw returns `parsed` (the project config before resolution).
      // Fall back to `config` for compatibility.
      const fullConfig = buildSaveConfig(
        (configSnapshot.parsed ?? configSnapshot.config ?? null) as Record<string, unknown> | null,
        {
          provider,
          baseUrl: baseUrl.trim(),
          api,
          apiKey: apiKey.trim() || undefined,
          textModel: textModel.trim(),
          visionEnabled,
          visionProvider: visionEnabled ? visionProvider : undefined,
          visionModel: visionEnabled ? visionModel.trim() || undefined : undefined,
          visionBaseUrl: visionEnabled && visionProvider !== provider ? visionBaseUrl.trim() || undefined : undefined,
          visionApiKey: visionEnabled && visionProvider !== provider ? (visionApiKey.trim() || undefined) : undefined,
          visionApi: visionEnabled && visionProvider !== provider ? visionApi : undefined,
          proxyUrl: proxyEnabled ? proxyUrl.trim() : '',
        },
      );

      await client.request('config.apply', {
        raw: JSON.stringify(fullConfig),
        baseHash: configSnapshot.hash,
      });

      setRestarting(true);
    } catch (err) {
      setSaving(false);
      setError(err instanceof Error ? err.message : 'Failed to configure gateway');
    }
  };

  const handleSkipToDashboard = () => {
    useConfigStore.getState().setBootState('ready');
  };

  // Current preset's model suggestions for AutoComplete
  const currentPreset = getPreset(provider);
  const modelOptions = currentPreset.models.map((m) => ({
    value: m.id,
    label: `${m.id} — ${m.name}`,
  }));

  const visionPreset = getPreset(visionProvider);
  const visionModelOptions = visionPreset.models.map((m) => ({
    value: m.id,
    label: `${m.id} — ${m.name}`,
  }));

  // Whether vision uses a different provider (show separate baseUrl/apiKey)
  const visionSeparateProvider = visionProvider !== provider;

  if (restarting) {
    return (
      <div
        style={{
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg)',
          gap: 16,
        }}
      >
        <LoadingOutlined style={{ fontSize: 48, color: 'var(--accent-primary)' }} />
        <Text style={{ fontSize: 16 }}>{t('setup.gatewayRestarting')}</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {connState === 'connected' ? t('status.connected') : t('status.reconnecting')}
        </Text>
        {connState === 'connected' && (
          <Button
            type="link"
            onClick={handleSkipToDashboard}
            style={{ marginTop: 16 }}
          >
            {t('setup.skipToDashboard')}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg)',
        padding: 24,
      }}
    >
      <Card
        style={{
          width: '100%',
          maxWidth: 480,
          background: 'var(--surface-hover)',
          border: '1px solid var(--border)',
          maxHeight: '90vh',
          overflow: 'auto',
        }}
        styles={{ body: { padding: 32 } }}
      >
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div style={{ textAlign: 'center' }}>
            <RocketOutlined style={{ fontSize: 48, color: 'var(--accent-primary)', marginBottom: 16 }} />
            <Title level={3} style={{ margin: 0 }}>
              {t('setup.title')}
            </Title>
            <Text type="secondary">{t('setup.subtitle')}</Text>
          </div>

          {/* ── Provider selector (searchable) ── */}
          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>
              {t('setup.provider')}
            </Text>
            <Select
              showSearch
              value={provider}
              onChange={handleProviderChange}
              style={{ width: '100%' }}
              filterOption={providerFilterOption}
              options={PROVIDER_PRESETS.map((p) => ({
                value: p.id,
                label: p.id === 'custom' ? t('setup.providerCustom') : p.label,
              }))}
            />
          </div>

          {/* ── API URL ── */}
          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>
              {t('setup.baseUrl')}
            </Text>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={t('setup.baseUrlPlaceholder')}
            />
          </div>

          {/* ── API Protocol (shown for Custom only) ── */}
          {provider === 'custom' && (
            <div>
              <Text strong style={{ display: 'block', marginBottom: 4 }}>
                {t('setup.apiProtocol')}
              </Text>
              <Select
                value={api}
                onChange={setApi}
                style={{ width: '100%' }}
                options={[
                  { value: 'openai-completions', label: 'OpenAI Compatible' },
                  { value: 'openai-responses', label: 'OpenAI Responses' },
                  { value: 'anthropic-messages', label: 'Anthropic Compatible' },
                ]}
              />
            </div>
          )}

          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>
              {t('setup.apiKey')}
            </Text>
            <Input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={isOpenAICodexOAuth}
              placeholder={
                isOpenAICodexOAuth
                  ? t('setup.openaiCodexOauthNoApiKey')
                  : (hasExistingConfig.current && !apiKey ? t('setup.apiKeyExisting') : t('setup.apiKeyPlaceholder'))
              }
              prefix={<ApiOutlined />}
            />
            {isOpenAICodexOAuth && (
              <div style={{ marginTop: 6 }}>
                <Button
                  size="small"
                  icon={<KeyOutlined />}
                  onClick={() => setOauthModalOpen(true)}
                >
                  {t('oauth.configureOAuth')}
                </Button>
                <OAuthModal
                  open={oauthModalOpen}
                  provider={provider}
                  onClose={() => setOauthModalOpen(false)}
                />
              </div>
            )}
          </div>

          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>
              {t('setup.modelName')}
            </Text>
            <AutoComplete
              value={textModel}
              onChange={setTextModel}
              options={modelOptions}
              placeholder={t('setup.modelNamePlaceholder')}
              style={{ width: '100%' }}
              filterOption={(input, option) =>
                (option?.value ?? '').toLowerCase().includes(input.toLowerCase())
              }
            />
          </div>

          <Divider style={{ margin: '4px 0' }} />

          {/* ── Vision toggle ── */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ fontSize: 13 }}>{t('setup.enableVision')}</Text>
              <Segmented
                value={visionEnabled ? 'on' : 'off'}
                onChange={(v) => setVisionEnabled(v === 'on')}
                options={[
                  { label: 'OFF', value: 'off' },
                  { label: 'ON', value: 'on' },
                ]}
                size="small"
              />
            </div>
            {!visionEnabled && (
              <Text type="secondary" style={{ fontSize: 11, marginTop: 2, display: 'block' }}>
                {t('setup.visionModelHint')}
              </Text>
            )}
          </div>

          {visionEnabled && (
            <>
              {/* Vision provider (searchable) */}
              <div>
                <Text strong style={{ display: 'block', marginBottom: 4 }}>
                  {t('setup.visionProvider')}
                </Text>
                <Select
                  showSearch
                  value={visionProvider}
                  onChange={handleVisionProviderChange}
                  style={{ width: '100%' }}
                  filterOption={providerFilterOption}
                  options={PROVIDER_PRESETS.map((p) => ({
                    value: p.id,
                    label: p.id === 'custom' ? t('setup.providerCustom') : p.label,
                  }))}
                />
              </div>

              {/* Vision model */}
              <div>
                <Text strong style={{ display: 'block', marginBottom: 4 }}>
                  {t('setup.visionModel')}
                </Text>
                <AutoComplete
                  value={visionModel}
                  onChange={setVisionModel}
                  options={visionModelOptions}
                  placeholder={t('setup.visionModelPlaceholder')}
                  style={{ width: '100%' }}
                  filterOption={(input, option) =>
                    (option?.value ?? '').toLowerCase().includes(input.toLowerCase())
                  }
                />
              </div>

              {/* Vision API URL + Key — only when different provider */}
              {visionSeparateProvider && (
                <>
                  <div>
                    <Text strong style={{ display: 'block', marginBottom: 4 }}>
                      {t('setup.visionBaseUrl')}
                    </Text>
                    <Input
                      value={visionBaseUrl}
                      onChange={(e) => setVisionBaseUrl(e.target.value)}
                      placeholder={t('setup.baseUrlPlaceholder')}
                    />
                  </div>

                  <div>
                    <Text strong style={{ display: 'block', marginBottom: 4 }}>
                      {t('setup.visionApiKey')}
                    </Text>
                    <Input
                      value={visionApiKey}
                      onChange={(e) => setVisionApiKey(e.target.value)}
                      placeholder={t('setup.apiKeyPlaceholder')}
                      prefix={<ApiOutlined />}
                    />
                  </div>
                </>
              )}
            </>
          )}

          <Divider style={{ margin: '4px 0' }} />

          {/* ── Network ── */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <Text style={{ fontSize: 13 }}>
                <GlobalOutlined style={{ marginRight: 6 }} />
                {t('setup.proxyEnabled')}
              </Text>
              <Segmented
                value={proxyEnabled ? 'on' : 'off'}
                onChange={(v) => setProxyEnabled(v === 'on')}
                options={[
                  { label: 'OFF', value: 'off' },
                  { label: 'ON', value: 'on' },
                ]}
                size="small"
              />
            </div>
            {proxyEnabled && (
              <>
                <Input
                  value={proxyUrl}
                  onChange={(e) => setProxyUrl(e.target.value)}
                  placeholder="http://127.0.0.1:7890"
                />
                <Text type="secondary" style={{ fontSize: 11, marginTop: 2, display: 'block' }}>
                  {t('setup.proxyHint')}
                </Text>
              </>
            )}
          </div>

          {error && (
            <Alert
              type="error"
              message={error}
              showIcon
              closable
              onClose={() => setError('')}
            />
          )}

          <Alert
            type="info"
            message={t('setup.restartHint')}
            style={{ fontSize: 12 }}
          />

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            {gatewayConfig ? (
              <Button type="link" onClick={handleSkipToDashboard} style={{ padding: 0 }}>
                {t('setup.skipToDashboard')}
              </Button>
            ) : (
              <span />
            )}
            <Button
              type="primary"
              onClick={handleStart}
              disabled={!canStart || saving}
              loading={saving}
              icon={<RocketOutlined />}
            >
              {saving ? t('setup.configuring') : t('setup.start')}
            </Button>
          </div>
        </Space>
      </Card>
    </div>
  );
}
