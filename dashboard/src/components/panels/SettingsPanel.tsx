import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  App,
  AutoComplete,
  Button,
  Collapse,
  Divider,
  Input,
  Radio,
  Segmented,
  Select,
  Spin,
  Tooltip,
  Typography,
} from 'antd';
import { CloudDownloadOutlined, CopyOutlined, KeyOutlined, PoweroffOutlined, QuestionCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import OAuthModal from '../OAuthModal';
import ProviderPickerModal, { providerLabel } from '../providers/ProviderPickerModal';
import { useTranslation } from 'react-i18next';
import { useConfigStore } from '../../stores/config';
import { useGatewayStore } from '../../stores/gateway';
import { useSupervisorStore } from '../../stores/supervisor';
import { useUiStore } from '../../stores/ui';
import { getThemeTokens } from '../../styles/theme';
import { buildThemedModalStyles, confirmApplyAppUpdate } from '../../utils/app-update-ui';
import {
  buildSaveConfig,
  extractConfigFields,
  extractProviderFieldsForEditor,
  mergeProjectConfigsPreservingProviders,
} from '../../utils/config-patch';
import { PROVIDER_PRESETS, detectPresetFromProvider, getPreset } from '../../utils/provider-presets';
import { isOAuthProvider } from '../../utils/oauth-providers';
import { RC_VERSION } from '../../version';
import type { CheckUpdatesPayload } from '@/types/app-updates';

const SUPERVISOR_REVIEWER_PROVIDER_IDS = [
  'zai',
  'zai-global',
  'zai-coding',
  'zai-coding-global',
  'moonshot',
  'moonshot-cn',
  'kimi-coding',
  'minimax',
  'minimax-cn',
  'openai',
  'anthropic',
  'gemini',
  'deepseek',
  'qwen',
] as const;

const { Text } = Typography;

// --- Setting row layout ---

function SettingRow({
  label,
  description,
  children,
}: {
  label: React.ReactNode;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        padding: '10px 0',
        gap: 16,
      }}
    >
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
  const { modal, message } = App.useApp();
  const serverVersion = useGatewayStore((s) => s.serverVersion);
  const configTheme = useConfigStore((s) => s.theme);
  const tokens = useMemo(() => getThemeTokens(configTheme), [configTheme]);
  const [restarting, setRestarting] = useState(false);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const updateInfo = useUiStore((s) => s.appUpdateInfo);
  const setUpdateInfo = useUiStore((s) => s.setAppUpdateInfo);
  const [updateChecking, setUpdateChecking] = useState(false);

  // Reset restarting state when gateway reconnects with fresh config
  const gatewayConfigForReset = useConfigStore((s) => s.gatewayConfig);
  const configSeenAtStartRef = useRef<unknown>(null);
  useEffect(() => {
    if (restarting && gatewayConfigForReset && gatewayConfigForReset !== configSeenAtStartRef.current) {
      setRestarting(false);
      if (restartTimerRef.current) { clearTimeout(restartTimerRef.current); restartTimerRef.current = null; }
    }
  }, [gatewayConfigForReset, restarting]);

  const runCheckUpdates = useCallback(async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) {
      message.warning(t('settings.updateNeedConnection'));
      return;
    }
    setUpdateChecking(true);
    let payload: CheckUpdatesPayload | null = null;
    try {
      const r = await client.request<CheckUpdatesPayload>('rc.app.check_updates', {});
      if (!r || typeof r.current !== 'string') {
        setUpdateInfo(null);
        return;
      }
      payload = r;
      setUpdateInfo(r);
      if (r.error) {
        message.warning(r.error);
      } else if (r.upToDate) {
        message.success(t('settings.updateUpToDate'));
      } else {
        message.info(
          t('settings.updateAvailable', { current: r.current, latest: r.latest ?? '?' }),
        );
      }
    } catch {
      message.error(t('settings.updateCheckFailed'));
      setUpdateInfo(null);
    } finally {
      setUpdateChecking(false);
      if (payload) void useUiStore.getState().maybeNotifyAppUpdate(payload);
    }
  }, [message, t]);

  const handleCopyUpdateCommands = async () => {
    const hint = updateInfo?.shellUpdateHint;
    if (!hint) return;
    try {
      await navigator.clipboard.writeText(hint);
      message.success(t('settings.updateCommandsCopied'));
    } catch {
      message.error(t('settings.copyFailed'));
    }
  };

  const appUpdateRunning = useUiStore((s) => s.appUpdateRunning);

  const handleApplyUpdate = () => {
    if (appUpdateRunning) return;
    confirmApplyAppUpdate({ modal, message, theme: configTheme, t });
  };

  const handleCopyDiagnostics = async () => {
    const diagnostics = [
      `Research-Claw v${RC_VERSION}`,
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

  const handleRestart = () => {
    modal.confirm({
      title: t('settings.restartConfirm'),
      content: t('settings.restartConfirmDesc'),
      okText: t('settings.restart'),
      okButtonProps: { danger: true },
      cancelText: t('settings.cancel'),
      centered: true,
      styles: buildThemedModalStyles(configTheme),
      onOk: async () => {
        const client = useGatewayStore.getState().client;
        if (!client?.isConnected) return;
        try {
          const snapshot = await client.request<{
            parsed?: Record<string, unknown>;
            config?: Record<string, unknown>;
            raw?: string | null;
            hash?: string;
          }>('config.get', {});
          const raw = snapshot.raw ?? JSON.stringify(snapshot.parsed ?? snapshot.config ?? {});
          await client.request('config.apply', { raw, baseHash: snapshot.hash });
          message.success(t('settings.restartSuccess'));
          configSeenAtStartRef.current = useConfigStore.getState().gatewayConfig;
          setRestarting(true);
          // Safety timeout: reset after 30s if gateway never reconnects
          restartTimerRef.current = setTimeout(() => {
            setRestarting(false);
            message.warning(t('settings.restartFailed'));
          }, 30_000);
        } catch {
          message.error(t('settings.restartFailed'));
        }
      },
    });
  };

  const gatewayConfig = useConfigStore((s) => s.gatewayConfig);
  const gcObj = gatewayConfig as Record<string, unknown> | null;
  const browserCfg = gcObj?.browser as Record<string, unknown> | undefined;
  const browserStatus = browserCfg?.enabled ? t('settings.aboutEnabled') : t('settings.aboutDisabled');
  const memoryCfg = (gcObj?.agents as Record<string, unknown> | undefined)
    ?.defaults as Record<string, unknown> | undefined;
  const memoryEnabled = (memoryCfg?.memorySearch as Record<string, unknown> | undefined)?.enabled;
  const memoryStatus = memoryEnabled === false ? t('settings.aboutDisabled') : t('settings.aboutEnabled');

  const infoRows = [
    { label: t('settings.aboutOpenClaw', { version: serverVersion ?? 'N/A' }), value: '' },
    { label: t('settings.aboutGateway'), value: 'ws://127.0.0.1:28789' },
    { label: t('settings.aboutPlugins'), value: 'research-claw-core' },
    { label: t('settings.aboutMemory'), value: memoryStatus },
    { label: t('settings.aboutBrowser'), value: browserStatus },
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
            {t('settings.aboutVersion', { version: RC_VERSION })}
          </span>
        </a>
      </div>

      {updateInfo && !updateInfo.error && (
        <Text
          style={{
            fontSize: 12,
            color: tokens.text.muted,
            display: 'block',
            textAlign: 'center',
            marginBottom: 8,
          }}
        >
          {updateInfo.upToDate
            ? t('settings.updateStatusCurrent', { latest: updateInfo.latest ?? '—' })
            : t('settings.updateStatusNew', {
                current: updateInfo.current,
                latest: updateInfo.latest ?? '—',
              })}
        </Text>
      )}
      {updateInfo?.error && (
        <Text type="warning" style={{ fontSize: 12, display: 'block', textAlign: 'center', marginBottom: 8 }}>
          {t('settings.updateCheckPartial')}: {updateInfo.error}
        </Text>
      )}

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
        icon={<ReloadOutlined />}
        size="small"
        loading={updateChecking}
        onClick={runCheckUpdates}
        block
      >
        {t('settings.updateCheck')}
      </Button>

      <Button
        icon={<CopyOutlined />}
        size="small"
        onClick={handleCopyUpdateCommands}
        disabled={!updateInfo?.shellUpdateHint}
        block
        style={{ marginTop: 8 }}
      >
        {t('settings.updateCopyCommands')}
      </Button>

      <Button
        icon={<CloudDownloadOutlined />}
        size="small"
        onClick={handleApplyUpdate}
        loading={appUpdateRunning}
        disabled={appUpdateRunning}
        block
        style={{ marginTop: 8 }}
      >
        {t('settings.updateApply')}
      </Button>

      <Button
        icon={<CopyOutlined />}
        size="small"
        onClick={handleCopyDiagnostics}
        block
        style={{ marginTop: 8 }}
      >
        {t('settings.aboutDiagnostics')}
      </Button>

      <Button
        icon={<PoweroffOutlined />}
        size="small"
        danger
        block
        loading={restarting}
        style={{ marginTop: 8 }}
        onClick={handleRestart}
      >
        {restarting ? t('settings.restarting') : t('settings.restart')}
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

  const showSystemFiles = useUiStore((s) => s.showSystemFiles);
  const setShowSystemFiles = useUiStore((s) => s.setShowSystemFiles);

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

  // --- Web search ---
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [webSearchProvider, setWebSearchProvider] = useState('');
  const [webSearchApiKey, setWebSearchApiKey] = useState('');
  const [webSearchApiKeyConfigured, setWebSearchApiKeyConfigured] = useState(false);

  // --- Heartbeat ---
  const [heartbeatEnabled, setHeartbeatEnabled] = useState(true);
  const [heartbeatInterval, setHeartbeatInterval] = useState('30m');

  // --- Supervisor (dual-model) ---
  const supervisorStatus = useSupervisorStore((s) => s.status);
  const supervisorConfig = useSupervisorStore((s) => s.config);
  const [supervisorEnabled, setSupervisorEnabled] = useState(false);
  const [supervisorProvider, setSupervisorProvider] = useState('');
  const [supervisorModelId, setSupervisorModelId] = useState('');
  const [supervisorModel, setSupervisorModel] = useState('');
  const [supervisorBaseUrl, setSupervisorBaseUrl] = useState('');
  const [supervisorApi, setSupervisorApi] = useState('openai-completions');
  const [supervisorApiKey, setSupervisorApiKey] = useState('');
  const [supervisorApiKeyConfigured, setSupervisorApiKeyConfigured] = useState(false);
  const [supervisorApiKeyDeletePending, setSupervisorApiKeyDeletePending] = useState(false);
  const [supervisorUseMainModel, setSupervisorUseMainModel] = useState(true);
  const [reviewMode, setReviewMode] = useState<'filter-only' | 'correct' | 'full'>('correct');
  const [appendReviewToChannelOutput, setAppendReviewToChannelOutput] = useState(true);
  const [deviationThreshold, setDeviationThreshold] = useState(0.5);
  const [forceRegenerate, setForceRegenerate] = useState(false);
  const [maxRegenerateAttempts, setMaxRegenerateAttempts] = useState(3);

  // Cache for supervisor API keys per provider
  const supervisorApiKeyCacheRef = useRef<Record<string, string>>({});
  const deleteSupervisorApiKeyRef = useRef(false);

  // Sync supervisor state from plugin
  useEffect(() => {
    if (supervisorConfig?.enabled !== undefined) {
      setSupervisorEnabled(supervisorConfig.enabled);
    }
    if (supervisorConfig) {
      const model = supervisorConfig.supervisorModel;
      setSupervisorModel(model);

      // Determine inherit-main-model radio state
      if (!model || model === '') {
        setSupervisorUseMainModel(true);
      } else {
        setSupervisorUseMainModel(false);
      }

      // Parse "provider/modelId" format
      const slashIdx = model.indexOf('/');
      let parsedProvider = '';
      let parsedModelId = model;
      if (slashIdx >= 0) {
        parsedProvider = model.slice(0, slashIdx);
        parsedModelId = model.slice(slashIdx + 1);
      }
      setSupervisorProvider(parsedProvider);
      setSupervisorModelId(parsedModelId);

      // Auto-fill baseUrl and api from preset or project config
      if (parsedProvider) {
        const preset = getPreset(parsedProvider);
        const providerConfig = projectConfigCacheRef.current ?? gatewayConfig as unknown as Record<string, unknown> | null;
        const hydrated = providerConfig
          ? extractProviderFieldsForEditor(providerConfig, parsedProvider)
          : null;
        if (hydrated) {
          setSupervisorBaseUrl(hydrated.baseUrl);
          setSupervisorApi(hydrated.api);
          setSupervisorApiKey(hydrated.apiKey);
          setSupervisorApiKeyConfigured(hydrated.apiKeyConfigured);
        } else if (preset.baseUrl) {
          let url = preset.baseUrl;
          if ((parsedProvider === 'ollama' || parsedProvider === 'vllm') && typeof window !== 'undefined') {
            const host = window.location.hostname;
            const isNonLoopback = host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
            if (isNonLoopback) {
              url = url.replace('127.0.0.1', 'host.docker.internal');
            }
          }
          setSupervisorBaseUrl(url);
          setSupervisorApi(preset.api);
          setSupervisorApiKey('');
          setSupervisorApiKeyConfigured(false);
        } else {
          setSupervisorApi(preset.api);
          setSupervisorApiKey('');
          setSupervisorApiKeyConfigured(false);
        }
      }

      setReviewMode(supervisorConfig.reviewMode === 'off' ? 'correct' : supervisorConfig.reviewMode);
      setAppendReviewToChannelOutput(supervisorConfig.appendReviewToChannelOutput ?? true);
      setDeviationThreshold(supervisorConfig.courseCorrection.deviationThreshold);
      setForceRegenerate(supervisorConfig.courseCorrection.forceRegenerate);
      setMaxRegenerateAttempts(supervisorConfig.courseCorrection.maxRegenerateAttempts);
    }
  }, [supervisorConfig, gatewayConfig]);

  // Load supervisor status on connect
  useEffect(() => {
    if (state === 'connected') {
      useSupervisorStore.getState().loadStatus();
      useSupervisorStore.getState().loadConfig();
    }
  }, [state]);

  const projectConfigCacheRef = useRef<Record<string, unknown> | null>(null);

  // Computed: model options for the selected supervisor provider (from preset)
  const supervisorModelOptions = useMemo(() => {
    if (!supervisorProvider) return [];
    const preset = getPreset(supervisorProvider);
    return preset.models.map((m) => ({ value: m.id, label: `${m.id} — ${m.name}` }));
  }, [supervisorProvider]);

  const [saving, setSaving] = useState(false);
  const pendingRestart = useConfigStore((s) => s.pendingConfigRestart);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [supervisorAdvancedOpen, setSupervisorAdvancedOpen] = useState(false);

  // Controls whether the next gatewayConfig change should sync into form fields.
  // True on mount (initial load) and after explicit refresh / save-restart.
  // Prevents WebSocket reconnections from overwriting in-progress user edits.
  const syncNeeded = useRef(true);

  /** Set true when user clicks "Clear API Key"; applied on next save only. */
  const deleteTextApiKeyRef = useRef(false);
  const deleteVisionApiKeyRef = useRef(false);

  // In-memory cache to avoid forcing re-entry when the gateway's `config.get`
  // response drops non-active providers (common after provider switches).
  // Cache is cleared only via explicit "Clear API Key" actions.
  const apiKeyCacheRef = useRef<Record<string, string>>({});
  const visionApiKeyCacheRef = useRef<Record<string, string>>({});

  // Cache the last selected model id per provider so we can restore
  // providers even when the gateway's `config.get` response drops them.
  const textModelCacheRef = useRef<Record<string, string>>({});
  const visionModelCacheRef = useRef<Record<string, string>>({});

  const isOAuthProviderSelected = isOAuthProvider(provider);
  const visionSeparateProvider = visionProvider !== provider;
  const [oauthModalOpen, setOauthModalOpen] = useState(false);
  const [providerPickerOpen, setProviderPickerOpen] = useState(false);
  const [visionProviderPickerOpen, setVisionProviderPickerOpen] = useState(false);
  const [supervisorProviderPickerOpen, setSupervisorProviderPickerOpen] = useState(false);
  const [textApiKeyDeletePending, setTextApiKeyDeletePending] = useState(false);
  const [visionApiKeyDeletePending, setVisionApiKeyDeletePending] = useState(false);
  const [authConfiguredByProvider, setAuthConfiguredByProvider] = useState<Record<string, boolean>>({});

  // Supervisor provider helpers (depend on authConfiguredByProvider)
  const supervisorIsOAuth = supervisorProvider ? isOAuthProvider(supervisorProvider) : false;
  const supervisorProviderHasSavedKey = useCallback((id: string) => {
    if (!id) return false;
    const cached = supervisorApiKeyCacheRef.current[id];
    if (cached?.trim()) return true;
    if (authConfiguredByProvider[id]) return true;
    const providerConfig = projectConfigCacheRef.current ?? gatewayConfig as unknown as Record<string, unknown> | null;
    if (!providerConfig) return false;
    const hydrated = extractProviderFieldsForEditor(providerConfig, id);
    return Boolean(hydrated?.apiKeyConfigured);
  }, [authConfiguredByProvider, gatewayConfig]);

  const currentSupervisorProviderHasSavedKey = !supervisorApiKeyDeletePending && supervisorProviderHasSavedKey(supervisorProvider);

  const supervisorApiKeyStatus = useMemo(() => {
    if (!supervisorProvider) return null;
    if (supervisorIsOAuth) return t('setup.openaiCodexOauthNoApiKey');
    if (supervisorApiKeyDeletePending) return t('settings.apiKeyDeletePending');
    if (supervisorApiKey.trim()) return t('settings.apiKeyWillUpdate');
    if (supervisorApiKeyConfigured || currentSupervisorProviderHasSavedKey) return '';
    return t('settings.apiKeyMissing');
  }, [supervisorProvider, supervisorIsOAuth, supervisorApiKeyDeletePending, supervisorApiKey, supervisorApiKeyConfigured, currentSupervisorProviderHasSavedKey, t]);

  const handleSupervisorProviderChange = useCallback((id: string) => {
    setSupervisorProvider(id);
    deleteSupervisorApiKeyRef.current = false;
    setSupervisorApiKeyDeletePending(false);
    const preset = getPreset(id);
    const providerConfig = projectConfigCacheRef.current ?? gatewayConfig as unknown as Record<string, unknown> | null;
    const hydrated = providerConfig
      ? extractProviderFieldsForEditor(providerConfig, id)
      : null;
    if (hydrated) {
      setSupervisorBaseUrl(hydrated.baseUrl);
      setSupervisorApi(hydrated.api);
      setSupervisorApiKey(hydrated.apiKey);
      setSupervisorApiKeyConfigured(hydrated.apiKeyConfigured);
    } else if (preset.baseUrl) {
      let url = preset.baseUrl;
      if ((id === 'ollama' || id === 'vllm') && typeof window !== 'undefined') {
        const host = window.location.hostname;
        const isNonLoopback = host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
        if (isNonLoopback) {
          url = url.replace('127.0.0.1', 'host.docker.internal');
        }
      }
      setSupervisorBaseUrl(url);
      setSupervisorApi(preset.api);
      setSupervisorApiKey('');
      setSupervisorApiKeyConfigured(false);
    } else {
      setSupervisorApi(preset.api);
      setSupervisorApiKey('');
      setSupervisorApiKeyConfigured(false);
    }
    // Reset model when provider changes
    const firstModel = preset.models[0]?.id ?? '';
    setSupervisorModelId(firstModel);
    setSupervisorModel(firstModel ? `${id}/${firstModel}` : '');
    // Restore cached key state
    if (!id.startsWith('custom') && !deleteSupervisorApiKeyRef.current) {
      const cached = supervisorApiKeyCacheRef.current[id];
      if (cached && cached.trim()) {
        setSupervisorApiKeyConfigured(true);
        setSupervisorApiKey('');
      }
    }
    if (isOAuthProvider(id)) {
      setSupervisorApiKey('');
      setSupervisorApiKeyConfigured(false);
    }
  }, [gatewayConfig]);

  const supportsAuthProfiles = useCallback((id: string) => (
    id !== 'custom' &&
    !isOAuthProvider(id) &&
    id !== 'ollama' &&
    id !== 'vllm'
  ), []);

  const refreshAuthStatuses = useCallback(async (providers?: string[]) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    const targets = (providers ?? PROVIDER_PRESETS.map((preset) => preset.id))
      .filter((id, index, all) => Boolean(id) && all.indexOf(id) === index && supportsAuthProfiles(id));
    if (targets.length === 0) return;

    try {
      const result = await client.request<Record<string, { configured?: boolean }>>('rc.auth.statuses', {
        providers: targets,
      });
      setAuthConfiguredByProvider((prev) => {
        const next = { ...prev };
        for (const id of targets) {
          next[id] = Boolean(result?.[id]?.configured);
        }
        return next;
      });
    } catch {
      // Best effort only — config-based UI still works without auth status.
    }
  }, [supportsAuthProfiles]);

  const providerHasSavedKey = useCallback((id: string) => {
    if (!id) return false;
    const cached = apiKeyCacheRef.current[id] || visionApiKeyCacheRef.current[id];
    if (cached?.trim()) return true;
    if (authConfiguredByProvider[id]) return true;
    const providerConfig = projectConfigCacheRef.current ?? gatewayConfig as unknown as Record<string, unknown> | null;
    if (!providerConfig) return false;
    const hydrated = extractProviderFieldsForEditor(providerConfig, id);
    return Boolean(hydrated?.apiKeyConfigured);
  }, [authConfiguredByProvider, gatewayConfig]);

  const currentProviderHasSavedKey = !textApiKeyDeletePending && providerHasSavedKey(provider);
  const currentVisionProviderHasSavedKey = !visionApiKeyDeletePending && providerHasSavedKey(visionProvider);

  const textApiKeyStatus = useMemo(() => {
    if (isOAuthProviderSelected) return t('setup.openaiCodexOauthNoApiKey');
    if (textApiKeyDeletePending) return t('settings.apiKeyDeletePending');
    if (apiKey.trim()) return t('settings.apiKeyWillUpdate');
    if (apiKeyConfigured || currentProviderHasSavedKey) return '';
    return t('settings.apiKeyMissing');
  }, [apiKey, apiKeyConfigured, currentProviderHasSavedKey, isOAuthProviderSelected, t, textApiKeyDeletePending]);

  const visionApiKeyStatus = useMemo(() => {
    if (!visionEnabled || !visionSeparateProvider) return null;
    if (visionApiKeyDeletePending) return t('settings.apiKeyDeletePending');
    if (visionApiKey.trim()) return t('settings.apiKeyWillUpdate');
    if (visionApiKeyConfigured || currentVisionProviderHasSavedKey) return '';
    return t('settings.apiKeyMissing');
  }, [
    currentVisionProviderHasSavedKey,
    t,
    visionApiKey,
    visionApiKeyConfigured,
    visionApiKeyDeletePending,
    visionEnabled,
    visionProvider,
    visionSeparateProvider,
  ]);

  const handleProviderChange = useCallback((id: string) => {
    setProvider(id);
    deleteTextApiKeyRef.current = false;
    setTextApiKeyDeletePending(false);
    const preset = getPreset(id);
    const providerConfig = projectConfigCacheRef.current ?? gatewayConfig as unknown as Record<string, unknown> | null;
    const hydrated = providerConfig
      ? extractProviderFieldsForEditor(providerConfig, id)
      : null;
    if (hydrated) {
      setBaseUrl(hydrated.baseUrl);
      setApi(hydrated.api);
      setApiKey(hydrated.apiKey);
      setApiKeyConfigured(hydrated.apiKeyConfigured);
      setTextModel(hydrated.textModel);
      if (hydrated.textModel) textModelCacheRef.current[id] = hydrated.textModel;
    } else if (preset.baseUrl) {
      let url = preset.baseUrl;
      if ((id === 'ollama' || id === 'vllm') && typeof window !== 'undefined') {
        const host = window.location.hostname;
        const isNonLoopback = host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
        if (isNonLoopback) {
          url = url.replace('127.0.0.1', 'host.docker.internal');
        }
      }
      setBaseUrl(url);
      setApi(preset.api);
      if (preset.models.length > 0) {
        setTextModel(preset.models[0].id);
        textModelCacheRef.current[id] = preset.models[0].id;
      }
      setApiKey('');
      setApiKeyConfigured(false);
    } else {
      setApi(preset.api);
      if (preset.models.length > 0) {
        setTextModel(preset.models[0].id);
        textModelCacheRef.current[id] = preset.models[0].id;
      }
      setApiKey('');
      setApiKeyConfigured(false);
    }

    // If the gateway doesn't expose this provider in config.get anymore,
    // but the user previously typed a key (cached), restore "configured" state
    // without requiring re-entry.
    if (!id.startsWith('custom') && !deleteTextApiKeyRef.current) {
      const cached = apiKeyCacheRef.current[id];
      if (cached && cached.trim()) {
        setApiKeyConfigured(true);
        // Keep apiKey value empty to avoid showing the raw key in the input.
        setApiKey('');
      }
    }
    if (isOAuthProvider(id)) {
      setApiKey('');
      setApiKeyConfigured(false);
    }
  }, [authConfiguredByProvider, gatewayConfig]);

  const handleVisionProviderChange = useCallback((id: string) => {
    setVisionProvider(id);
    deleteVisionApiKeyRef.current = false;
    setVisionApiKeyDeletePending(false);
    const preset = getPreset(id);
    const providerConfig = projectConfigCacheRef.current ?? gatewayConfig as unknown as Record<string, unknown> | null;
    const hydrated = providerConfig
      ? extractProviderFieldsForEditor(providerConfig, id)
      : null;
    if (hydrated) {
      setVisionBaseUrl(hydrated.baseUrl);
      setVisionApi(hydrated.api);
      setVisionApiKey(hydrated.apiKey);
      setVisionApiKeyConfigured(hydrated.apiKeyConfigured);
      const all = extractConfigFields(gatewayConfig as unknown as Record<string, unknown>);
      if (all.visionProvider === id && all.visionModel) {
        setVisionModel(all.visionModel);
        if (all.visionModel) visionModelCacheRef.current[id] = all.visionModel;
      } else {
        const visionCapable = preset.models.filter((m) => m.input?.includes('image'));
        if (visionCapable.length > 0) {
          setVisionModel(visionCapable[0].id);
          visionModelCacheRef.current[id] = visionCapable[0].id;
        } else if (preset.models.length > 0) {
          setVisionModel(preset.models[0].id);
          visionModelCacheRef.current[id] = preset.models[0].id;
        }
      }
    } else {
      if (preset.baseUrl) setVisionBaseUrl(preset.baseUrl);
      setVisionApi(preset.api);
      const visionCapable = preset.models.filter((m) => m.input?.includes('image'));
      if (visionCapable.length > 0) {
        setVisionModel(visionCapable[0].id);
        visionModelCacheRef.current[id] = visionCapable[0].id;
      } else if (preset.models.length > 0) {
        setVisionModel(preset.models[0].id);
        visionModelCacheRef.current[id] = preset.models[0].id;
      }
      setVisionApiKey('');
      setVisionApiKeyConfigured(false);
    }

    if (!deleteVisionApiKeyRef.current) {
      const cached = visionApiKeyCacheRef.current[id];
      if (cached && cached.trim()) {
        setVisionApiKeyConfigured(true);
        setVisionApiKey('');
      }
    }
  }, [authConfiguredByProvider, gatewayConfig]);

  const currentPreset = getPreset(provider);
  const modelOptions = currentPreset.models.map((m) => ({
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

  // Load gateway config when connected
  useEffect(() => {
    if (state === 'connected' && !gatewayConfig && !gatewayConfigLoading) {
      loadGatewayConfig();
    }
  }, [state, gatewayConfig, gatewayConfigLoading, loadGatewayConfig]);

  useEffect(() => {
    if (state !== 'connected') return;
    void refreshAuthStatuses();
  }, [refreshAuthStatuses, state]);

  // Sync form fields from gateway config — only when explicitly requested
  // (initial mount, manual refresh, or post-save restart).
  useEffect(() => {
    const latestProjectConfig = (
      gatewayConfig?.projectConfig ??
      (gatewayConfig as unknown as Record<string, unknown> | null)
    );
    projectConfigCacheRef.current = mergeProjectConfigsPreservingProviders(
      latestProjectConfig,
      projectConfigCacheRef.current,
    );
  }, [gatewayConfig]);

  useEffect(() => {
    if (!gatewayConfig || !syncNeeded.current) return;
    syncNeeded.current = false;
    const configForEditor = projectConfigCacheRef.current ?? gatewayConfig as unknown as Record<string, unknown>;
    const fields = extractConfigFields(configForEditor);
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

    setWebSearchEnabled(fields.webSearchEnabled);
    setWebSearchProvider(fields.webSearchProvider);
    setWebSearchApiKey(fields.webSearchApiKey);
    setWebSearchApiKeyConfigured(fields.webSearchApiKeyConfigured);

    setHeartbeatEnabled(fields.heartbeatEnabled);
    setHeartbeatInterval(fields.heartbeatInterval);

  }, [gatewayConfig]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRefresh = useCallback(() => {
    syncNeeded.current = true;
    void refreshAuthStatuses();
    loadGatewayConfig();
  }, [loadGatewayConfig, refreshAuthStatuses]);

  /** Core save logic shared by handleSave (with confirm dialog) and OAuth auto-save. */
  const performSave = useCallback(async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) throw new Error(t('oauth.notConnected'));
    if (!baseUrl.trim() || !textModel.trim()) throw new Error(t('settings.validationMissing'));

    setSaving(true);
    try {
      const configSnapshot = await client.request<{
        parsed?: Record<string, unknown>;
        config?: Record<string, unknown>;
        hash?: string;
      }>('config.get', {});
      const latestProjectConfig = (configSnapshot.parsed ?? configSnapshot.config ?? null) as Record<string, unknown> | null;
      const mergedProjectConfig = mergeProjectConfigsPreservingProviders(
        latestProjectConfig,
        projectConfigCacheRef.current,
      );

      // Use `parsed` (raw project JSON before OC validation/normalization)
      // so that resolveExistingApiKey finds keys at their original paths.
      // Matches SetupWizard.tsx:148. Without this, OC's config normalization
      // may restructure provider fields, causing apiKey lookups to fail.
      const cachedTextKey = apiKeyCacheRef.current[provider]?.trim();
      const cachedVisionKey = visionSeparateProvider
        ? visionApiKeyCacheRef.current[visionProvider]?.trim()
        : undefined;

      // If the input box is empty and we have an in-memory cached key for
      // this provider, send it to preserve configuration without retyping.
      const apiKeyToSend = deleteTextApiKeyRef.current
        ? undefined
        : apiKey.trim() || cachedTextKey || undefined;
      const visionApiKeyToSend = deleteVisionApiKeyRef.current
        ? undefined
        : (visionSeparateProvider ? (visionApiKey.trim() || cachedVisionKey || undefined) : undefined);

      if (supportsAuthProfiles(provider)) {
        if (deleteTextApiKeyRef.current) {
          try {
            await client.request('rc.auth.clearApiKey', { provider });
          } catch { /* best effort — key also removed via config.apply */ }
          setAuthConfiguredByProvider((prev) => ({ ...prev, [provider]: false }));
        } else if (apiKeyToSend) {
          try {
            await client.request('rc.auth.setApiKey', { provider, apiKey: apiKeyToSend });
          } catch { /* best effort — key also persisted via models.providers.*.apiKey */ }
          setAuthConfiguredByProvider((prev) => ({ ...prev, [provider]: true }));
        }
      }
      if (visionEnabled && visionSeparateProvider && supportsAuthProfiles(visionProvider)) {
        if (deleteVisionApiKeyRef.current) {
          try {
            await client.request('rc.auth.clearApiKey', { provider: visionProvider });
          } catch { /* best effort */ }
          setAuthConfiguredByProvider((prev) => ({ ...prev, [visionProvider]: false }));
        } else if (visionApiKeyToSend) {
          try {
            await client.request('rc.auth.setApiKey', { provider: visionProvider, apiKey: visionApiKeyToSend });
          } catch { /* best effort */ }
          setAuthConfiguredByProvider((prev) => ({ ...prev, [visionProvider]: true }));
        }
      }

      // Supervisor provider API key (via auth profile)
      const supervisorApiKeyToSend = deleteSupervisorApiKeyRef.current
        ? undefined
        : supervisorApiKey.trim() || supervisorApiKeyCacheRef.current[supervisorProvider]?.trim() || undefined;
      if (supervisorEnabled && supervisorProvider && supervisorProvider !== provider && supervisorProvider !== visionProvider && supportsAuthProfiles(supervisorProvider)) {
        if (deleteSupervisorApiKeyRef.current) {
          try {
            await client.request('rc.auth.clearApiKey', { provider: supervisorProvider });
          } catch { /* best effort */ }
          setAuthConfiguredByProvider((prev) => ({ ...prev, [supervisorProvider]: false }));
        } else if (supervisorApiKeyToSend) {
          try {
            await client.request('rc.auth.setApiKey', { provider: supervisorProvider, apiKey: supervisorApiKeyToSend });
          } catch { /* best effort */ }
          setAuthConfiguredByProvider((prev) => ({ ...prev, [supervisorProvider]: true }));
        }
      }

      // Restore other cached providers so `config.apply` doesn't accidentally
      // drop non-active providers when `config.get` omits them.
      const restoreProviders: Record<string, { modelId: string; apiKey: string }> = {};
      for (const [pId, k] of Object.entries(apiKeyCacheRef.current)) {
        const key = k?.trim() ?? '';
        if (!key) continue;
        if (pId === provider) continue;
        const modelId = textModelCacheRef.current[pId] || getPreset(pId).models?.[0]?.id;
        if (!modelId) continue;
        restoreProviders[pId] = { modelId, apiKey: key };
      }
      if (visionSeparateProvider) {
        for (const [vpId, k] of Object.entries(visionApiKeyCacheRef.current)) {
          const key = k?.trim() ?? '';
          if (!key) continue;
          if (vpId === provider) continue;
          const modelId = visionModelCacheRef.current[vpId] || getPreset(vpId).models?.[0]?.id;
          if (!modelId) continue;
          restoreProviders[vpId] = { modelId, apiKey: key };
        }
      }
      // Supervisor provider cache
      if (supervisorEnabled && supervisorProvider && supervisorProvider !== provider) {
        const supervisorKey = deleteSupervisorApiKeyRef.current
          ? ''
          : (supervisorApiKeyToSend || supervisorApiKeyCacheRef.current[supervisorProvider]?.trim() || '');
        if (supervisorKey) {
          const modelId = supervisorModelId || getPreset(supervisorProvider).models?.[0]?.id;
          if (modelId) {
            restoreProviders[supervisorProvider] = { modelId, apiKey: supervisorKey };
          }
        }
      }

      const fullConfig = buildSaveConfig(
        mergedProjectConfig,
        {
          provider,
          baseUrl: baseUrl.trim(),
          api,
          apiKey: apiKeyToSend,
          textModel: textModel.trim(),
          visionEnabled,
          visionProvider: visionEnabled ? visionProvider : undefined,
          visionModel: visionEnabled ? visionModel.trim() || undefined : undefined,
          visionBaseUrl: visionEnabled && visionSeparateProvider ? visionBaseUrl.trim() || undefined : undefined,
          visionApiKey: visionEnabled && visionSeparateProvider ? visionApiKeyToSend : undefined,
          visionApi: visionEnabled && visionSeparateProvider ? visionApi : undefined,
          proxyUrl: proxyEnabled ? proxyUrl.trim() : '',
          apiKeyConfigured,
          visionApiKeyConfigured,
          deleteTextApiKey: deleteTextApiKeyRef.current,
          deleteVisionApiKey: deleteVisionApiKeyRef.current,
          webSearchEnabled,
          webSearchProvider: webSearchEnabled ? webSearchProvider : undefined,
          webSearchApiKey: webSearchEnabled ? (webSearchApiKey.trim() || undefined) : undefined,
          webSearchApiKeyConfigured,
          heartbeatEnabled,
          heartbeatInterval,
          restoreProviders: Object.keys(restoreProviders).length ? restoreProviders : undefined,
          // Dual-model supervisor config
          supervisorEnabled,
          supervisorModel: supervisorEnabled
            ? (supervisorUseMainModel ? '' : (supervisorProvider && supervisorModelId ? `${supervisorProvider}/${supervisorModelId}` : undefined))
            : undefined,
          supervisorReviewMode: supervisorEnabled ? reviewMode : undefined,
          supervisorAppendReviewToChannelOutput: supervisorEnabled ? appendReviewToChannelOutput : undefined,
          supervisorDeviationThreshold: supervisorEnabled ? deviationThreshold : undefined,
          supervisorForceRegenerate: supervisorEnabled ? forceRegenerate : undefined,
          supervisorMaxRegenerateAttempts: supervisorEnabled ? maxRegenerateAttempts : undefined,
        },
      );

      await client.request('config.apply', {
        raw: JSON.stringify(fullConfig),
        baseHash: configSnapshot.hash,
      });

      projectConfigCacheRef.current = fullConfig;

      deleteTextApiKeyRef.current = false;
      deleteVisionApiKeyRef.current = false;
      deleteSupervisorApiKeyRef.current = false;
      setTextApiKeyDeletePending(false);
      setVisionApiKeyDeletePending(false);
      setSupervisorApiKeyDeletePending(false);
      void refreshAuthStatuses([provider, visionProvider, supervisorEnabled ? supervisorProvider : undefined].filter(Boolean) as string[]);

      syncNeeded.current = true;
      useConfigStore.getState().setPendingConfigRestart(true);
    } finally {
      setSaving(false);
    }
  }, [baseUrl, api, apiKey, provider, textModel, visionEnabled, visionProvider, visionModel, visionBaseUrl, visionApi, visionApiKey, visionSeparateProvider, proxyEnabled, proxyUrl, webSearchEnabled, webSearchProvider, webSearchApiKey, webSearchApiKeyConfigured, heartbeatEnabled, heartbeatInterval, supervisorEnabled, supervisorProvider, supervisorModelId, supervisorUseMainModel, reviewMode, appendReviewToChannelOutput, deviationThreshold, forceRegenerate, maxRegenerateAttempts, t, refreshAuthStatuses, supportsAuthProfiles]);

  const handleSave = useCallback(() => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    if (!baseUrl.trim() || !textModel.trim()) {
      message.error(t('settings.validationMissing'));
      return;
    }

    modal.confirm({
      title: t('settings.restartConfirmTitle'),
      content: t('settings.restartConfirmContent'),
      okText: t('settings.save'),
      cancelText: t('settings.cancel'),
      centered: true,
      styles: buildThemedModalStyles(useConfigStore.getState().theme),
      onOk: async () => {
        try {
          await performSave();
          message.success(t('settings.saved'));
        } catch {
          message.error(t('settings.saveFailed'));
        }
      },
    });
  }, [performSave, baseUrl, textModel, t, modal, message]);

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
        <>
          <Button
            size="small"
            style={{ width: 220, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
            onClick={() => setProviderPickerOpen(true)}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {providerLabel(provider, t)}
              {currentProviderHasSavedKey ? ` · ${t('settings.providerConfigured')}` : ''}
            </span>
            <span style={{ opacity: 0.65, marginLeft: 8, flexShrink: 0 }}>
              {provider}
            </span>
          </Button>
          <ProviderPickerModal
            open={providerPickerOpen}
            value={provider}
            title={t('settings.provider')}
            onSelect={(id) => {
              setProviderPickerOpen(false);
              handleProviderChange(id);
            }}
            onClose={() => setProviderPickerOpen(false)}
          />
        </>
      </SettingRow>

      <SettingRow label={t('settings.apiKeyLabel')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 220 }}>
          <Input
            value={apiKey}
            onChange={(e) => {
              deleteTextApiKeyRef.current = false;
              setTextApiKeyDeletePending(false);
              const v = e.target.value;
              setApiKey(v);
              if (v.trim()) {
                apiKeyCacheRef.current[provider] = v.trim();
              }
            }}
            size="small"
            style={{ width: 220 }}
            disabled={isOAuthProviderSelected}
            placeholder={
              isOAuthProviderSelected
                ? t('setup.openaiCodexOauthNoApiKey')
                : (currentProviderHasSavedKey && !apiKey ? t('setup.apiKeyExisting') : t('setup.apiKeyPlaceholder'))
            }
          />
          {!isOAuthProviderSelected && (
            <>
              {textApiKeyStatus ? (
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {textApiKeyStatus}
                </Text>
              ) : null}
              {(currentProviderHasSavedKey || !!apiKey.trim()) && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', width: 220 }}>
                  <Button
                    size="small"
                    type="link"
                    danger
                    style={{ padding: '0 4px', flexShrink: 0 }}
                    onClick={() => {
                      deleteTextApiKeyRef.current = true;
                      setTextApiKeyDeletePending(true);
                      setApiKey('');
                      setApiKeyConfigured(false);
                      delete apiKeyCacheRef.current[provider];
                    }}
                  >
                    {t('settings.clearApiKey')}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </SettingRow>
      {isOAuthProviderSelected && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: -4, marginBottom: 4 }}>
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
            onSuccess={performSave}
          />
        </div>
      )}

      <SettingRow label={t('settings.primaryModel')}>
        <AutoComplete
          value={textModel}
          onChange={(v) => {
            setTextModel(v);
            if (v.trim()) textModelCacheRef.current[provider] = v.trim();
          }}
          options={modelOptions}
          allowClear
          size="small"
          style={{ width: 220 }}
          placeholder="glm-5"
          filterOption={(input, option) =>
            (option?.value ?? '').toLowerCase().includes(input.toLowerCase())
          }
        />
      </SettingRow>

      <Collapse
        activeKey={advancedOpen ? ['advanced'] : []}
        onChange={(keys) => setAdvancedOpen((keys as string[]).includes('advanced'))}
        size="small"
        items={[
          {
            key: 'advanced',
            label: t('settings.advancedTextEndpoint'),
            children: (
              <>
                <SettingRow label={t('settings.customApiUrl')}>
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
                        { value: 'openai-responses', label: 'OpenAI Responses' },
                        { value: 'anthropic-messages', label: 'Anthropic Compatible' },
                      ]}
                    />
                  </SettingRow>
                )}
              </>
            ),
          },
        ]}
      />

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
            <>
              <Button
                size="small"
                style={{ width: 220, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                onClick={() => setVisionProviderPickerOpen(true)}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {providerLabel(visionProvider, t)}
                  {currentVisionProviderHasSavedKey ? ` · ${t('settings.providerConfigured')}` : ''}
                </span>
                <span style={{ opacity: 0.65, marginLeft: 8, flexShrink: 0 }}>
                  {visionProvider}
                </span>
              </Button>
              <ProviderPickerModal
                open={visionProviderPickerOpen}
                value={visionProvider}
                title={t('settings.visionProvider')}
                onSelect={(id) => {
                  setVisionProviderPickerOpen(false);
                  handleVisionProviderChange(id);
                }}
                onClose={() => setVisionProviderPickerOpen(false)}
              />
            </>
          </SettingRow>

          <SettingRow label={t('settings.visionModel')}>
            <AutoComplete
              value={visionModel}
              onChange={(v) => {
                setVisionModel(v);
                if (v.trim()) visionModelCacheRef.current[visionProvider] = v.trim();
              }}
              options={visionModelOptions}
              allowClear
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 220 }}>
                  <Input
                    value={visionApiKey}
                    onChange={(e) => {
                      deleteVisionApiKeyRef.current = false;
                      setVisionApiKeyDeletePending(false);
                      const v = e.target.value;
                      setVisionApiKey(v);
                      if (v.trim()) {
                        visionApiKeyCacheRef.current[visionProvider] = v.trim();
                      }
                    }}
                    size="small"
                    style={{ width: 220 }}
                    placeholder={currentVisionProviderHasSavedKey && !visionApiKey ? t('setup.apiKeyExisting') : t('setup.apiKeyPlaceholder')}
                  />
                  {visionApiKeyStatus ? (
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {visionApiKeyStatus}
                    </Text>
                  ) : null}
                  {(currentVisionProviderHasSavedKey || !!visionApiKey.trim()) && (
                    <div style={{ display: 'flex', justifyContent: 'flex-end', width: 220 }}>
                      <Button
                        size="small"
                        type="link"
                        danger
                        style={{ padding: '0 4px', flexShrink: 0 }}
                        onClick={() => {
                          deleteVisionApiKeyRef.current = true;
                          setVisionApiKeyDeletePending(true);
                          setVisionApiKey('');
                          setVisionApiKeyConfigured(false);
                          delete visionApiKeyCacheRef.current[visionProvider];
                        }}
                      >
                        {t('settings.clearApiKey')}
                      </Button>
                    </div>
                  )}
                </div>
              </SettingRow>
            </>
          )}
        </>
      )}

      {/* ── Web Search (optional) ── */}
      <Divider style={{ margin: '4px 0 8px' }} />

      <SettingRow label={t('settings.webSearch')} description={t('settings.webSearchHint')}>
        <Segmented
          value={webSearchEnabled ? 'on' : 'off'}
          onChange={(v) => setWebSearchEnabled(v === 'on')}
          options={[
            { label: 'OFF', value: 'off' },
            { label: 'ON', value: 'on' },
          ]}
          size="small"
        />
      </SettingRow>

      {webSearchEnabled && (
        <>
          <SettingRow label={t('settings.webSearchProvider')}>
            <Select
              value={webSearchProvider || undefined}
              onChange={setWebSearchProvider}
              size="small"
              style={{ width: 220 }}
              placeholder={t('settings.webSearchProvider')}
              options={[
                { value: 'brave', label: 'Brave Search' },
                { value: 'gemini', label: 'Gemini (Google Search)' },
                { value: 'grok', label: 'Grok (xAI)' },
                { value: 'kimi', label: 'Kimi (Moonshot)' },
                { value: 'perplexity', label: 'Perplexity' },
              ]}
            />
          </SettingRow>

          <SettingRow label={t('settings.webSearchApiKey')}>
            <Input
              value={webSearchApiKey}
              onChange={(e) => setWebSearchApiKey(e.target.value)}
              size="small"
              style={{ width: 220 }}
              placeholder={webSearchApiKeyConfigured ? t('setup.apiKeyExisting') : t('setup.apiKeyPlaceholder')}
            />
          </SettingRow>

          <div style={{ padding: '0 0 4px' }}>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {t('settings.webSearchPriorityHint')}
            </Text>
          </div>
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

      {/* ── Heartbeat section ── */}
      <Divider style={{ margin: '4px 0 8px' }} />

      <SettingRow label={t('settings.heartbeat')} description={t('settings.heartbeatHint')}>
        <Segmented
          value={heartbeatEnabled ? 'on' : 'off'}
          onChange={(v) => setHeartbeatEnabled(v === 'on')}
          options={[
            { label: 'OFF', value: 'off' },
            { label: 'ON', value: 'on' },
          ]}
          size="small"
        />
      </SettingRow>

      {heartbeatEnabled && (
        <SettingRow label={t('settings.heartbeatInterval')}>
          <Select
            value={heartbeatInterval}
            onChange={setHeartbeatInterval}
            size="small"
            style={{ width: 220 }}
            options={[
              { value: '15m', label: t('settings.heartbeatInterval15m') },
              { value: '30m', label: t('settings.heartbeatInterval30m') },
              { value: '1h', label: t('settings.heartbeatInterval1h') },
              { value: '2h', label: t('settings.heartbeatInterval2h') },
              { value: '4h', label: t('settings.heartbeatInterval4h') },
            ]}
          />
        </SettingRow>
      )}

      {/* ── Supervisor (dual-model) section ── */}
      <Divider style={{ margin: '4px 0 8px' }} />

      <SettingRow label={t('settings.supervisor')} description={t('settings.supervisorHint')}>
        <Segmented
          value={supervisorEnabled ? 'on' : 'off'}
          onChange={(v) => {
            const enabled = v === 'on';
            setSupervisorEnabled(enabled);
          }}
          options={[
            { label: 'OFF', value: 'off' },
            { label: 'ON', value: 'on' },
          ]}
          size="small"
        />
      </SettingRow>

      {supervisorEnabled && (
        <>
          {/* Supervisor Model Source — block layout to avoid label compression */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: tokens.text.primary }}>
              {t('settings.supervisorModelSource')}
            </div>
            <Radio.Group
              value={supervisorUseMainModel ? 'inherit' : 'independent'}
              onChange={(e) => {
                const useMain = e.target.value === 'inherit';
                setSupervisorUseMainModel(useMain);
                if (useMain) {
                  setSupervisorProvider('');
                  setSupervisorModelId('');
                  setSupervisorModel('');
                }
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Radio value="inherit">
                  <span>{t('settings.supervisorInheritMain')}</span>
                </Radio>
                {supervisorUseMainModel && provider && textModel && (
                  <div style={{ marginLeft: 24, fontSize: 12, color: tokens.text.muted }}>
                    {providerLabel(provider, t)} / {textModel}
                  </div>
                )}
                <Radio value="independent">
                  <span>{t('settings.supervisorIndependent')}</span>
                </Radio>
              </div>
            </Radio.Group>
          </div>

          {!supervisorUseMainModel && (
            <>
              <SettingRow label={t('settings.supervisorProvider')} description={t('settings.supervisorProviderHint')}>
                <>
                  <Button
                    size="small"
                    style={{ width: 220, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                    onClick={() => setSupervisorProviderPickerOpen(true)}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {supervisorProvider ? providerLabel(supervisorProvider, t) : t('settings.supervisorProviderPlaceholder')}
                      {supervisorProvider && currentSupervisorProviderHasSavedKey ? ` · ${t('settings.providerConfigured')}` : ''}
                    </span>
                    {supervisorProvider && (
                      <span style={{ opacity: 0.65, marginLeft: 8, flexShrink: 0 }}>
                        {supervisorProvider}
                      </span>
                    )}
                  </Button>
                  <ProviderPickerModal
                    open={supervisorProviderPickerOpen}
                    value={supervisorProvider}
                    title={t('settings.supervisorProvider')}
                    excludeProviderIds={provider ? [provider] : undefined}
                    includeProviderIds={[...SUPERVISOR_REVIEWER_PROVIDER_IDS]}
                    onSelect={(id) => {
                      setSupervisorProviderPickerOpen(false);
                      handleSupervisorProviderChange(id);
                    }}
                    onClose={() => setSupervisorProviderPickerOpen(false)}
                  />
                </>
              </SettingRow>

              {supervisorProvider && (
                <SettingRow label={t('settings.supervisorModel')} description={t('settings.supervisorModelHint')}>
                  <AutoComplete
                    value={supervisorModelId}
                    onChange={(v) => {
                      setSupervisorModelId(v);
                      const newRef = v ? `${supervisorProvider}/${v}` : '';
                      setSupervisorModel(newRef);
                    }}
                    options={supervisorModelOptions.length > 0 ? supervisorModelOptions : undefined}
                    allowClear
                    size="small"
                    style={{ width: 220 }}
                    placeholder="model-id"
                    filterOption={(input, option) =>
                      (option?.value ?? '').toLowerCase().includes(input.toLowerCase())
                    }
                  />
                </SettingRow>
              )}

              {!supervisorProvider && (
                <SettingRow label={t('settings.supervisorModel')} description={t('settings.supervisorModelHint')}>
                  <AutoComplete
                    value={supervisorModel}
                    onChange={(v) => {
                      setSupervisorModel(v);
                      // Parse provider/modelId
                      const slashIdx = v.indexOf('/');
                      if (slashIdx >= 0) {
                        setSupervisorProvider(v.slice(0, slashIdx));
                        setSupervisorModelId(v.slice(slashIdx + 1));
                      } else {
                        setSupervisorModelId(v);
                      }
                    }}
                    allowClear
                    size="small"
                    style={{ width: 220 }}
                    placeholder="provider/model-id"
                    filterOption={(input, option) =>
                      String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())
                    }
                  />
                </SettingRow>
              )}

              {/* Supervisor API Key — shown when provider is selected */}
              {supervisorProvider && (
                <SettingRow label={t('settings.apiKeyLabel')}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 220 }}>
                    <Input
                      value={supervisorApiKey}
                      onChange={(e) => {
                        deleteSupervisorApiKeyRef.current = false;
                        setSupervisorApiKeyDeletePending(false);
                        const v = e.target.value;
                        setSupervisorApiKey(v);
                        if (v.trim()) {
                          supervisorApiKeyCacheRef.current[supervisorProvider] = v.trim();
                        }
                      }}
                      size="small"
                      style={{ width: 220 }}
                      disabled={supervisorIsOAuth}
                      placeholder={
                        supervisorIsOAuth
                          ? t('setup.openaiCodexOauthNoApiKey')
                          : (currentSupervisorProviderHasSavedKey && !supervisorApiKey ? t('setup.apiKeyExisting') : t('setup.apiKeyPlaceholder'))
                      }
                    />
                    {!supervisorIsOAuth && (
                      <>
                        {supervisorApiKeyStatus ? (
                          <Text type="secondary" style={{ fontSize: 11 }}>
                            {supervisorApiKeyStatus}
                          </Text>
                        ) : null}
                        {(currentSupervisorProviderHasSavedKey || !!supervisorApiKey.trim()) && (
                          <div style={{ display: 'flex', justifyContent: 'flex-end', width: 220 }}>
                            <Button
                              size="small"
                              type="link"
                              danger
                              style={{ padding: '0 4px', flexShrink: 0 }}
                              onClick={() => {
                                deleteSupervisorApiKeyRef.current = true;
                                setSupervisorApiKeyDeletePending(true);
                                setSupervisorApiKey('');
                                setSupervisorApiKeyConfigured(false);
                                delete supervisorApiKeyCacheRef.current[supervisorProvider];
                              }}
                            >
                              {t('settings.clearApiKey')}
                            </Button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </SettingRow>
              )}

              {/* Supervisor Advanced Settings */}
              {supervisorProvider && (
            <Collapse
              activeKey={supervisorAdvancedOpen ? ['supervisorAdvanced'] : []}
              onChange={(keys) => setSupervisorAdvancedOpen((keys as string[]).includes('supervisorAdvanced'))}
              size="small"
              items={[
                {
                  key: 'supervisorAdvanced',
                  label: t('settings.advancedSupervisor'),
                  children: (
                    <>
                      {/* Supervisor Base URL — always shown */}
                      <SettingRow label={t('settings.customApiUrl')}>
                        <Input
                          value={supervisorBaseUrl}
                          onChange={(e) => setSupervisorBaseUrl(e.target.value)}
                          size="small"
                          style={{ width: 220 }}
                          placeholder="https://api.openai.com/v1"
                        />
                      </SettingRow>

                      {/* Supervisor API Protocol — only for custom provider */}
                      {supervisorProvider === 'custom' && (
                        <SettingRow label={t('settings.apiProtocol')}>
                          <Select
                            value={supervisorApi}
                            onChange={setSupervisorApi}
                            size="small"
                            style={{ width: 220 }}
                            options={[
                              { value: 'openai-completions', label: 'OpenAI Compatible' },
                              { value: 'openai-responses', label: 'OpenAI Responses' },
                              { value: 'anthropic-messages', label: 'Anthropic Compatible' },
                            ]}
                          />
                        </SettingRow>
                      )}
                    </>
                  ),
                },
              ]}
            />
          )}
            </>
          )}

          <SettingRow label={t('settings.reviewMode')} description={t('settings.reviewModeHint')}>
            <Select
              value={reviewMode}
              onChange={(v) => setReviewMode(v)}
              size="small"
              style={{ width: 220 }}
              popupMatchSelectWidth={false}
              options={[
                { value: 'filter-only', label: t('settings.reviewModeFilter') },
                { value: 'correct', label: t('settings.reviewModeCorrect') },
                { value: 'full', label: t('settings.reviewModeFull') },
              ]}
              optionRender={(option) => (
                <div style={{ padding: '4px 0' }}>
                  <div style={{ fontWeight: 500 }}>{option.label}</div>
                  <div style={{ fontSize: 12, color: tokens.text.muted, marginTop: 2 }}>
                    {option.value === 'filter-only' && t('settings.reviewModeFilterDesc')}
                    {option.value === 'correct' && t('settings.reviewModeCorrectDesc')}
                    {option.value === 'full' && t('settings.reviewModeFullDesc')}
                  </div>
                </div>
              )}
            />
          </SettingRow>

          <SettingRow label={t('settings.appendReviewToChannelOutput')} description={t('settings.appendReviewToChannelOutputHint')}>
            <Segmented
              value={appendReviewToChannelOutput ? 'on' : 'off'}
              onChange={(v) => setAppendReviewToChannelOutput(v === 'on')}
              options={[
                { label: 'OFF', value: 'off' },
                { label: 'ON', value: 'on' },
              ]}
              size="small"
            />
          </SettingRow>

          <SettingRow
            label={
              <span>
                {t('settings.deviationThreshold')}
                <Tooltip title={t('settings.deviationThresholdTooltip')}>
                  <QuestionCircleOutlined style={{ marginLeft: 4, color: tokens.text.muted, fontSize: 12 }} />
                </Tooltip>
              </span>
            }
            description={t('settings.deviationThresholdHint')}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: 220 }}>
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={deviationThreshold}
                onChange={(e) => setDeviationThreshold(parseFloat(e.target.value))}
                style={{ flex: 1, accentColor: tokens.accent.blue }}
              />
              <Text style={{ fontSize: 12, fontFamily: "'Fira Code', monospace", width: 32, textAlign: 'right' }}>
                {deviationThreshold.toFixed(1)}
              </Text>
            </div>
          </SettingRow>

          <SettingRow label={t('settings.forceRegenerate')} description={t('settings.forceRegenerateHint')}>
            <Segmented
              value={forceRegenerate ? 'on' : 'off'}
              onChange={(v) => setForceRegenerate(v === 'on')}
              options={[
                { label: 'OFF', value: 'off' },
                { label: 'ON', value: 'on' },
              ]}
              size="small"
            />
          </SettingRow>

          {forceRegenerate && (
            <SettingRow
              label={
                <span>
                  {t('settings.maxRegenerateAttempts')}
                  <Tooltip title={t('settings.maxRegenerateAttemptsTooltip')}>
                    <QuestionCircleOutlined style={{ marginLeft: 4, color: tokens.text.muted, fontSize: 12 }} />
                  </Tooltip>
                </span>
              }
              description={t('settings.maxRegenerateAttemptsHint')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: 220 }}>
                <input
                  type="range"
                  min="1"
                  max="5"
                  step="1"
                  value={maxRegenerateAttempts}
                  onChange={(e) => setMaxRegenerateAttempts(parseInt(e.target.value, 10))}
                  style={{ flex: 1, accentColor: tokens.accent.blue }}
                />
                <Text style={{ fontSize: 12, fontFamily: "'Fira Code', monospace", width: 32, textAlign: 'right' }}>
                  {maxRegenerateAttempts}
                </Text>
              </div>
            </SettingRow>
          )}

          <div style={{ padding: '0 0 4px' }}>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {t('settings.supervisorSaveHint')}
            </Text>
          </div>

          {/* Active session info: research goal + target conclusions */}
          {supervisorStatus?.sessionsInfo && supervisorStatus.sessionsInfo.length > 0 && (
            <div style={{ marginTop: 4, padding: '8px', background: tokens.bg.surface, borderRadius: 6, border: `1px solid ${tokens.border.default}` }}>
              {supervisorStatus.sessionsInfo.map((session) => (
                <div key={session.sessionId}>
                  {session.researchGoal && (
                    <div style={{ marginBottom: 4 }}>
                      <Text style={{ fontSize: 11, fontWeight: 600 }}>{t('settings.supervisorGoalParsed')}:</Text>
                      <div style={{ marginTop: 2 }}>
                        <Text type="secondary" style={{ fontSize: 11 }}>{session.researchGoal}</Text>
                        {session.goalConfirmed && (
                          <Text style={{ fontSize: 10, color: tokens.accent.green, marginLeft: 4 }}>✓</Text>
                        )}
                      </div>
                    </div>
                  )}
                  {session.targetConclusions.length > 0 && (
                    <div>
                      <Text style={{ fontSize: 11, fontWeight: 600 }}>{t('settings.supervisorTargetConclusions')}:</Text>
                      <ul style={{ margin: '2px 0 0 16px', padding: 0, listStyle: 'disc' }}>
                        {session.targetConclusions.map((target, idx) => (
                          <li key={idx}><Text type="secondary" style={{ fontSize: 11 }}>{target}</Text></li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {!session.researchGoal && session.targetConclusions.length === 0 && (
                    <Text type="secondary" style={{ fontSize: 11 }}>{t('settings.supervisorNoTargets')}</Text>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Save config (model + vision + proxy) ── */}
      <Divider style={{ margin: '4px 0 8px' }} />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
            {t('settings.restartHint')}
          </Text>
          <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
            {textApiKeyStatus}
            {visionApiKeyStatus ? ` · ${visionApiKeyStatus}` : ''}
          </Text>
        </div>
        <Button type="primary" size="small" onClick={handleSave} loading={saving || pendingRestart} disabled={pendingRestart} style={{ flexShrink: 0 }}>
          {pendingRestart ? t('setup.gatewayRestarting') : t('settings.save')}
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

      {/* ── Display section ── */}
      <Divider style={{ margin: '12px 0 8px' }} />

      <SettingRow label={t('settings.showSystemFiles')} description={t('settings.showSystemFilesHint')}>
        <Segmented
          value={showSystemFiles ? 'on' : 'off'}
          onChange={(v) => setShowSystemFiles(v === 'on')}
          options={[
            { label: 'OFF', value: 'off' },
            { label: 'ON', value: 'on' },
          ]}
          size="small"
        />
      </SettingRow>

      <Divider style={{ margin: '12px 0 8px' }} />

      {/* ── About section (inline) ── */}
      <AboutSection />

      <div style={{ height: 16 }} />
    </div>
  );
}
