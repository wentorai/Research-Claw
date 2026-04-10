import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AutoComplete, Button, Collapse, Input, Select, Typography, Space, Alert, Card, Divider, Segmented } from 'antd';
import {
  ApiOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  GlobalOutlined,
  KeyOutlined,
  LoadingOutlined,
  RocketOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import OAuthModal from '../OAuthModal';
import { isOAuthProvider } from '../../utils/oauth-providers';
import { useTranslation } from 'react-i18next';
import { useGatewayStore } from '../../stores/gateway';
import { useConfigStore } from '../../stores/config';
import { buildSaveConfig, extractConfigFields, isLocalProvider } from '../../utils/config-patch';
import { PROVIDER_PRESETS, detectPresetFromProvider, getPreset, type ProviderPreset } from '../../utils/provider-presets';
import ProviderPickerModal, { providerLabel } from '../providers/ProviderPickerModal';

const { Title, Text } = Typography;

// ── Ollama model discovery ──

interface OllamaTagModel {
  name: string;
  size?: number;
  details?: { family?: string; parameter_size?: string };
}

interface OllamaTagsResponse {
  models?: OllamaTagModel[];
}

/**
 * Resolve the Ollama native API base from a configured baseUrl.
 * Users may configure with or without `/v1` suffix; native API lives at root.
 */
function resolveOllamaApiBase(configuredBaseUrl: string): string {
  const trimmed = configuredBaseUrl.replace(/\/+$/, '');
  return trimmed.replace(/\/v1$/i, '');
}

/**
 * Fetch the list of installed models from an Ollama instance.
 * Returns `{ reachable, models }`.
 */
async function fetchOllamaModels(
  baseUrl: string,
): Promise<{ reachable: boolean; models: OllamaTagModel[] }> {
  try {
    const apiBase = resolveOllamaApiBase(baseUrl);
    const response = await fetch(`${apiBase}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return { reachable: true, models: [] };
    }
    const data = (await response.json()) as OllamaTagsResponse;
    const models = (data.models ?? []).filter((m) => m.name);
    return { reachable: true, models };
  } catch {
    return { reachable: false, models: [] };
  }
}

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

  // --- UI ---
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // --- Ollama model discovery ---
  const [ollamaModels, setOllamaModels] = useState<OllamaTagModel[]>([]);
  const [ollamaDetecting, setOllamaDetecting] = useState(false);
  const [ollamaStatus, setOllamaStatus] = useState<'idle' | 'ok' | 'no_models' | 'unreachable'>('idle');

  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState('');

  const prefilled = useRef(false);
  const hasExistingConfig = useRef(false);

  // Ollama model detection
  const detectOllamaModels = useCallback(async (url?: string) => {
    const detectUrl = url || baseUrl || 'http://127.0.0.1:11434';
    setOllamaDetecting(true);
    setOllamaStatus('idle');
    try {
      const result = await fetchOllamaModels(detectUrl);
      if (!result.reachable) {
        setOllamaStatus('unreachable');
        setOllamaModels([]);
      } else if (result.models.length === 0) {
        setOllamaStatus('no_models');
        setOllamaModels([]);
      } else {
        setOllamaStatus('ok');
        setOllamaModels(result.models);
        // Auto-select first model if none selected yet
        if (!textModel && result.models.length > 0) {
          setTextModel(result.models[0].name);
        }
      }
    } finally {
      setOllamaDetecting(false);
    }
  }, [baseUrl, textModel]);

  // Apply text provider preset
  const handleProviderChange = (id: string) => {
    setProvider(id);
    const preset = getPreset(id);
    if (preset.baseUrl) setBaseUrl(preset.baseUrl);
    setApi(preset.api);
    if (preset.models.length > 0 && !textModel) {
      setTextModel(preset.models[0].id);
    }
    // OAuth providers use auth profiles; do not prompt for API key here.
    if (isOAuthProvider(id)) {
      setApiKey('');
    }
    // Local providers don't need API key; clear it and reset Ollama state
    if (isLocalProvider(id)) {
      setApiKey('');
      // Clear textModel so auto-detection can populate it from discovered models
      setTextModel('');
      // Reset Ollama detection state when switching provider
      setOllamaModels([]);
      setOllamaStatus('idle');
      // Auto-detect Ollama models when selecting the provider
      if (id === 'ollama') {
        const url = preset.baseUrl || 'http://127.0.0.1:11434';
        // Slight delay so baseUrl state is set
        setTimeout(() => detectOllamaModels(url), 100);
      }
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

  const isOAuthProviderSelected = isOAuthProvider(provider);
  const isOllamaLocal = isLocalProvider(provider);
  const [oauthModalOpen, setOauthModalOpen] = useState(false);
  const [providerPickerOpen, setProviderPickerOpen] = useState(false);
  const [visionProviderPickerOpen, setVisionProviderPickerOpen] = useState(false);
  const canStart =
    (isOAuthProviderSelected || isOllamaLocal || apiKey.trim().length > 0 || hasExistingConfig.current) &&
    baseUrl.trim().length > 0 &&
    textModel.trim().length > 0;

  /** Core save logic shared by handleStart (button click) and OAuth auto-save. */
  const performStart = useCallback(async () => {
    if (!client?.isConnected) throw new Error(t('oauth.notConnected'));

    setSaving(true);
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
      throw err;
    }
  }, [client, provider, baseUrl, api, apiKey, textModel, visionEnabled, visionProvider, visionModel, visionBaseUrl, visionApiKey, visionApi, proxyEnabled, proxyUrl, t]);

  const handleStart = async () => {
    setError('');
    try {
      await performStart();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('setup.configureFailed'));
    }
  };

  const handleSkipToDashboard = () => {
    useConfigStore.getState().setBootState('ready');
  };

  // Current preset's model suggestions for AutoComplete
  const currentPreset = getPreset(provider);
  const modelOptions = provider === 'ollama' && ollamaModels.length > 0
    ? ollamaModels.map((m) => ({
        value: m.name,
        label: m.details?.parameter_size
          ? `${m.name} (${m.details.parameter_size})`
          : m.name,
      }))
    : currentPreset.models.map((m) => ({
        value: m.id,
        label: `${m.id} — ${m.name}`,
      }));

  const visionPreset = getPreset(visionProvider);
  const visionModelOptions = visionPreset.models
    .filter((m) => m.input?.includes('image'))
    .map((m) => ({
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
            <Button
              block
              onClick={() => setProviderPickerOpen(true)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <ApiOutlined />
                <span>{providerLabel(provider, t)}</span>
              </span>
              <span style={{ opacity: 0.7 }}>{provider}</span>
            </Button>
            <ProviderPickerModal
              open={providerPickerOpen}
              value={provider}
              title={t('setup.provider')}
              onSelect={(id) => {
                setProviderPickerOpen(false);
                handleProviderChange(id);
              }}
              onClose={() => setProviderPickerOpen(false)}
            />
          </div>

          {/* ── API Key (hidden for local providers) ── */}
          {!isOllamaLocal && (
            <div>
              <Text strong style={{ display: 'block', marginBottom: 4 }}>
                {t('setup.apiKey')}
              </Text>
              <Input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={isOAuthProviderSelected}
                placeholder={
                  isOAuthProviderSelected
                    ? t('setup.openaiCodexOauthNoApiKey')
                    : (hasExistingConfig.current && !apiKey ? t('setup.apiKeyExisting') : t('setup.apiKeyPlaceholder'))
                }
                prefix={<ApiOutlined />}
              />
              {isOAuthProviderSelected && (
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
                    onSuccess={performStart}
                  />
                </div>
              )}
            </div>
          )}

          {/* ── Ollama: no API key notice + model detection ── */}
          {isOllamaLocal && (
            <div>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
                <CheckCircleOutlined style={{ color: 'var(--accent-primary)', marginRight: 4 }} />
                {t('setup.ollamaNoApiKey')}
              </Text>
              {provider === 'ollama' && (
                <>
                  <Button
                    size="small"
                    icon={ollamaDetecting ? <SyncOutlined spin /> : <SyncOutlined />}
                    onClick={() => detectOllamaModels()}
                    disabled={ollamaDetecting}
                    style={{ marginBottom: 6 }}
                  >
                    {ollamaDetecting ? t('setup.ollamaDetecting') : t('setup.ollamaDetectModels')}
                  </Button>
                  {ollamaStatus === 'ok' && (
                    <Text style={{ fontSize: 12, marginLeft: 8, color: 'var(--accent-primary)' }}>
                      <CheckCircleOutlined style={{ marginRight: 4 }} />
                      {t('setup.ollamaDetected', { count: ollamaModels.length })}
                    </Text>
                  )}
                  {ollamaStatus === 'unreachable' && (
                    <Alert
                      type="warning"
                      message={t('setup.ollamaDetectFailed')}
                      showIcon
                      icon={<CloseCircleOutlined />}
                      style={{ marginTop: 6, fontSize: 12 }}
                    />
                  )}
                  {ollamaStatus === 'no_models' && (
                    <Alert
                      type="info"
                      message={t('setup.ollamaNoModels')}
                      showIcon
                      style={{ marginTop: 6, fontSize: 12 }}
                    />
                  )}
                </>
              )}
            </div>
          )}

          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>
              {t('setup.modelName')}
            </Text>
            <AutoComplete
              value={textModel}
              onChange={setTextModel}
              options={modelOptions}
              placeholder={provider === 'ollama' ? 'e.g. llama3.2, qwen2.5, deepseek-r1' : t('setup.modelNamePlaceholder')}
              style={{ width: '100%' }}
              filterOption={(input, option) =>
                (option?.value ?? '').toLowerCase().includes(input.toLowerCase())
              }
            />
          </div>

          <Collapse
            activeKey={advancedOpen ? ['advanced'] : []}
            onChange={(keys) => setAdvancedOpen((keys as string[]).includes('advanced'))}
            size="small"
            items={[
              {
                key: 'advanced',
                label: t('setup.advanced'),
                children: (
                  <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                    {/* ── API URL ── */}
                    <div>
                      <Text strong style={{ display: 'block', marginBottom: 4 }}>
                        {t('setup.baseUrl')}
                      </Text>
                      <Input
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        placeholder={isOllamaLocal ? 'http://127.0.0.1:11434' : t('setup.baseUrlPlaceholder')}
                      />
                      {provider === 'ollama' && (
                        <Text type="secondary" style={{ fontSize: 11, marginTop: 2, display: 'block' }}>
                          {t('setup.ollamaBaseUrlHint')}
                        </Text>
                      )}
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
                  </Space>
                ),
              },
            ]}
          />

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
                <Button
                  block
                  onClick={() => setVisionProviderPickerOpen(true)}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <ApiOutlined />
                    <span>{providerLabel(visionProvider, t)}</span>
                  </span>
                  <span style={{ opacity: 0.7 }}>{visionProvider}</span>
                </Button>
                <ProviderPickerModal
                  open={visionProviderPickerOpen}
                  value={visionProvider}
                  title={t('setup.visionProvider')}
                  onSelect={(id) => {
                    setVisionProviderPickerOpen(false);
                    handleVisionProviderChange(id);
                  }}
                  onClose={() => setVisionProviderPickerOpen(false)}
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
