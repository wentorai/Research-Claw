import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  App,
  AutoComplete,
  Button,
  Collapse,
  Divider,
  Input,
  InputNumber,
  Radio,
  Select,
  Spin,
  Switch,
  Tooltip,
  Typography,
} from 'antd';
import { CloudDownloadOutlined, CopyOutlined, KeyOutlined, PoweroffOutlined, QuestionCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import OAuthModal from '../OAuthModal';
import ProviderPickerModal, { providerLabel, type SavedCustomProfileOption } from '../providers/ProviderPickerModal';
import ApiProfilesSection from '../settings/ApiProfilesSection';
import { useTranslation } from 'react-i18next';
import { useConfigStore } from '../../stores/config';
import { useGatewayStore } from '../../stores/gateway';
import { useSupervisorStore } from '../../stores/supervisor';
import { useUiStore } from '../../stores/ui';
import { getThemeTokens } from '../../styles/theme';
import { buildThemedModalStyles, confirmApplyAppUpdate } from '../../utils/app-update-ui';
import {
  buildActivateProfileConfig,
  buildDeleteApiProfilesConfig,
  buildSaveConfig,
  extractConfigFields,
  extractProviderFieldsForEditor,
  isManualModelEndpoint,
  mergeProjectConfigsPreservingProviders,
  serializeConfigForGatewayApply,
  validateModelTuning,
  clampSavedContextWindow,
  CONTEXT_WINDOW_MIN,
  CONTEXT_WINDOW_MAX,
  CONTEXT_WINDOW_INPUT_MIN,
} from '../../utils/config-patch';
import {
  allocateNextProfileProviderId,
  collectApiProfileRestoreEntries,
  isApiProfileProviderKey,
  listApiProfilesFromConfig,
  mergeApiProfileAuthStatuses,
  profileIdToDisplayName,
  type ApiProfile,
  type ApiProfileEntry,
} from '../../utils/api-profiles';
import { PROVIDER_PRESETS, detectPresetFromProvider, getPreset, inferApiFromUrl, protocolProbeOrder, type ApiProtocol } from '../../utils/provider-presets';
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

// How long a high-risk tool call waits for the reviewer model's deep review before
// failing open. Must match `toolReviewGateMs` in the plugin manifest; the presets are
// what the UI offers, the manifest still accepts 500–30000ms from other callers.
// Exported so `supervisor-gate-dashboard.test.tsx` can pin both to the manifest —
// otherwise "must match" is a comment with nothing enforcing it.
export const SUPERVISOR_GATE_DEFAULT_MS = 4000;
export const SUPERVISOR_GATE_PRESETS_MS = [2000, 4000, 10000] as const;

const { Text } = Typography;

const CONNECTION_LOST_RE = /connection closed|not connected/i;

/**
 * Map a save error to a user-facing toast. Only genuine connection-loss errors
 * get the "gateway may have restarted" hint; everything else (e.g. a gateway-side
 * config validation rejection) surfaces the actual reason rather than falsely
 * blaming a restart.
 */
function saveErrorToast(
  error: unknown,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const reason = error instanceof Error ? error.message : String(error);
  return CONNECTION_LOST_RE.test(reason)
    ? t('settings.saveFailed')
    : t('settings.saveFailedInvalid', { reason });
}

// --- Setting row layout ---

function SettingRow({
  label,
  description,
  children,
  vertical = false,
}: {
  label: React.ReactNode;
  description?: string;
  children: React.ReactNode;
  vertical?: boolean;
}) {
  const labelBlock = (
    <div style={{ flex: vertical ? undefined : 1, minWidth: 0 }}>
      <Text style={{ fontSize: 13 }}>{label}</Text>
      {description && (
        <div>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {description}
          </Text>
        </div>
      )}
    </div>
  );
  if (vertical) {
    // Stacked layout: label on top, full-width control below. Used in the
    // advanced endpoint sections where long labels would crush a side control.
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', padding: '10px 0', gap: 6 }}>
        {labelBlock}
        <div style={{ width: '100%', minWidth: 0 }}>{children}</div>
      </div>
    );
  }
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
      {labelBlock}
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
  const pendingConfigRestart = useConfigStore((s) => s.pendingConfigRestart);
  const updateInfo = useUiStore((s) => s.appUpdateInfo);
  const setUpdateInfo = useUiStore((s) => s.setAppUpdateInfo);
  const [updateChecking, setUpdateChecking] = useState(false);

  // Reset the local About-section spinner when the shared restart verifier finishes.
  useEffect(() => {
    if (restarting && !pendingConfigRestart) {
      setRestarting(false);
    }
  }, [pendingConfigRestart, restarting]);

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
      `Research-Claw service runtime ${serverVersion ?? 'unknown'}`,
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
        const configStore = useConfigStore.getState();
        configStore.beginConfigOperation('persisting');
        configStore.setPendingConfigRestart(true);
        setRestarting(true);
        try {
          const snapshot = await client.request<{
            parsed?: Record<string, unknown>;
            config?: Record<string, unknown>;
            raw?: string | null;
            hash?: string;
          }>('config.get', {});
          const snapshotConfig = (snapshot.parsed ?? snapshot.config ?? {}) as Record<string, unknown>;
          await client.request('config.apply', {
            raw: serializeConfigForGatewayApply(snapshotConfig),
            baseHash: snapshot.hash,
          });
          message.success(t('settings.restartSuccess'));
          configStore.setConfigOperationPhase('restart_scheduled');
        } catch (error) {
          const messageText = error instanceof Error ? error.message : String(error);
          configStore.setConfigOperationPhase('failed', messageText);
          configStore.setPendingConfigRestart(false);
          setRestarting(false);
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
    </>
  );
}

// --- Main SettingsPanel (single scrollable panel) ---

type ModelOption = { value: string; label: string };

/**
 * Options come from the static preset snapshot, then merge in models actually
 * present in the saved gateway config plus the current value — so a configured
 * model that the snapshot lacks (e.g. glm-5v-turbo) stays selectable after the
 * field is cleared. imageOnly keeps the vision picker to image-capable models
 * but never hides the current value.
 */
function buildModelOptions(
  presetModels: ReadonlyArray<{ id: string; name?: string; input?: string[] }>,
  savedModels: ReadonlyArray<{ id: string; name?: string; input?: string[] }> | undefined,
  currentValue: string,
  imageOnly = false,
): ModelOption[] {
  const seen = new Set<string>();
  const out: ModelOption[] = [];
  const add = (id: string, name?: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ value: id, label: name && name !== id ? `${id} — ${name}` : id });
  };
  for (const m of presetModels) {
    if (imageOnly && !m.input?.includes('image')) continue;
    add(m.id, m.name);
  }
  for (const m of savedModels ?? []) {
    if (imageOnly && !m.input?.includes('image') && m.id !== currentValue) continue;
    add(m.id, m.name);
  }
  if (currentValue) add(currentValue);
  return out;
}

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
  const notificationSoundEnabled = useUiStore((s) => s.notificationSoundEnabled);
  const setNotificationSoundEnabled = useUiStore((s) => s.setNotificationSoundEnabled);

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

  // Manual-endpoint tuning (custom API profiles + ollama/vllm only): a user-pinned
  // text contextWindow + the global compaction knobs that size the whole-session
  // preemptive-compaction trigger. null = leave to OC/preset defaults.
  const [customContextWindow, setCustomContextWindow] = useState<number | null>(null);

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
  const [reviewMode, setReviewMode] = useState<'filter-only' | 'correct'>('correct');
  const [deviationThreshold, setDeviationThreshold] = useState(0.5);
  const [forceRegenerate, setForceRegenerate] = useState(false);
  const [maxRegenerateAttempts, setMaxRegenerateAttempts] = useState(3);
  // Deep-review budget for a high-risk tool call. Mirrors the plugin manifest default
  // (openclaw.plugin.json → toolReviewGateMs). A value outside the presets — set by
  // hand or over RPC — is kept as-is and simply leaves no preset selected.
  const [toolReviewGateMs, setToolReviewGateMs] = useState(SUPERVISOR_GATE_DEFAULT_MS);
  const [restoringSupervisorDefaults, setRestoringSupervisorDefaults] = useState(false);

  // Cache for supervisor API keys per provider
  const supervisorApiKeyCacheRef = useRef<Record<string, string>>({});
  const deleteSupervisorApiKeyRef = useRef(false);

  // Sync supervisor state from plugin
  useEffect(() => {
    if (supervisorConfig?.enabled !== undefined) {
      setSupervisorEnabled(supervisorConfig.enabled);
    }
    if (supervisorConfig) {
      const model = supervisorConfig.supervisorModel ?? '';
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

      const storedReviewMode = supervisorConfig.reviewMode as string | undefined;
      setReviewMode(storedReviewMode === 'filter-only' ? 'filter-only' : 'correct');
      setToolReviewGateMs(supervisorConfig.toolReviewGateMs ?? SUPERVISOR_GATE_DEFAULT_MS);
      const cc = supervisorConfig.courseCorrection;
      if (cc) {
        setDeviationThreshold(cc.deviationThreshold ?? 0.5);
        setForceRegenerate(cc.forceRegenerate ?? false);
        setMaxRegenerateAttempts(cc.maxRegenerateAttempts ?? 3);
      }
      // Fold the supervisor fields into the baseline once, on first settle. Later
      // re-applies (reconnects) must not re-baseline, or they'd swallow core edits.
      if (!supervisorBaselinedRef.current) {
        supervisorBaselinedRef.current = true;
        setBaselineTick((t) => t + 1);
      } else if (supervisorRestoreBaselineRef.current) {
        // The restore RPC has already persisted these values. Once they hydrate,
        // make them the new baseline instead of offering a redundant global save.
        supervisorRestoreBaselineRef.current = false;
        setBaselineTick((t) => t + 1);
      }
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

  // --- Protocol probe (Test button) state machine ---
  type ProbeOutcome =
    | { ok: true; protocol: ApiProtocol }
    | { ok: false; reason: string };
  const [probing, setProbing] = useState<'text' | 'vision' | null>(null);
  const [probeResult, setProbeResult] = useState<{ text?: ProbeOutcome; vision?: ProbeOutcome }>({});
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Map a probe `reason` to its localized message-key. */
  const probeReasonText = useCallback(
    (reason: string): string => {
      switch (reason) {
        case 'missing-key':
          return t('settings.probeMissingKeyHint');
        case 'invalid-url':
          return t('settings.probeInvalidUrl');
        case 'auth-failed':
          return t('settings.probeAuthFailed');
        case 'no-protocol':
          return t('settings.probeNoProtocol');
        case 'network-error':
        default:
          return t('settings.probeNetworkError');
      }
    },
    [t],
  );

  /** Human label for a detected protocol (mirrors the protocol Select labels). */
  const protocolLabel = useCallback((protocol: ApiProtocol): string => {
    switch (protocol) {
      case 'openai-responses':
        return 'OpenAI Responses';
      case 'anthropic-messages':
        return 'Anthropic Compatible';
      case 'openai-completions':
      default:
        return 'OpenAI Compatible';
    }
  }, []);

  /** Probe a single endpoint, auto-applying the detected protocol on success. */
  const runProtocolProbe = useCallback(
    async (endpoint: 'text' | 'vision') => {
      if (probing !== null) return;
      const url = endpoint === 'text' ? baseUrl : visionBaseUrl;
      const key = endpoint === 'text' ? apiKey : visionApiKey;
      const model = endpoint === 'text' ? textModel : visionModel;
      const client = useGatewayStore.getState().client;
      if (!client?.isConnected) {
        message.error(t('oauth.notConnected'));
        return;
      }
      setProbing(endpoint);
      setProbeResult((prev) => ({ ...prev, [endpoint]: undefined }));
      try {
        const TIMEOUT_MS = 24000;
        const result = (await Promise.race([
          client.request('rc.provider.probeProtocol', {
            baseUrl: url,
            apiKey: key,
            model,
            order: protocolProbeOrder(url),
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('probe-timeout')), TIMEOUT_MS),
          ),
        ])) as { detected: ApiProtocol | null; reason: string };
        if (!mountedRef.current) return;
        if (result.reason === 'detected' && result.detected) {
          const detected = result.detected;
          if (endpoint === 'text') setApi(detected);
          else setVisionApi(detected);
          setProbeResult((prev) => ({ ...prev, [endpoint]: { ok: true, protocol: detected } }));
          message.success(`✓ ${t('settings.protocolVerified')}: ${protocolLabel(detected)}`);
        } else {
          const reason = result.reason || 'no-protocol';
          setProbeResult((prev) => ({ ...prev, [endpoint]: { ok: false, reason } }));
          message.error(probeReasonText(reason));
        }
      } catch {
        if (!mountedRef.current) return;
        setProbeResult((prev) => ({ ...prev, [endpoint]: { ok: false, reason: 'network-error' } }));
        message.error(probeReasonText('network-error'));
      } finally {
        if (mountedRef.current) setProbing(null);
      }
    },
    [
      probing,
      baseUrl,
      visionBaseUrl,
      apiKey,
      visionApiKey,
      textModel,
      visionModel,
      message,
      t,
      protocolLabel,
      probeReasonText,
    ],
  );

  const pendingRestart = useConfigStore((s) => s.pendingConfigRestart);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [visionAdvancedOpen, setVisionAdvancedOpen] = useState(false);

  // Dirty tracking: the Save button stays disabled until a config-class field
  // diverges from the last config-driven snapshot. UI-only prefs (showSystemFiles,
  // notificationSoundEnabled) persist instantly and are intentionally excluded.
  const [configBaseline, setConfigBaseline] = useState<string | null>(null);
  // The active text provider captured at the last config-driven hydration — lets the
  // footer button distinguish "switch to an existing config (Apply)" from "save edits".
  const [baselineProvider, setBaselineProvider] = useState<string | null>(null);
  const [baselineTick, setBaselineTick] = useState(0);
  const supervisorBaselinedRef = useRef(false);
  const supervisorRestoreBaselineRef = useRef(false);
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  const [supervisorAdvancedOpen, setSupervisorAdvancedOpen] = useState(false);
  const [supervisorBehaviorOpen, setSupervisorBehaviorOpen] = useState(false);

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
  const profileLabelRef = useRef<Record<string, string>>({});
  const [profileLabel, setProfileLabel] = useState('');
  const pendingDeleteProfileIdsRef = useRef<string[]>([]);

  const isOAuthProviderSelected = isOAuthProvider(provider);
  const visionSeparateProvider = visionProvider !== provider;
  const [oauthModalOpen, setOauthModalOpen] = useState(false);
  const [providerPickerOpen, setProviderPickerOpen] = useState(false);
  const [visionProviderPickerOpen, setVisionProviderPickerOpen] = useState(false);
  const [supervisorProviderPickerOpen, setSupervisorProviderPickerOpen] = useState(false);
  const [textApiKeyDeletePending, setTextApiKeyDeletePending] = useState(false);
  const [visionApiKeyDeletePending, setVisionApiKeyDeletePending] = useState(false);
  const [authConfiguredByProvider, setAuthConfiguredByProvider] = useState<Record<string, boolean>>({});

  // Serialized snapshot of every field that feeds buildSaveConfig — the unit the
  // dirty check compares against the baseline. Keep this in sync with performSave.
  const formSignature = useMemo(
    () =>
      JSON.stringify([
        provider, baseUrl, api, apiKey, textModel,
        // The context window only reaches the saved config for manual endpoints
        // (see buildSaveConfig), so normalize away for presets — otherwise a stale
        // tuning value dirties the form on preset switch.
        isManualModelEndpoint(provider) ? customContextWindow : null,
        visionEnabled, visionProvider, visionModel, visionBaseUrl, visionApi, visionApiKey,
        proxyEnabled, proxyUrl,
        webSearchEnabled, webSearchProvider, webSearchApiKey,
        heartbeatEnabled, heartbeatInterval,
        supervisorEnabled, supervisorProvider, supervisorModelId, supervisorUseMainModel,
        reviewMode, deviationThreshold, forceRegenerate, maxRegenerateAttempts, toolReviewGateMs,
        textApiKeyDeletePending, visionApiKeyDeletePending, supervisorApiKeyDeletePending,
        // Only custom profiles carry an editable label; presets have none, so the
        // label is normalized away for them — otherwise a stale label left over from
        // a previous provider would dirty the form when switching back to a preset.
        isApiProfileProviderKey(provider) ? profileLabel : '',
      ]),
    [
      provider, baseUrl, api, apiKey, textModel,
      customContextWindow,
      visionEnabled, visionProvider, visionModel, visionBaseUrl, visionApi, visionApiKey,
      proxyEnabled, proxyUrl,
      webSearchEnabled, webSearchProvider, webSearchApiKey,
      heartbeatEnabled, heartbeatInterval,
      supervisorEnabled, supervisorProvider, supervisorModelId, supervisorUseMainModel,
      reviewMode, deviationThreshold, forceRegenerate, maxRegenerateAttempts, toolReviewGateMs,
      textApiKeyDeletePending, visionApiKeyDeletePending, supervisorApiKeyDeletePending,
      profileLabel,
    ],
  );
  const formSignatureRef = useRef(formSignature);
  formSignatureRef.current = formSignature;
  const providerSnapshotRef = useRef(provider);
  providerSnapshotRef.current = provider;

  // Re-baseline only after a genuine config-driven hydration (baselineTick bump),
  // never on user edits — so the dirty flag survives reconnects with pending edits.
  useEffect(() => {
    setConfigBaseline(formSignatureRef.current);
    setBaselineProvider(providerSnapshotRef.current);
  }, [baselineTick]);

  const isDirty = configBaseline !== null && formSignature !== configBaseline;

  // Snapshot the form signature at the moment the active provider switches (or
  // re-hydrates). Because handleProviderChange hydrates every field synchronously
  // in the same render, this captures the target provider's pristine signature.
  // A later divergence means the user edited fields after switching → Save, not Apply.
  const [switchSignature, setSwitchSignature] = useState<string | null>(null);
  useLayoutEffect(() => {
    setSwitchSignature(formSignatureRef.current);
  }, [provider]);

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
    // Per-text-provider manual window: prefill only when the saved card was pinned.
    setCustomContextWindow(hydrated?.contextWindowManual ? hydrated.contextWindow ?? null : null);
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
    if (!isOAuthProvider(id) && !deleteTextApiKeyRef.current) {
      const cached = apiKeyCacheRef.current[id];
      if (cached && cached.trim()) {
        setApiKeyConfigured(true);
        setApiKey('');
      }
    }
    if (isOAuthProvider(id)) {
      setApiKey('');
      setApiKeyConfigured(false);
    }

    if (isApiProfileProviderKey(id)) {
      const profiles = listApiProfilesFromConfig(providerConfig);
      const label =
        profileLabelRef.current[id] ||
        profiles.find((p) => p.id === id)?.label ||
        profileIdToDisplayName(id) ||
        id;
      profileLabelRef.current[id] = label;
      setProfileLabel(label);
    } else {
      setProfileLabel('');
    }
  }, [gatewayConfig]);

  const apiProfiles = useMemo(() => {
    const cfg = projectConfigCacheRef.current ?? (gatewayConfig as unknown as Record<string, unknown> | null);
    return mergeApiProfileAuthStatuses(
      listApiProfilesFromConfig(cfg),
      authConfiguredByProvider,
    );
  }, [gatewayConfig, authConfiguredByProvider]);

  const loadApiProfileIntoForm = useCallback((profile: ApiProfile) => {
    // Selecting the provider you're already on is a no-op. Re-hydrating would
    // re-derive fields via extractProviderFieldsForEditor — whose `api` falls back
    // to the preset default when the saved block omits it — which differs from the
    // baseline produced by extractConfigFields and would spuriously dirty the form.
    if (profile.id === provider) return;
    handleProviderChange(profile.id);
    profileLabelRef.current[profile.id] = profile.label;
    setProfileLabel(profile.label);
  }, [handleProviderChange, provider]);

  // Single source of truth for the profile list shared by the inline section and
  // the provider picker: persisted profiles + any in-flight (just-created,
  // not-yet-saved) draft, so a draft appears consistently in both surfaces.
  const profileEntries = useMemo<ApiProfileEntry[]>(() => {
    const entries: ApiProfileEntry[] = apiProfiles.map((p) => ({ ...p, unsaved: false }));
    const known = new Set(entries.map((e) => e.id));
    const appendDraft = (
      id: string,
      fields: { label?: string; baseUrl: string; api: string; modelId: string; apiKeyConfigured: boolean },
    ) => {
      if (!isApiProfileProviderKey(id) || known.has(id)) return;
      known.add(id);
      entries.push({
        id,
        label: fields.label || profileLabelRef.current[id] || profileIdToDisplayName(id) || id,
        baseUrl: fields.baseUrl,
        api: fields.api,
        modelId: fields.modelId,
        apiKeyConfigured: fields.apiKeyConfigured,
        isActive: false,
        isBuiltin: false,
        requiresApiKey: true,
        unsaved: true,
      });
    };
    appendDraft(provider, {
      label: profileLabel,
      baseUrl,
      api,
      modelId: textModel,
      apiKeyConfigured: apiKeyConfigured || apiKey.trim().length > 0,
    });
    if (visionEnabled && visionSeparateProvider) {
      appendDraft(visionProvider, {
        baseUrl: visionBaseUrl,
        api: visionApi,
        modelId: visionModel,
        apiKeyConfigured: visionApiKeyConfigured || visionApiKey.trim().length > 0,
      });
    }
    return entries;
  }, [
    apiProfiles,
    provider,
    profileLabel,
    baseUrl,
    api,
    textModel,
    apiKey,
    apiKeyConfigured,
    visionEnabled,
    visionSeparateProvider,
    visionProvider,
    visionBaseUrl,
    visionApi,
    visionModel,
    visionApiKey,
    visionApiKeyConfigured,
  ]);

  const savedCustomProfileOptions = useMemo<SavedCustomProfileOption[]>(
    () => profileEntries.map((e) => ({ id: e.id, label: e.label, unsaved: e.unsaved })),
    [profileEntries],
  );

  // "Apply" vs "Save": switching the active provider to another *already-saved* config
  // (preset / OAuth / persisted profile) is an activation, not new data → label it Apply.
  // New drafts and field edits stay "Save".
  const switchedActiveProvider = baselineProvider !== null && provider !== baselineProvider;
  const targetProviderIsSaved =
    !isApiProfileProviderKey(provider) || apiProfiles.some((p) => p.id === provider);
  // Editing any field after the switch means there's new data to persist, so the
  // action is a Save, not a pure activation (Apply).
  const editedAfterSwitch = switchSignature !== null && formSignature !== switchSignature;
  const isApplyAction =
    isDirty && switchedActiveProvider && targetProviderIsSaved && !editedAfterSwitch;

  const beginNewCustomProfile = useCallback(() => {
    const cfg = projectConfigCacheRef.current ?? (gatewayConfig as unknown as Record<string, unknown> | null);
    const existingIds = new Set(listApiProfilesFromConfig(cfg).map((p) => p.id));
    for (const id of Object.keys(profileLabelRef.current)) {
      if (isApiProfileProviderKey(id)) existingIds.add(id);
    }
    if (isApiProfileProviderKey(provider)) existingIds.add(provider);
    const providerId = allocateNextProfileProviderId(existingIds);
    const defaultLabel =
      providerId === 'custom'
        ? t('setup.providerCustom', { defaultValue: 'Custom / Other' })
        : profileIdToDisplayName(providerId) || providerId;
    profileLabelRef.current[providerId] = defaultLabel;
    setProfileLabel(defaultLabel);
    setAdvancedOpen(true);
    handleProviderChange(providerId);
  }, [gatewayConfig, handleProviderChange, provider, t]);

  const handleAddApiProfile = beginNewCustomProfile;

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

  const beginNewVisionCustomProfile = useCallback(() => {
    const cfg = projectConfigCacheRef.current ?? (gatewayConfig as unknown as Record<string, unknown> | null);
    const existingIds = new Set(listApiProfilesFromConfig(cfg).map((p) => p.id));
    for (const id of Object.keys(profileLabelRef.current)) {
      if (isApiProfileProviderKey(id)) existingIds.add(id);
    }
    if (isApiProfileProviderKey(provider)) existingIds.add(provider);
    if (isApiProfileProviderKey(visionProvider)) existingIds.add(visionProvider);
    const providerId = allocateNextProfileProviderId(existingIds);
    setVisionAdvancedOpen(true);
    handleVisionProviderChange(providerId);
  }, [gatewayConfig, handleVisionProviderChange, provider, visionProvider]);

  const currentPreset = getPreset(provider);
  const modelOptions = buildModelOptions(
    currentPreset.models,
    gatewayConfig?.models?.providers?.[provider]?.models,
    textModel,
  );

  const visionPreset = getPreset(visionProvider);
  const visionModelOptions = buildModelOptions(
    visionPreset.models,
    gatewayConfig?.models?.providers?.[visionProvider]?.models,
    visionModel,
    true,
  );

  // A preset's protocol is fixed by its identity; URL is overridable only to reach
  // same-protocol relays/mirrors. Warn when a remote preset's URL is pointed elsewhere,
  // since a relay that speaks a different protocol needs a Custom profile instead.
  const isLocalPreset = (id: string) => id === 'ollama' || id === 'vllm';
  const normalizeEndpoint = (url: string) => url.trim().replace(/\/+$/, '');
  const textPresetUrlOverridden =
    !isApiProfileProviderKey(provider) &&
    !isOAuthProviderSelected &&
    !isLocalPreset(provider) &&
    !!baseUrl.trim() &&
    normalizeEndpoint(baseUrl) !== normalizeEndpoint(currentPreset.baseUrl);
  const visionPresetUrlOverridden =
    visionSeparateProvider &&
    !isApiProfileProviderKey(visionProvider) &&
    !isOAuthProvider(visionProvider) &&
    !isLocalPreset(visionProvider) &&
    !!visionBaseUrl.trim() &&
    normalizeEndpoint(visionBaseUrl) !== normalizeEndpoint(visionPreset.baseUrl);

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
    setProvider(fields.provider);
    if (isApiProfileProviderKey(fields.provider)) {
      const label =
        profileLabelRef.current[fields.provider] ||
        apiProfiles.find((p) => p.id === fields.provider)?.label ||
        profileIdToDisplayName(fields.provider) ||
        fields.provider;
      profileLabelRef.current[fields.provider] = label;
      setProfileLabel(label);
    } else {
      setProfileLabel('');
    }

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

    // Per-text-provider manual window (prefill only when pinned).
    const textProviderFields = extractProviderFieldsForEditor(configForEditor, fields.provider);
    setCustomContextWindow(
      textProviderFields?.contextWindowManual ? textProviderFields.contextWindow ?? null : null,
    );

    const cfgForProfiles = projectConfigCacheRef.current ?? (gatewayConfig as unknown as Record<string, unknown> | null);
    for (const p of listApiProfilesFromConfig(cfgForProfiles)) {
      profileLabelRef.current[p.id] = p.label;
    }

    // Form was just reset from config (mount / refresh / post-save) — re-baseline.
    setBaselineTick((t) => t + 1);
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

    const configStore = useConfigStore.getState();
    const operationId = configStore.beginConfigOperation('validating');
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

      // Supervisor provider API key (via auth profile)
      const supervisorApiKeyToSend = deleteSupervisorApiKeyRef.current
        ? undefined
        : supervisorApiKey.trim() || supervisorApiKeyCacheRef.current[supervisorProvider]?.trim() || undefined;
      const authActions: Array<{ provider: string; apiKey?: string; clear?: boolean }> = [];
      if (supportsAuthProfiles(provider) && (deleteTextApiKeyRef.current || apiKeyToSend)) {
        authActions.push(deleteTextApiKeyRef.current
          ? { provider, clear: true }
          : { provider, apiKey: apiKeyToSend });
      }
      if (visionEnabled && visionSeparateProvider && supportsAuthProfiles(visionProvider) && (deleteVisionApiKeyRef.current || visionApiKeyToSend)) {
        authActions.push(deleteVisionApiKeyRef.current
          ? { provider: visionProvider, clear: true }
          : { provider: visionProvider, apiKey: visionApiKeyToSend });
      }
      if (
        supervisorEnabled
        && supervisorProvider
        && supervisorProvider !== provider
        && supervisorProvider !== visionProvider
        && supportsAuthProfiles(supervisorProvider)
        && (deleteSupervisorApiKeyRef.current || supervisorApiKeyToSend)
      ) {
        authActions.push(deleteSupervisorApiKeyRef.current
          ? { provider: supervisorProvider, clear: true }
          : { provider: supervisorProvider, apiKey: supervisorApiKeyToSend });
      }

      // Restore other cached providers so the focused provider mutation does not
      // drop non-active providers when `config.get` omits them.
      const restoreProviders: Record<string, { modelId: string; apiKey: string }> = {
        ...collectApiProfileRestoreEntries(
          mergedProjectConfig,
          provider,
          {
            apiKeys: apiKeyCacheRef.current,
            models: textModelCacheRef.current,
          },
          pendingDeleteProfileIdsRef.current,
        ),
      };
      for (const [pId, k] of Object.entries(apiKeyCacheRef.current)) {
        const key = k?.trim() ?? '';
        if (!key) continue;
        if (pId === provider) continue;
        if (isApiProfileProviderKey(pId)) continue;
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

      // Only manual endpoints expose the context window. A sub-floor value is
      // auto-raised to CONTEXT_WINDOW_MIN (with a toast) so RC always has room for
      // its turn-1 base prompt; malformed/oversized values are still rejected.
      const manualEndpoint = isManualModelEndpoint(provider);
      let effectiveContextWindow = customContextWindow ?? undefined;
      if (manualEndpoint) {
        const { value: clampedWindow, clamped } = clampSavedContextWindow(customContextWindow);
        if (clamped && clampedWindow !== undefined) {
          effectiveContextWindow = clampedWindow;
          setCustomContextWindow(clampedWindow);
          message.warning(t('settings.tuning.contextWindowClamped', { min: CONTEXT_WINDOW_MIN }));
        }
        const tuningIssues = validateModelTuning({ contextWindow: effectiveContextWindow });
        if (tuningIssues.length > 0) {
          throw new Error(tuningIssues.map((i) => t(`settings.tuning.error.${i.code}`)).join('; '));
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
          customContextWindow: manualEndpoint ? effectiveContextWindow : undefined,
          visionEnabled,
          visionProvider: visionEnabled ? visionProvider : undefined,
          visionModel: visionEnabled ? (visionModel.trim() || null) : null,
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
          profileLabel: isApiProfileProviderKey(provider)
            ? (profileLabel.trim() || profileLabelRef.current[provider])
            : undefined,
          deleteApiProfileIds: pendingDeleteProfileIdsRef.current.length
            ? [...pendingDeleteProfileIdsRef.current]
            : undefined,
          // Dual-model supervisor config
          supervisorEnabled,
          supervisorModel: supervisorEnabled
            ? (supervisorUseMainModel ? '' : (supervisorProvider && supervisorModelId ? `${supervisorProvider}/${supervisorModelId}` : undefined))
            : undefined,
          supervisorReviewMode: supervisorEnabled ? reviewMode : undefined,
          supervisorDeviationThreshold: supervisorEnabled ? deviationThreshold : undefined,
          supervisorForceRegenerate: supervisorEnabled ? forceRegenerate : undefined,
          supervisorMaxRegenerateAttempts: supervisorEnabled ? maxRegenerateAttempts : undefined,
          supervisorToolReviewGateMs: supervisorEnabled ? toolReviewGateMs : undefined,
        },
      );

      const validation = await client.request<{ ok: boolean; issues?: string[] }>('rc.provider.validate', {
        desiredConfig: fullConfig,
        probe: true,
      });
      if (validation.ok === false) {
        throw new Error(validation.issues?.join('; ') || t('settings.validationMissing'));
      }

      configStore.setConfigOperationPhase('persisting');
      configStore.setPendingConfigRestart(true);
      await client.request('rc.provider.upsert', {
        operationId,
        desiredConfig: fullConfig,
        authActions,
      });
      configStore.setConfigOperationPhase('restart_scheduled');
      projectConfigCacheRef.current = fullConfig;
      pendingDeleteProfileIdsRef.current = [];

      deleteTextApiKeyRef.current = false;
      deleteVisionApiKeyRef.current = false;
      deleteSupervisorApiKeyRef.current = false;
      setTextApiKeyDeletePending(false);
      setVisionApiKeyDeletePending(false);
      setSupervisorApiKeyDeletePending(false);
      void refreshAuthStatuses([provider, visionProvider, supervisorEnabled ? supervisorProvider : undefined].filter(Boolean) as string[]);

      syncNeeded.current = true;
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      configStore.setConfigOperationPhase('failed', messageText);
      if (client.isConnected && !/connection closed|not connected/i.test(messageText)) {
        configStore.setPendingConfigRestart(false);
      }
      throw error;
    } finally {
      setSaving(false);
    }
  }, [baseUrl, api, apiKey, provider, textModel, customContextWindow, visionEnabled, visionProvider, visionModel, visionBaseUrl, visionApi, visionApiKey, visionSeparateProvider, proxyEnabled, proxyUrl, webSearchEnabled, webSearchProvider, webSearchApiKey, webSearchApiKeyConfigured, heartbeatEnabled, heartbeatInterval, supervisorEnabled, supervisorProvider, supervisorModelId, supervisorUseMainModel, reviewMode, deviationThreshold, forceRegenerate, maxRegenerateAttempts, toolReviewGateMs, t, refreshAuthStatuses, supportsAuthProfiles]);

  const applyConfigFieldsToForm = useCallback((configForEditor: Record<string, unknown>) => {
    const fields = extractConfigFields(configForEditor);
    setBaseUrl(fields.baseUrl);
    setApi(fields.api);
    setApiKey(fields.apiKey);
    setApiKeyConfigured(fields.apiKeyConfigured);
    setTextModel(fields.textModel);
    setProvider(fields.provider);
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
    for (const p of listApiProfilesFromConfig(configForEditor)) {
      profileLabelRef.current[p.id] = p.label;
    }
  }, []);

  const performDeleteApiProfiles = useCallback(
    async (deleteIds: string[]) => {
      const client = useGatewayStore.getState().client;
      if (!client?.isConnected) throw new Error(t('oauth.notConnected'));
      if (deleteIds.length === 0) return;

      setSaving(true);
      try {
        const configSnapshot = await client.request<{
          parsed?: Record<string, unknown>;
          config?: Record<string, unknown>;
          hash?: string;
        }>('config.get', {});
        const latestProjectConfig = (configSnapshot.parsed ?? configSnapshot.config ?? null) as Record<
          string,
          unknown
        > | null;
        const mergedProjectConfig = mergeProjectConfigsPreservingProviders(
          latestProjectConfig,
          projectConfigCacheRef.current,
        );
        const fullConfig = buildDeleteApiProfilesConfig(mergedProjectConfig, deleteIds);

        for (const id of deleteIds) {
          delete apiKeyCacheRef.current[id];
          delete textModelCacheRef.current[id];
          delete profileLabelRef.current[id];
        }
        pendingDeleteProfileIdsRef.current = pendingDeleteProfileIdsRef.current.filter(
          (id) => !deleteIds.includes(id),
        );

        const configStore = useConfigStore.getState();
        const operationId = configStore.beginConfigOperation('persisting');
        configStore.setPendingConfigRestart(true);
        await client.request('rc.provider.delete', { desiredConfig: fullConfig, operationId });
        configStore.setConfigOperationPhase('restart_scheduled');

        projectConfigCacheRef.current = fullConfig;
        applyConfigFieldsToForm(fullConfig);
        void refreshAuthStatuses();
        // Delete already persisted + auto-switched the active profile, so the
        // reload must re-baseline the form (mirrors performSave/performActivateProfile);
        // otherwise the post-switch form stays "dirty" and the footer wrongly offers Apply.
        syncNeeded.current = true;
        void loadGatewayConfig();
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        const configStore = useConfigStore.getState();
        configStore.setConfigOperationPhase('failed', messageText);
        if (client.isConnected && !/connection closed|not connected/i.test(messageText)) {
          configStore.setPendingConfigRestart(false);
        }
        throw error;
      } finally {
        setSaving(false);
      }
    },
    [applyConfigFieldsToForm, loadGatewayConfig, refreshAuthStatuses, t],
  );

  /**
   * Switch agents.defaults.model.primary to a saved profile WITHOUT re-saving
   * the (stale) form state. Mirrors performSave's upsert/operation wiring but
   * only mutates `primary` via buildActivateProfileConfig. The final
   * config.apply payload is still sanitized so reserved redaction placeholders
   * from config.get are never submitted back as literal config data.
   */
  const performActivateProfile = useCallback(
    async (profile: ApiProfile) => {
      const client = useGatewayStore.getState().client;
      if (!client?.isConnected) throw new Error(t('oauth.notConnected'));

      const configStore = useConfigStore.getState();
      const operationId = configStore.beginConfigOperation('validating');
      setSaving(true);
      try {
        const configSnapshot = await client.request<{
          parsed?: Record<string, unknown>;
          config?: Record<string, unknown>;
          hash?: string;
        }>('config.get', {});
        const latestProjectConfig = (configSnapshot.parsed ?? configSnapshot.config ?? null) as Record<
          string,
          unknown
        > | null;
        const mergedProjectConfig = mergeProjectConfigsPreservingProviders(
          latestProjectConfig,
          projectConfigCacheRef.current,
        );

        const fullConfig = buildActivateProfileConfig(mergedProjectConfig, profile);

        configStore.setConfigOperationPhase('persisting');
        configStore.setPendingConfigRestart(true);
        await client.request('rc.provider.upsert', {
          operationId,
          desiredConfig: fullConfig,
          authActions: [],
        });
        configStore.setConfigOperationPhase('restart_scheduled');
        projectConfigCacheRef.current = fullConfig;

        syncNeeded.current = true;
        message.success(
          t('settings.apiProfilesActivated', { defaultValue: 'Switched API profile' }),
        );
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        configStore.setConfigOperationPhase('failed', messageText);
        if (client.isConnected && !/connection closed|not connected/i.test(messageText)) {
          configStore.setPendingConfigRestart(false);
        }
        message.error(saveErrorToast(error, t));
        throw error;
      } finally {
        setSaving(false);
      }
    },
    [message, t],
  );

  const handleActivateApiProfile = useCallback(
    async (profile: ApiProfile) => {
      await performActivateProfile(profile);
    },
    [performActivateProfile],
  );

  const handleDeleteApiProfile = useCallback(
    async (profile: ApiProfile) => {
      try {
        await performDeleteApiProfiles([profile.id]);
        message.success(
          t('settings.apiProfilesDeleted', { defaultValue: 'API profile removed' }),
        );
      } catch (e) {
        message.error(saveErrorToast(e, t));
      }
    },
    [message, performDeleteApiProfiles, t],
  );

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
        } catch (e) {
          message.error(saveErrorToast(e, t));
        }
      },
    });
  }, [performSave, baseUrl, textModel, t, modal, message]);

  const handleRestoreSupervisorDefaults = useCallback(() => {
    if (restoringSupervisorDefaults) return;
    modal.confirm({
      title: t('settings.supervisorRestoreDefaultsConfirmTitle'),
      content: t('settings.supervisorRestoreDefaultsConfirmContent'),
      okText: t('settings.restoreDefaults'),
      cancelText: t('settings.cancel'),
      centered: true,
      styles: buildThemedModalStyles(useConfigStore.getState().theme),
      onOk: async () => {
        setRestoringSupervisorDefaults(true);
        supervisorRestoreBaselineRef.current = true;
        try {
          await useSupervisorStore.getState().restoreDefaults();
          message.success(t('settings.supervisorRestoreDefaultsSuccess'));
        } catch (error) {
          supervisorRestoreBaselineRef.current = false;
          message.error(
            error instanceof Error
              ? error.message
              : t('settings.supervisorRestoreDefaultsFailed'),
          );
          throw error;
        } finally {
          setRestoringSupervisorDefaults(false);
        }
      },
    });
  }, [message, modal, restoringSupervisorDefaults, t]);

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

      <ApiProfilesSection
        profiles={profileEntries}
        activeProviderId={provider}
        loading={saving}
        onSelectProfile={loadApiProfileIntoForm}
        onActivateProfile={handleActivateApiProfile}
        onAddProfile={handleAddApiProfile}
        onDeleteProfile={handleDeleteApiProfile}
      />

      {/* ── Provider + Model section ── */}
      <SettingRow label={t('settings.provider')}>
        <>
          <Button
            size="small"
            style={{ width: 220, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
            onClick={() => setProviderPickerOpen(true)}
            disabled={probing === 'text'}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {isApiProfileProviderKey(provider)
                ? (apiProfiles.find((p) => p.id === provider)?.label ?? providerLabel(provider, t))
                : providerLabel(provider, t)}
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
            savedCustomProfiles={savedCustomProfileOptions}
            onAddCustomProfile={() => {
              setProviderPickerOpen(false);
              beginNewCustomProfile();
            }}
            onSelect={(id) => {
              setProviderPickerOpen(false);
              // Re-selecting the already-active provider is a no-op — never dirty the form.
              if (id === provider) return;
              if (isApiProfileProviderKey(id)) {
                const p = apiProfiles.find((x) => x.id === id);
                if (p) {
                  loadApiProfileIntoForm(p);
                  return;
                }
                profileLabelRef.current[id] =
                  profileLabelRef.current[id] || profileIdToDisplayName(id) || id;
                setProfileLabel(profileLabelRef.current[id]);
              }
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
              setProbeResult((prev) => ({ ...prev, text: undefined }));
            }}
            size="small"
            style={{ width: 220 }}
            disabled={isOAuthProviderSelected || probing === 'text'}
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

      {isApiProfileProviderKey(provider) && (
        <SettingRow label={t('settings.apiProfileName', { defaultValue: 'Profile name' })}>
          <Input
            value={profileLabel}
            onChange={(e) => {
              const v = e.target.value;
              setProfileLabel(v);
              profileLabelRef.current[provider] = v;
            }}
            size="small"
            style={{ width: 220 }}
            placeholder={t('settings.apiProfilesAddHint', { defaultValue: 'e.g. Relay A, Company gateway' })}
          />
        </SettingRow>
      )}

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
                <SettingRow label={t('settings.customApiUrl')} vertical>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
                    <Input
                      value={baseUrl}
                      onChange={(e) => {
                        setBaseUrl(e.target.value);
                        if (isApiProfileProviderKey(provider)) setApi(inferApiFromUrl(e.target.value));
                        setProbeResult((prev) => ({ ...prev, text: undefined }));
                      }}
                      size="small"
                      style={{ width: '100%' }}
                      placeholder="https://api.openai.com/v1"
                      disabled={probing === 'text'}
                    />
                    {textPresetUrlOverridden && (
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        {t('settings.presetUrlProtocolHint')}
                      </Text>
                    )}
                  </div>
                </SettingRow>

                {isApiProfileProviderKey(provider) && (
                  <SettingRow label={t('settings.apiProtocol')} vertical>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <Select
                          value={api}
                          onChange={(v) => {
                            setApi(v);
                            setProbeResult((prev) => ({ ...prev, text: undefined }));
                          }}
                          size="small"
                          style={{ flex: 1 }}
                          disabled={probing === 'text'}
                          options={[
                            { value: 'openai-completions', label: 'OpenAI Compatible' },
                            { value: 'openai-responses', label: 'OpenAI Responses' },
                            { value: 'anthropic-messages', label: 'Anthropic Compatible' },
                          ]}
                        />
                        <Tooltip title={!apiKey.trim() ? t('settings.probeMissingKeyHint') : undefined}>
                          <Button
                            size="small"
                            onClick={() => runProtocolProbe('text')}
                            loading={probing === 'text'}
                            disabled={
                              saving ||
                              probing !== null ||
                              !apiKey.trim() ||
                              !baseUrl.trim()
                            }
                          >
                            {t('settings.testProtocol')}
                          </Button>
                        </Tooltip>
                      </div>
                      {probing === 'text' ? (
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          {t('settings.protocolTesting')}
                        </Text>
                      ) : probeResult.text?.ok ? (
                        <Text type="success" style={{ fontSize: 11 }}>
                          {`✓ ${t('settings.protocolVerified')}: `}
                          {protocolLabel(probeResult.text.protocol)}
                        </Text>
                      ) : probeResult.text && !probeResult.text.ok ? (
                        <Text type="danger" style={{ fontSize: 11 }}>
                          {`✗ ${probeReasonText(probeResult.text.reason)}`}
                        </Text>
                      ) : null}
                    </div>
                  </SettingRow>
                )}

                {isManualModelEndpoint(provider) && (
                  <SettingRow
                    label={t('settings.tuning.contextWindow')}
                    description={t('settings.tuning.contextWindowHint', { min: CONTEXT_WINDOW_MIN })}
                    vertical
                  >
                    <InputNumber
                      value={customContextWindow}
                      onChange={(v) => setCustomContextWindow(typeof v === 'number' ? v : null)}
                      size="small"
                      style={{ width: '100%' }}
                      min={CONTEXT_WINDOW_INPUT_MIN}
                      max={CONTEXT_WINDOW_MAX}
                      step={1024}
                      precision={0}
                      placeholder={t('settings.tuning.autoPlaceholder')}
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
        <Switch checked={visionEnabled} onChange={setVisionEnabled} size="small" />
      </SettingRow>

      {visionEnabled && (
        <>
          <SettingRow label={t('settings.visionProvider')}>
            <>
              <Button
                size="small"
                style={{ width: 220, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                onClick={() => setVisionProviderPickerOpen(true)}
                disabled={probing === 'vision'}
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
                savedCustomProfiles={savedCustomProfileOptions}
                onAddCustomProfile={() => {
                  setVisionProviderPickerOpen(false);
                  beginNewVisionCustomProfile();
                }}
                onSelect={(id) => {
                  setVisionProviderPickerOpen(false);
                  if (id === visionProvider) return;
                  handleVisionProviderChange(id);
                }}
                onClose={() => setVisionProviderPickerOpen(false)}
              />
            </>
          </SettingRow>

          {visionEnabled && visionProvider === provider && (isApiProfileProviderKey(visionProvider) || visionProvider === 'ollama') && (
            <div style={{ padding: '0 0 4px 0' }}>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                {t('settings.visionInheritsText', {
                  defaultValue:
                    'Vision uses the text endpoint. To use a separate endpoint, pick or create a different configuration.',
                })}
              </span>
            </div>
          )}

          <SettingRow label={t('settings.visionModel')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
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
              {visionModelOptions.length === 0 && (
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)', maxWidth: 220 }}>
                  {t('settings.noVisionModelHint')}
                </span>
              )}
            </div>
          </SettingRow>

          {visionSeparateProvider && (
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
                    setProbeResult((prev) => ({ ...prev, vision: undefined }));
                  }}
                  size="small"
                  style={{ width: 220 }}
                  disabled={probing === 'vision'}
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
          )}

          {/* Vision API URL + Protocol — only when different provider */}
          {visionSeparateProvider && (
            <Collapse
              activeKey={visionAdvancedOpen ? ['vision-advanced'] : []}
              onChange={(keys) => setVisionAdvancedOpen((keys as string[]).includes('vision-advanced'))}
              size="small"
              items={[
                {
                  key: 'vision-advanced',
                  label: t('settings.advancedVisionEndpoint', { defaultValue: 'Vision Endpoint Advanced' }),
                  children: (
            <>
              <SettingRow label={t('settings.visionBaseUrl')} vertical>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
                  <Input
                    value={visionBaseUrl}
                    onChange={(e) => {
                      setVisionBaseUrl(e.target.value);
                      if (isApiProfileProviderKey(visionProvider)) setVisionApi(inferApiFromUrl(e.target.value));
                      setProbeResult((prev) => ({ ...prev, vision: undefined }));
                    }}
                    size="small"
                    style={{ width: '100%' }}
                    placeholder="https://api.openai.com/v1"
                    disabled={probing === 'vision'}
                  />
                  {visionPresetUrlOverridden && (
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {t('settings.presetUrlProtocolHint')}
                    </Text>
                  )}
                </div>
              </SettingRow>

              {isApiProfileProviderKey(visionProvider) && (
                <SettingRow label={t('settings.apiProtocol')} vertical>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <Select
                        value={visionApi}
                        onChange={(v) => {
                          setVisionApi(v);
                          setProbeResult((prev) => ({ ...prev, vision: undefined }));
                        }}
                        size="small"
                        style={{ flex: 1 }}
                        disabled={probing === 'vision'}
                        options={[
                          { value: 'openai-completions', label: 'OpenAI Compatible' },
                          { value: 'openai-responses', label: 'OpenAI Responses' },
                          { value: 'anthropic-messages', label: 'Anthropic Compatible' },
                        ]}
                      />
                      <Tooltip title={!visionApiKey.trim() ? t('settings.probeMissingKeyHint') : undefined}>
                        <Button
                          size="small"
                          onClick={() => runProtocolProbe('vision')}
                          loading={probing === 'vision'}
                          disabled={
                            saving ||
                            probing !== null ||
                            !visionApiKey.trim() ||
                            !visionBaseUrl.trim()
                          }
                        >
                          {t('settings.testProtocol')}
                        </Button>
                      </Tooltip>
                    </div>
                    {probing === 'vision' ? (
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        {t('settings.protocolTesting')}
                      </Text>
                    ) : probeResult.vision?.ok ? (
                      <Text type="success" style={{ fontSize: 11 }}>
                        {`✓ ${t('settings.protocolVerified')}: `}
                        {protocolLabel(probeResult.vision.protocol)}
                      </Text>
                    ) : probeResult.vision && !probeResult.vision.ok ? (
                      <Text type="danger" style={{ fontSize: 11 }}>
                        {`✗ ${probeReasonText(probeResult.vision.reason)}`}
                      </Text>
                    ) : null}
                  </div>
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

      {/* ── Web Search (optional) ── */}
      <Divider style={{ margin: '4px 0 8px' }} />

      <SettingRow label={t('settings.webSearch')} description={t('settings.webSearchHint')}>
        <Switch checked={webSearchEnabled} onChange={setWebSearchEnabled} size="small" />
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
        <Switch checked={proxyEnabled} onChange={setProxyEnabled} size="small" />
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
        <Switch checked={heartbeatEnabled} onChange={setHeartbeatEnabled} size="small" />
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={restoringSupervisorDefaults}
            onClick={handleRestoreSupervisorDefaults}
          >
            {t('settings.restoreDefaults')}
          </Button>
          <Switch
            checked={supervisorEnabled}
            onChange={(enabled) => {
              setSupervisorEnabled(enabled);
            }}
            size="small"
          />
        </div>
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
                {/* Inheriting costs no configuration but does cost main-model tokens —
                    say so where the choice is made, not in a release note. */}
                {supervisorUseMainModel && (
                  <div style={{ marginLeft: 24, fontSize: 12, color: tokens.text.muted }}>
                    {t('settings.supervisorInheritMainHint')}
                  </div>
                )}
                <Radio value="independent">
                  <span>{t('settings.supervisorIndependent')}</span>
                </Radio>
              </div>
            </Radio.Group>
          </div>

          {/* Deep review can be unusable (no key, unsupported protocol, …) while the
              deterministic safety gate keeps running. Report the reason the call path
              would actually hit, so the panel can never look healthier than it is. */}
          {supervisorStatus?.reviewerReady === false && (
            <div style={{ marginBottom: 12 }}>
              <Text style={{ fontSize: 12, color: tokens.accent.amber }}>
                {t('settings.supervisorReviewerUnavailable', { reason: supervisorStatus.reviewerUnavailableReason ?? '' })}
              </Text>
            </div>
          )}

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
                      if (id === supervisorProvider) return;
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
              ]}
              optionRender={(option) => (
                <div style={{ padding: '4px 0' }}>
                  <div style={{ fontWeight: 500 }}>{option.label}</div>
                  <div style={{ fontSize: 12, color: tokens.text.muted, marginTop: 2 }}>
                    {option.value === 'filter-only' && t('settings.reviewModeFilterDesc')}
                    {option.value === 'correct' && t('settings.reviewModeCorrectDesc')}
                  </div>
                </div>
              )}
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
            <Switch checked={forceRegenerate} onChange={setForceRegenerate} size="small" />
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

          {/* Review-behaviour knobs that apply to BOTH model sources — kept out of the
              reviewer-provider block above, which never renders while inheriting. */}
          <Collapse
            activeKey={supervisorBehaviorOpen ? ['supervisorBehavior'] : []}
            onChange={(keys) => setSupervisorBehaviorOpen((keys as string[]).includes('supervisorBehavior'))}
            size="small"
            style={{ marginBottom: 8 }}
            items={[
              {
                key: 'supervisorBehavior',
                label: t('settings.supervisorAdvancedBehavior'),
                children: (
                  <SettingRow
                    label={t('settings.supervisorToolReviewGate')}
                    description={t('settings.supervisorToolReviewGateHint', { seconds: toolReviewGateMs / 1000 })}
                  >
                    <Radio.Group
                      value={toolReviewGateMs}
                      onChange={(e) => setToolReviewGateMs(e.target.value as number)}
                      size="small"
                      optionType="button"
                      buttonStyle="solid"
                      options={SUPERVISOR_GATE_PRESETS_MS.map((ms) => ({
                        // Chosen in seconds: a millisecond box invites 300 or 300000.
                        label: t('settings.supervisorGateSeconds', { seconds: ms / 1000 }),
                        value: ms,
                      }))}
                    />
                  </SettingRow>
                ),
              },
            ]}
          />

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

      <Divider style={{ margin: '4px 0 8px' }} />

      <Collapse
        activeKey={systemPromptOpen ? ['systemPrompt'] : []}
        onChange={(keys) => setSystemPromptOpen((keys as string[]).includes('systemPrompt'))}
        size="small"
        style={{ marginTop: 8 }}
        items={[
          {
            key: 'systemPrompt',
            label: t('settings.systemPromptAppend'),
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {t('settings.systemPromptAppendHint')}
                </Text>
                <Input.TextArea
                  value={systemPromptAppend}
                  onChange={(e) => setSystemPromptAppend(e.target.value)}
                  placeholder={t('settings.systemPromptAppendPlaceholder')}
                  rows={4}
                  size="small"
                  style={{ width: '100%', maxWidth: 420 }}
                />
              </div>
            ),
          },
        ]}
      />

      {/* ── Display section ── */}
      <Divider style={{ margin: '12px 0 8px' }} />

      <SettingRow label={t('settings.showSystemFiles')} description={t('settings.showSystemFilesHint')}>
        <Switch checked={showSystemFiles} onChange={setShowSystemFiles} size="small" />
      </SettingRow>

      <SettingRow label={t('settings.notificationSound')} description={t('settings.notificationSoundHint')}>
        <Switch checked={notificationSoundEnabled} onChange={setNotificationSoundEnabled} size="small" />
      </SettingRow>

      <Divider style={{ margin: '12px 0 8px' }} />

      {/* ── About section (inline) ── */}
      <AboutSection />

      <div style={{ height: 16 }} />

      {/* Save action pinned to the panel bottom so it stays reachable at any scroll position. */}
      <div
        style={{
          position: 'sticky',
          bottom: 0,
          margin: '0 -16px',
          padding: '8px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          background: 'var(--surface)',
          borderTop: '1px solid var(--border)',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          {(() => {
            const dualEndpoint = visionEnabled && visionSeparateProvider;
            const hints: { text: string; tone: 'neutral' | 'warn' }[] = [
              { text: t('settings.restartHint'), tone: 'neutral' },
            ];
            if (textApiKeyStatus) {
              hints.push({
                text: dualEndpoint ? `${t('settings.primaryModel')}: ${textApiKeyStatus}` : textApiKeyStatus,
                tone: 'warn',
              });
            }
            if (visionApiKeyStatus) {
              hints.push({ text: `${t('settings.visionModel')}: ${visionApiKeyStatus}`, tone: 'warn' });
            }
            return hints.map((h, i) => (
              <div
                key={i}
                style={{ display: 'flex', gap: 4, alignItems: 'flex-start', marginTop: i === 0 ? 0 : 2 }}
              >
                <Text
                  type={h.tone === 'warn' ? 'danger' : 'secondary'}
                  style={{ fontSize: 11, lineHeight: '16px', flexShrink: 0 }}
                >
                  •
                </Text>
                <Text type={h.tone === 'warn' ? 'danger' : 'secondary'} style={{ fontSize: 11, lineHeight: '16px' }}>
                  {h.text}
                </Text>
              </div>
            ));
          })()}
        </div>
        <Button type="primary" size="small" onClick={handleSave} loading={saving || pendingRestart} disabled={pendingRestart || !isDirty || probing !== null} style={{ flexShrink: 0 }}>
          {pendingRestart ? t('setup.gatewayRestarting') : isApplyAction ? t('settings.apply') : t('settings.save')}
        </Button>
      </div>
    </div>
  );
}
