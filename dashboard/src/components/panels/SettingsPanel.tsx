import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  App,
  AutoComplete,
  Button,
  Divider,
  Input,
  Segmented,
  Select,
  Spin,
  Typography,
} from 'antd';
import { CopyOutlined, LoadingOutlined, ReloadOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useConfigStore } from '../../stores/config';
import { useGatewayStore } from '../../stores/gateway';
import { getThemeTokens } from '../../styles/theme';
import { buildSaveConfig, extractConfigFields } from '../../utils/config-patch';
import { PROVIDER_PRESETS, detectPresetFromProvider, getPreset } from '../../utils/provider-presets';

const { Text } = Typography;

/** Shared filter for provider Select: searches both label and id */
const providerFilterOption = (input: string, option?: { label?: unknown; value?: unknown }) => {
  const search = input.toLowerCase();
  return (
    String(option?.label ?? '').toLowerCase().includes(search) ||
    String(option?.value ?? '').toLowerCase().includes(search)
  );
};

// --- Setting row layout ---

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', gap: 16 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontSize: 13 }}>{label}</Text>
        {description && (
          <div>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {description}
            </Text>
          </div>
        )}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

// --- About section ---

function AboutSection() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const serverVersion = useGatewayStore((s) => s.serverVersion);
  const configTheme = useConfigStore((s) => s.theme);
  const tokens = useMemo(() => getThemeTokens(configTheme), [configTheme]);

  const handleCopyDiagnostics = async () => {
    const diagnostics = [
      `Research-Claw v0.4.0`,
      `Powered by OpenClaw ${serverVersion ?? 'unknown'}`,
      `Gateway: ws://127.0.0.1:28789`,
      `Platform: ${navigator.platform}`,
      `User-Agent: ${navigator.userAgent}`,
      `Theme: ${configTheme}`,
      `Timestamp: ${new Date().toISOString()}`,
    ].join('\n');

    try {
      await navigator.clipboard.writeText(diagnostics);
      message.success(t('settings.aboutDiagnosticsCopied'));
    } catch {
      message.error(t('settings.copyFailed'));
    }
  };

  const infoRows = [
    { label: t('settings.aboutOpenClaw', { version: serverVersion ?? 'N/A' }), value: '' },
    { label: t('settings.aboutGateway'), value: 'ws://127.0.0.1:28789' },
    { label: t('settings.aboutPlugins'), value: 'research-claw-core' },
  ];

  const bootstrapFiles = ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'BOOTSTRAP.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md', 'MEMORY.md'];

  return (
    <>
      {/* Version header with glow */}
      <div style={{ textAlign: 'center', padding: '8px 0 12px' }}>
        <a
          href="https://github.com/wentorai/Research-Claw"
          target="_blank"
          rel="noopener noreferrer"
          style={{ textDecoration: 'none' }}
        >
          <span
            style={{
              fontSize: 16,
              fontWeight: 700,
              fontFamily: "'Fira Code', monospace",
              color: '#EF4444',
              textShadow: '0 0 8px rgba(239, 68, 68, 0.6), 0 0 16px rgba(239, 68, 68, 0.3)',
              letterSpacing: 1,
            }}
          >
            Research-Claw v0.4.0
          </span>
        </a>
      </div>

      {infoRows.map((row) => (
        <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13 }}>
          <Text>{row.label}</Text>
          {row.value && (
            <Text style={{ fontFamily: "'Fira Code', monospace", fontSize: 12, color: tokens.text.muted }}>
              {row.value}
            </Text>
          )}
        </div>
      ))}

      <Divider style={{ margin: '8px 0' }} />

      <Text style={{ fontSize: 12, color: tokens.text.muted }}>{t('settings.aboutBootstrap')}</Text>
      <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {bootstrapFiles.map((file) => (
          <Text key={file} code style={{ fontSize: 11 }}>
            {file}
          </Text>
        ))}
      </div>

      <Divider style={{ margin: '12px 0 8px' }} />

      <Button
        icon={<CopyOutlined />}
        size="small"
        onClick={handleCopyDiagnostics}
        block
      >
        {t('settings.aboutDiagnostics')}
      </Button>

      <div style={{ marginTop: 8, textAlign: 'center' }}>
        <a
          href="https://github.com/wentorai/Research-Claw"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: tokens.accent.blue, fontSize: 12 }}
        >
          {t('settings.aboutGithub')}
        </a>
      </div>
    </>
  );
}

// --- Main SettingsPanel (single scrollable panel) ---

export default function SettingsPanel() {
  const { t } = useTranslation();
  const { modal, message } = App.useApp();
  const configTheme = useConfigStore((s) => s.theme);
  const tokens = useMemo(() => getThemeTokens(configTheme), [configTheme]);
  const state = useGatewayStore((s) => s.state);

  const gatewayConfig = useConfigStore((s) => s.gatewayConfig);
  const gatewayConfigLoading = useConfigStore((s) => s.gatewayConfigLoading);
  const loadGatewayConfig = useConfigStore((s) => s.loadGatewayConfig);

  const systemPromptAppend = useConfigStore((s) => s.systemPromptAppend);
  const setSystemPromptAppend = useConfigStore((s) => s.setSystemPromptAppend);

  // --- Text endpoint ---
  const [provider, setProvider] = useState('custom');
  const [baseUrl, setBaseUrl] = useState('');
  const [api, setApi] = useState('openai-completions');
  const [apiKey, setApiKey] = useState('');
  const [textModel, setTextModel] = useState('');

  // --- Vision ---
  const [visionEnabled, setVisionEnabled] = useState(false);
  const [visionProvider, setVisionProvider] = useState('custom');
  const [visionModel, setVisionModel] = useState('');
  const [visionBaseUrl, setVisionBaseUrl] = useState('');
  const [visionApi, setVisionApi] = useState('openai-completions');
  const [visionApiKey, setVisionApiKey] = useState('');

  // Track whether the gateway has configured keys (even if redacted)
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [visionApiKeyConfigured, setVisionApiKeyConfigured] = useState(false);

  // --- Network ---
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyUrl, setProxyUrl] = useState('http://127.0.0.1:7890');
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const handleProviderChange = (id: string) => {
    setProvider(id);
    const preset = getPreset(id);
    if (preset.baseUrl) setBaseUrl(preset.baseUrl);
    setApi(preset.api);
    if (preset.models.length > 0) {
      setTextModel(preset.models[0].id);
    }
  };

  const handleVisionProviderChange = (id: string) => {
    setVisionProvider(id);
    const preset = getPreset(id);
    if (preset.baseUrl) setVisionBaseUrl(preset.baseUrl);
    setVisionApi(preset.api);
    const visionCapable = preset.models.filter((m) => m.input?.includes('image'));
    if (visionCapable.length > 0) {
      setVisionModel(visionCapable[0].id);
    } else if (preset.models.length > 0) {
      setVisionModel(preset.models[0].id);
    }
  };

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

  // Load gateway config when connected
  useEffect(() => {
    if (state === 'connected' && !gatewayConfig && !gatewayConfigLoading) {
      loadGatewayConfig();
    }
  }, [state, gatewayConfig, gatewayConfigLoading, loadGatewayConfig]);

  // Sync form fields from gateway config
  useEffect(() => {
    if (!gatewayConfig) return;
    const fields = extractConfigFields(gatewayConfig as unknown as Record<string, unknown>);
    setBaseUrl(fields.baseUrl);
    setApi(fields.api);
    setApiKey(fields.apiKey);
    setApiKeyConfigured(fields.apiKeyConfigured);
    setTextModel(fields.textModel);
    setProvider(detectPresetFromProvider(fields.provider, fields.baseUrl));

    if (fields.visionEnabled) {
      setVisionEnabled(true);
      setVisionModel(fields.visionModel);
      setVisionProvider(detectPresetFromProvider(fields.visionProvider, fields.visionBaseUrl));
      setVisionBaseUrl(fields.visionBaseUrl || fields.baseUrl);
      setVisionApi(fields.visionApi);
      setVisionApiKey(fields.visionApiKey);
      setVisionApiKeyConfigured(fields.visionApiKeyConfigured);
    } else {
      setVisionEnabled(false);
      setVisionModel('');
      setVisionBaseUrl('');
      setVisionApiKey('');
      setVisionApiKeyConfigured(false);
    }

    if (fields.proxyUrl) {
      setProxyEnabled(true);
      setProxyUrl(fields.proxyUrl);
    } else {
      setProxyEnabled(false);
    }
    // Clear restarting state when config refreshes after reconnect
    setRestarting(false);
  }, [gatewayConfig]);

  const handleRefresh = useCallback(() => {
    loadGatewayConfig();
  }, [loadGatewayConfig]);

  const handleSave = useCallback(() => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    if (!baseUrl.trim() || !textModel.trim()) {
      message.error(t('settings.saveFailed'));
      return;
    }

    const modalTokens = getThemeTokens(useConfigStore.getState().theme);
    modal.confirm({
      title: t('settings.restartConfirmTitle'),
      content: t('settings.restartConfirmContent'),
      okText: t('settings.save'),
      cancelText: t('settings.cancel'),
      centered: true,
      styles: {
        mask: { backdropFilter: 'blur(4px)' },
        content: {
          background: modalTokens.bg.surface,
          borderRadius: 12,
          border: `1px solid ${modalTokens.border.default}`,
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          padding: '20px 24px',
        },
        header: {
          background: 'transparent',
          borderBottom: 'none',
          padding: 0,
          marginBottom: 8,
        },
        body: {
          padding: 0,
          color: modalTokens.text.secondary,
        },
        footer: {
          borderTop: 'none',
          marginTop: 16,
          padding: 0,
        },
      },
      onOk: async () => {
        setSaving(true);
        try {
          const configSnapshot = await client.request<{
            parsed?: Record<string, unknown>;
            config?: Record<string, unknown>;
            hash?: string;
          }>('config.get', {});

          // Use `parsed` (raw project JSON before OC validation/normalization)
          // so that resolveExistingApiKey finds keys at their original paths.
          // Matches SetupWizard.tsx:148. Without this, OC's config normalization
          // may restructure provider fields, causing apiKey lookups to fail.
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
              visionBaseUrl: visionEnabled && visionSeparateProvider ? visionBaseUrl.trim() || undefined : undefined,
              visionApiKey: visionEnabled && visionSeparateProvider ? (visionApiKey.trim() || undefined) : undefined,
              visionApi: visionEnabled && visionSeparateProvider ? visionApi : undefined,
              proxyUrl: proxyEnabled ? proxyUrl.trim() : '',
              apiKeyConfigured,
              visionApiKeyConfigured,
            },
          );

          await client.request('config.apply', {
            raw: JSON.stringify(fullConfig),
            baseHash: configSnapshot.hash,
          });

          message.success(t('settings.saved'));
          setRestarting(true);
        } catch {
          message.error(t('settings.saveFailed'));
        } finally {
          setSaving(false);
        }
      },
    });
  }, [baseUrl, api, apiKey, provider, textModel, visionEnabled, visionProvider, visionModel, visionBaseUrl, visionApi, visionApiKey, visionSeparateProvider, proxyEnabled, proxyUrl, t, modal, message]);

  const handleSavePrompt = useCallback(() => {
    message.success(t('settings.saved'));
  }, [t, message]);

  if (state !== 'connected') {
    return (
      <div style={{ padding: '24px 16px', textAlign: 'center' }}>
        <Text type="secondary">{t('status.disconnected')}</Text>
      </div>
    );
  }

  if (gatewayConfigLoading && !gatewayConfig) {
    return (
      <div style={{ padding: '24px 16px', textAlign: 'center' }}>
        <Spin size="small" />
        <div style={{ marginTop: 8 }}>
          <Text type="secondary">{t('settings.configLoading')}</Text>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '0 16px', height: '100%', overflow: 'auto' }}>
      {/* Config source badge + refresh */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0 4px' }}>
        <Text style={{ fontSize: 11, color: tokens.text.muted }}>{t('settings.configSource')}</Text>
        <Button
          type="text"
          size="small"
          icon={<ReloadOutlined spin={gatewayConfigLoading} />}
          onClick={handleRefresh}
          style={{ fontSize: 11 }}
        >
          {t('settings.refreshConfig')}
        </Button>
      </div>

      <Divider style={{ margin: '4px 0 8px' }} />

      {/* ── Provider + Model section ── */}
      <SettingRow label={t('settings.provider')}>
        <Select
          showSearch
          value={provider}
          onChange={handleProviderChange}
          size="small"
          style={{ width: 220 }}
          filterOption={providerFilterOption}
          options={PROVIDER_PRESETS.map((p) => ({
            value: p.id,
            label: p.id === 'custom' ? t('setup.providerCustom') : p.label,
          }))}
        />
      </SettingRow>

      <SettingRow label={t('settings.baseUrl')}>
        <Input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          size="small"
          style={{ width: 220 }}
          placeholder="https://api.openai.com/v1"
        />
      </SettingRow>

      {provider === 'custom' && (
        <SettingRow label={t('settings.apiProtocol')}>
          <Select
            value={api}
            onChange={setApi}
            size="small"
            style={{ width: 220 }}
            options={[
              { value: 'openai-completions', label: 'OpenAI Compatible' },
              { value: 'anthropic-messages', label: 'Anthropic Compatible' },
            ]}
          />
        </SettingRow>
      )}

      <SettingRow label={t('settings.apiKeyLabel')}>
        <Input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          size="small"
          style={{ width: 220 }}
          placeholder={apiKeyConfigured && !apiKey ? t('setup.apiKeyExisting') : t('setup.apiKeyPlaceholder')}
        />
      </SettingRow>

      <SettingRow label={t('settings.primaryModel')}>
        <AutoComplete
          value={textModel}
          onChange={setTextModel}
          options={modelOptions}
          size="small"
          style={{ width: 220 }}
          placeholder="glm-5"
          filterOption={(input, option) =>
            (option?.value ?? '').toLowerCase().includes(input.toLowerCase())
          }
        />
      </SettingRow>

      {/* ── Vision section ── */}
      <Divider style={{ margin: '4px 0 8px' }} />

      <SettingRow label={t('settings.enableVision')} description={!visionEnabled ? t('settings.visionModelHint') : undefined}>
        <Segmented
          value={visionEnabled ? 'on' : 'off'}
          onChange={(v) => setVisionEnabled(v === 'on')}
          options={[
            { label: 'OFF', value: 'off' },
            { label: 'ON', value: 'on' },
          ]}
          size="small"
        />
      </SettingRow>

      {visionEnabled && (
        <>
          <SettingRow label={t('settings.visionProvider')}>
            <Select
              showSearch
              value={visionProvider}
              onChange={handleVisionProviderChange}
              size="small"
              style={{ width: 220 }}
              filterOption={providerFilterOption}
              options={PROVIDER_PRESETS.map((p) => ({
                value: p.id,
                label: p.id === 'custom' ? t('setup.providerCustom') : p.label,
              }))}
            />
          </SettingRow>

          <SettingRow label={t('settings.visionModel')}>
            <AutoComplete
              value={visionModel}
              onChange={setVisionModel}
              options={visionModelOptions}
              size="small"
              style={{ width: 220 }}
              placeholder={t('settings.noVisionModel')}
              filterOption={(input, option) =>
                (option?.value ?? '').toLowerCase().includes(input.toLowerCase())
              }
            />
          </SettingRow>

          {/* Vision API URL + Key — only when different provider */}
          {visionSeparateProvider && (
            <>
              <SettingRow label={t('settings.visionBaseUrl')}>
                <Input
                  value={visionBaseUrl}
                  onChange={(e) => setVisionBaseUrl(e.target.value)}
                  size="small"
                  style={{ width: 220 }}
                  placeholder="https://api.openai.com/v1"
                />
              </SettingRow>

              <SettingRow label={t('settings.visionApiKey')}>
                <Input
                  value={visionApiKey}
                  onChange={(e) => setVisionApiKey(e.target.value)}
                  size="small"
                  style={{ width: 220 }}
                  placeholder={visionApiKeyConfigured && !visionApiKey ? t('setup.apiKeyExisting') : t('setup.apiKeyPlaceholder')}
                />
              </SettingRow>
            </>
          )}
        </>
      )}

      {/* ── Network section ── */}
      <Divider style={{ margin: '4px 0 8px' }} />

      <SettingRow label={t('settings.proxyEnabled')}>
        <Segmented
          value={proxyEnabled ? 'on' : 'off'}
          onChange={(v) => setProxyEnabled(v === 'on')}
          options={[
            { label: 'OFF', value: 'off' },
            { label: 'ON', value: 'on' },
          ]}
          size="small"
        />
      </SettingRow>

      {proxyEnabled && (
        <SettingRow label={t('settings.proxyUrl')}>
          <Input
            value={proxyUrl}
            onChange={(e) => setProxyUrl(e.target.value)}
            size="small"
            style={{ width: 220 }}
            placeholder="http://127.0.0.1:7890"
          />
        </SettingRow>
      )}

      {/* ── Save config (model + vision + proxy) ── */}
      <Divider style={{ margin: '4px 0 8px' }} />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Text type="secondary" style={{ fontSize: 11, flex: 1 }}>
          {t('settings.restartHint')}
        </Text>
        <Button type="primary" size="small" onClick={handleSave} loading={saving} style={{ flexShrink: 0 }}>
          {restarting ? t('setup.gatewayRestarting') : t('settings.save')}
        </Button>
      </div>

      <Divider style={{ margin: '8px 0' }} />

      {/* ── System prompt append (local-only) ── */}
      <SettingRow label={t('settings.systemPromptAppend')}>
        <Input.TextArea
          value={systemPromptAppend}
          onChange={(e) => setSystemPromptAppend(e.target.value)}
          placeholder={t('settings.systemPromptAppend')}
          rows={3}
          size="small"
          style={{ width: 220 }}
        />
      </SettingRow>

      <div style={{ textAlign: 'right', paddingTop: 8 }}>
        <Button type="primary" size="small" onClick={handleSavePrompt}>
          {t('settings.save')}
        </Button>
      </div>

      <Divider style={{ margin: '12px 0 8px' }} />

      {/* ── About section (inline) ── */}
      <AboutSection />

      <div style={{ height: 16 }} />
    </div>
  );
}
