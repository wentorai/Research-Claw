import { create } from 'zustand';
import i18n from '../i18n';
import { useGatewayStore } from './gateway';
import { isConfigValid, hasModelConfigured } from '../utils/config-patch';

/** Model definition from openclaw.json providers */
export interface GatewayModelDef {
  id: string;
  name?: string;
  input?: string[];
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

/** Provider definition from openclaw.json */
export interface GatewayProviderDef {
  baseUrl?: string;
  api?: string;
  models?: GatewayModelDef[];
}

/** Subset of the gateway config we care about */
export interface GatewayConfig {
  agents?: {
    defaults?: {
      model?: { primary?: string; fallbacks?: string[] };
      imageModel?: { primary?: string; fallbacks?: string[] };
      heartbeat?: { every?: string };
    };
  };
  models?: {
    providers?: Record<string, GatewayProviderDef>;
  };
  env?: Record<string, string>;
  tools?: Record<string, unknown>;
  browser?: Record<string, unknown>;
  raw?: string | null;
  baseHash?: string | null;
  /** Project-level config (before global merge). Used by buildSaveConfig. */
  projectConfig?: Record<string, unknown> | null;
}

export type BootState = 'pending' | 'ready' | 'needs_setup' | 'gateway_unreachable' | 'needs_token';

/** Maximum retries for config loading after reconnect (handles race with gateway startup) */
const CONFIG_RETRY_MAX = 5;
const CONFIG_RETRY_DELAY_MS = 2000;

interface ConfigState {
  theme: 'dark' | 'light';
  locale: 'en' | 'zh-CN';
  systemPromptAppend: string;
  bootState: BootState;

  /** Live config from gateway (via config.get RPC) */
  gatewayConfig: GatewayConfig | null;
  gatewayConfigLoading: boolean;

  /** Internal retry counter for config loading after reconnect */
  _configRetryCount: number;

  /** True when config.apply succeeded and we're waiting for gateway restart + reconnect.
   *  Persisted to sessionStorage so it survives page refresh. */
  pendingConfigRestart: boolean;

  setTheme: (t: 'dark' | 'light') => void;
  setLocale: (l: 'en' | 'zh-CN') => void;
  setSystemPromptAppend: (v: string) => void;
  loadConfig: () => void;
  loadGatewayConfig: () => Promise<void>;
  evaluateConfig: () => void;
  setBootState: (s: BootState) => void;
  setPendingConfigRestart: (v: boolean) => void;
}

function loadFromStorage(): { theme: 'dark' | 'light'; locale: 'en' | 'zh-CN'; systemPromptAppend: string } {
  try {
    const theme = (localStorage.getItem('rc-theme') as 'dark' | 'light') ?? 'dark';
    const locale = (localStorage.getItem('rc-locale') as 'en' | 'zh-CN') ?? 'zh-CN';
    const systemPromptAppend = localStorage.getItem('rc-system-prompt-append') ?? '';
    return { theme, locale, systemPromptAppend };
  } catch {
    return { theme: 'dark', locale: 'zh-CN', systemPromptAppend: '' };
  }
}

export const useConfigStore = create<ConfigState>()((set, get) => {
  const persisted = loadFromStorage();

  return {
    theme: persisted.theme,
    locale: persisted.locale,
    systemPromptAppend: persisted.systemPromptAppend,
    bootState: 'pending',
    gatewayConfig: null,
    gatewayConfigLoading: false,
    _configRetryCount: 0,
    pendingConfigRestart: (() => {
      try { return sessionStorage.getItem('rc:pending-config-restart') === '1'; }
      catch { return false; }
    })(),

    setPendingConfigRestart: (v: boolean) => {
      try {
        if (v) sessionStorage.setItem('rc:pending-config-restart', '1');
        else sessionStorage.removeItem('rc:pending-config-restart');
      } catch { /* non-fatal */ }
      set({ pendingConfigRestart: v });
    },

    setTheme: (t: 'dark' | 'light') => {
      document.documentElement.setAttribute('data-theme', t);
      localStorage.setItem('rc-theme', t);
      set({ theme: t });
    },

    setLocale: (l: 'en' | 'zh-CN') => {
      i18n.changeLanguage(l);
      localStorage.setItem('rc-locale', l);
      set({ locale: l });
    },

    setSystemPromptAppend: (v: string) => {
      localStorage.setItem('rc-system-prompt-append', v);
      set({ systemPromptAppend: v });
    },

    loadConfig: () => {
      const data = loadFromStorage();
      if (data.theme) {
        document.documentElement.setAttribute('data-theme', data.theme);
      }
      set(data);
    },

    loadGatewayConfig: async () => {
      const client = useGatewayStore.getState().client;
      if (!client?.isConnected) return;
      set({ gatewayConfigLoading: true });
      try {
        const snapshot = await client.request<{
          config?: Record<string, unknown>;
          resolved?: Record<string, unknown>;
          raw?: string | null;
          hash?: string | null;
        }>('config.get', {});
        // Gateway returns `hash` (not `baseHash`). We store it as `baseHash` for our interface.
        // Prefer `config` (fully processed with runtime defaults: agents, models, etc.)
        // over `resolved` (raw after include/env — missing runtime defaults like models.providers).
        // OC ConfigFileSnapshot:
        //   config  = full config WITH applyModelDefaults() etc. ← has models.providers
        //   resolved = after $include + ${ENV}, BEFORE runtime defaults ← may lack providers
        const config = snapshot.config as Record<string, unknown> | undefined;
        const resolved = snapshot.resolved as Record<string, unknown> | undefined;
        const hasConfig = config && Object.keys(config).length > 0;
        const configObj = (hasConfig ? config : resolved ?? {}) as Record<string, unknown>;
        const gc: GatewayConfig = {
          agents: configObj.agents as GatewayConfig['agents'],
          models: configObj.models as GatewayConfig['models'],
          env: configObj.env as GatewayConfig['env'],
          tools: configObj.tools as Record<string, unknown> | undefined,
          browser: configObj.browser as Record<string, unknown> | undefined,
          raw: snapshot.raw ?? null,
          baseHash: snapshot.hash ?? null,
          projectConfig: (snapshot.config ?? null) as Record<string, unknown> | null,
        };
        set({ gatewayConfig: gc, gatewayConfigLoading: false });
        get().evaluateConfig();
      } catch (err) {
        console.warn('[config] loadGatewayConfig failed:', err);
        set({ gatewayConfigLoading: false });
        // On error, still trigger evaluation so retries can continue
        get().evaluateConfig();
      }
    },

    evaluateConfig: () => {
      const { gatewayConfig, bootState: currentBoot, _configRetryCount } = get();

      // Guard: never downgrade from 'ready' to 'needs_setup'
      if (currentBoot === 'ready') return;

      const configRecord = gatewayConfig as Record<string, unknown> | null;
      const gwConnected = useGatewayStore.getState().state === 'connected';

      // Level 1: Strict validation — model ref + matching provider
      if (isConfigValid(configRecord)) {
        set({ bootState: 'ready', _configRetryCount: 0 });
        return;
      }

      // Level 2: Relaxed validation — gateway is connected and has a model configured.
      // If the gateway responded to hello-ok, it validated its own config on startup.
      // The dashboard may fail strict validation due to resolved config structure differences.
      if (gwConnected && hasModelConfigured(configRecord)) {
        console.warn('[config] Strict validation failed but gateway is connected with model — accepting config');
        set({ bootState: 'ready', _configRetryCount: 0 });
        return;
      }

      // Level 2.5: Check project-level config (pre-resolution) as fallback.
      // The resolved config may restructure fields; the raw project config preserves them.
      if (gwConnected && gatewayConfig?.projectConfig) {
        const pc = gatewayConfig.projectConfig;
        if (isConfigValid(pc) || hasModelConfigured(pc)) {
          console.warn('[config] Resolved config failed validation but project config is valid — accepting');
          set({ bootState: 'ready', _configRetryCount: 0 });
          return;
        }
      }

      // Level 2.75: Gateway connected — directly check model ref on typed GatewayConfig.
      // Bypasses the Record<string,unknown> cast (which may lose type info) and validates
      // model.primary format (provider/model) consistent with OpenClaw's own validation.
      if (gwConnected && gatewayConfig?.agents?.defaults?.model?.primary) {
        const primary = gatewayConfig.agents.defaults.model.primary;
        if (primary.includes('/')) {
          console.warn('[config] Direct gatewayConfig.model.primary check passed — accepting');
          set({ bootState: 'ready', _configRetryCount: 0 });
          return;
        }
      }

      // ── Fresh-install fast-path ──────────────────────────────────────────
      // If config.get returned structurally complete data (OC defaults applied:
      // agents/env present) but absolutely no model is configured, this is a
      // genuine unconfigured state — not a transient race.
      //
      // Why this is safe (unlike the removed d89f6dc fast-path):
      //  - Old fast-path only checked `!models.providers` → triggered on the
      //    config/resolved preference bug (resolved lacks runtime defaults).
      //  - This version requires structural completeness (agents OR env present)
      //    as proof that config.get returned real data with OC defaults applied.
      //  - ensure-config.cjs runs BEFORE gateway (run.sh:66) → no write race.
      //  - hello-ok proves config is fully loaded → not a timing issue.
      //
      // History: cold-start-config-resolution.md#坑10 → dashboard-gateway-liveness.md#问题四
      if (gwConnected && gatewayConfig) {
        const hasStructuralContent = !!(gatewayConfig.agents || gatewayConfig.env || gatewayConfig.raw);
        const modelRef = gatewayConfig.agents?.defaults?.model?.primary ?? '';
        const hasAnyModel = modelRef.length > 0 && modelRef.includes('/');
        const hasProviders = !!(gatewayConfig.models?.providers &&
          Object.keys(gatewayConfig.models.providers).length > 0);

        if (hasStructuralContent && !hasAnyModel && !hasProviders) {
          console.log('[config] Config structurally complete but no model configured — showing setup wizard');
          set({ bootState: 'needs_setup', _configRetryCount: 0 });
          return;
        }
      }

      // Level 3: Retry — gateway may not have fully loaded its config yet, or the
      // config was being written (ensure-config.cjs, wizard) when we read it.
      // Covers: transient empty config (config.get failed → gatewayConfig null),
      // or partial model config that didn't match any validation level.
      if (_configRetryCount < CONFIG_RETRY_MAX) {
        console.log(`[config] Validation failed, retry ${_configRetryCount + 1}/${CONFIG_RETRY_MAX}`,
          { gwConnected, hasConfig: !!gatewayConfig, agents: !!gatewayConfig?.agents, models: !!gatewayConfig?.models });
        set({ _configRetryCount: _configRetryCount + 1 });
        setTimeout(() => {
          get().loadGatewayConfig();
        }, CONFIG_RETRY_DELAY_MS);
        return;
      }

      // All retries exhausted — genuinely needs setup
      console.warn('[config] All validation levels exhausted — showing setup wizard',
        { gwConnected, config: gatewayConfig });
      set({ bootState: 'needs_setup', _configRetryCount: 0 });
    },

    setBootState: (s: BootState) => {
      set({ bootState: s });
    },
  };
});

// Debug helper: re-enter SetupWizard from browser console.
// Usage: __resetSetup()
(window as unknown as Record<string, unknown>).__resetSetup = () => {
  useConfigStore.setState({ bootState: 'needs_setup' });
};

/**
 * Check whether the primary model supports inline image input.
 * Used by chat.send() to decide whether to route images through workspace
 * for the /image tool (imageModel) instead of sending as chat attachments.
 */
export function primaryModelSupportsVision(): boolean {
  const cfg = useConfigStore.getState().gatewayConfig;
  if (!cfg) return false;

  const primaryRef = cfg.agents?.defaults?.model?.primary;
  if (!primaryRef) return false;

  // primaryRef = "zai/glm-5" → provider="zai", modelId="glm-5"
  const slashIdx = primaryRef.indexOf('/');
  if (slashIdx < 0) return false;

  const providerKey = primaryRef.slice(0, slashIdx);
  const modelId = primaryRef.slice(slashIdx + 1);
  const providerDef = cfg.models?.providers?.[providerKey];
  const modelDef = providerDef?.models?.find((m) => m.id === modelId);

  return modelDef?.input?.includes('image') ?? false;
}

/**
 * Check whether an imageModel is configured (for /image tool fallback).
 */
export function hasImageModelConfigured(): boolean {
  const cfg = useConfigStore.getState().gatewayConfig;
  const ref = cfg?.agents?.defaults?.imageModel?.primary;
  return !!ref && ref.includes('/');
}
