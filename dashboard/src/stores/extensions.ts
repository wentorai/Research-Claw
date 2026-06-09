/**
 * Extensions Store — Skills, Channels, and Plugins management
 *
 * Talks to OpenClaw gateway RPCs:
 *   - skills.status / skills.update (skill listing + enable/disable)
 *   - channels.status / channels.logout (channel listing + logout)
 *   - config.get / config.patch (plugin listing + toggle)
 */

import { create } from 'zustand';
import { useGatewayStore } from './gateway';

/** Channels that store credentials on filesystem (not in config), so config-based
 *  `configured` detection cannot rely on token/botToken/appToken fields. */
const QR_LOGIN_CHANNELS = new Set(['openclaw-weixin', 'whatsapp']);

// ── Skill types ─────────────────────────────────────────────────────────────

export interface SkillRequirements {
  bins: string[];
  anyBins: string[];
  env: string[];
  config: string[];
  os: string[];
}

export interface SkillStatusEntry {
  name: string;
  description: string;
  source: string;
  bundled: boolean;
  filePath: string;
  baseDir: string;
  skillKey: string;
  emoji?: string;
  homepage?: string;
  always: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  eligible: boolean;
  requirements: SkillRequirements;
  missing: SkillRequirements;
  configChecks: { path: string; satisfied: boolean }[];
  install: { id: string; kind: string; label: string; bins: string[] }[];
}

// ── Channel types ───────────────────────────────────────────────────────────

export interface ChannelAccount {
  accountId: string;
  name?: string;
  enabled?: boolean;
  configured?: boolean;
  connected?: boolean;
  running?: boolean;
  lastConnectedAt?: number | null;
  lastError?: string | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  mode?: string;
  tokenStatus?: string;
  activeRuns?: number;
  [key: string]: unknown; // additionalProperties: true in OC protocol
}

export interface ChannelEntry {
  id: string;
  label: string;
  detailLabel?: string;
  accounts: ChannelAccount[];
  defaultAccountId: string;
  summary: Record<string, unknown>;
}

// ── Plugin types ────────────────────────────────────────────────────────────

export interface PluginEntry {
  name: string;
  enabled: boolean;
  path: string;
  config: Record<string, unknown>;
}

// ── Skill grouping ──────────────────────────────────────────────────────────

export type SkillGroup = 'local' | 'research-plugins' | 'managed' | 'bundled';

export const GROUP_ORDER: SkillGroup[] = ['local', 'research-plugins', 'managed', 'bundled'];

export function classifySkill(entry: SkillStatusEntry): SkillGroup {
  if (entry.source.includes('research-claw/skills') || entry.source.includes('research-claw\\skills')) return 'local';
  if (entry.source.includes('research-plugins')) return 'research-plugins';
  if (entry.bundled) return 'bundled';
  return 'managed';
}

// ── Store ───────────────────────────────────────────────────────────────────

interface ExtensionsState {
  // Skills
  skills: SkillStatusEntry[];
  skillsLoading: boolean;
  skillsLoaded: boolean;
  managedSkillsDir: string;
  loadSkills: () => Promise<void>;
  toggleSkill: (skillKey: string, enabled: boolean) => Promise<void>;

  // Channels
  channels: ChannelEntry[];
  channelsLoading: boolean;
  channelsLoaded: boolean;
  loadChannels: (probe?: boolean) => Promise<void>;
  logoutChannel: (channelId: string, accountId?: string) => Promise<void>;
  enableChannel: (channelId: string, enabled: boolean) => Promise<void>;
  deleteChannel: (channelId: string) => Promise<void>;

  // QR Login
  qrLoginChannelId: string | null;
  qrLoginState: 'idle' | 'loading' | 'waiting' | 'success' | 'error';
  qrLoginDataUrl: string | null;
  qrLoginMessage: string | null;
  qrLoginError: string | null;
  startQrLogin: (channelId: string, accountId?: string) => void;
  cancelQrLogin: () => void;

  // Plugins
  plugins: PluginEntry[];
  pluginsLoaded: boolean;
  loadPlugins: () => Promise<void>;
  togglePlugin: (name: string, enabled: boolean) => Promise<void>;
}

// Prevent double-toggle race
const _inflightSkillOps = new Set<string>();

export const useExtensionsStore = create<ExtensionsState>()((set, get) => ({
  // Skills
  skills: [],
  skillsLoading: false,
  skillsLoaded: false,
  managedSkillsDir: '',

  // Channels
  channels: [],
  channelsLoading: false,
  channelsLoaded: false,

  // QR Login
  qrLoginChannelId: null,
  qrLoginState: 'idle',
  qrLoginDataUrl: null,
  qrLoginMessage: null,
  qrLoginError: null,

  // Plugins
  plugins: [],
  pluginsLoaded: false,

  // ── Skills ──────────────────────────────────────────────────────────────

  loadSkills: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    if (get().skillsLoading) return;

    set({ skillsLoading: true });
    try {
      const result = await client.request<{
        workspaceDir: string;
        managedSkillsDir: string;
        skills: SkillStatusEntry[];
      }>('skills.status', {});
      set({
        skills: result.skills,
        managedSkillsDir: result.managedSkillsDir,
        skillsLoaded: true,
      });
    } catch (err) {
      console.warn('[ExtensionsStore] loadSkills failed:', err);
    } finally {
      set({ skillsLoading: false });
    }
  },

  toggleSkill: async (skillKey: string, enabled: boolean) => {
    if (_inflightSkillOps.has(skillKey)) return;
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    _inflightSkillOps.add(skillKey);
    // Optimistic update
    set((s) => ({
      skills: s.skills.map((sk) =>
        sk.skillKey === skillKey ? { ...sk, disabled: !enabled, eligible: enabled } : sk,
      ),
    }));

    try {
      await client.request('skills.update', { skillKey, enabled });
      // Re-fetch to get consistent state (skills.update doesn't auto-reload)
      await get().loadSkills();
    } catch (err) {
      console.error('[ExtensionsStore] toggleSkill failed:', err);
      await get().loadSkills(); // Rollback optimistic
    } finally {
      _inflightSkillOps.delete(skillKey);
    }
  },

  // ── Channels ────────────────────────────────────────────────────────────

  loadChannels: async (probe = false) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    if (get().channelsLoading) return;

    set({ channelsLoading: true });
    try {
      // Fetch active channels from gateway
      const result = await client.request<{
        ts: number;
        channelOrder: string[];
        channelLabels: Record<string, string>;
        channelDetailLabels?: Record<string, string>;
        channels: Record<string, Record<string, unknown>>;
        channelAccounts: Record<string, ChannelAccount[]>;
        channelDefaultAccountId: Record<string, string>;
      }>('channels.status', { probe });

      const entries: ChannelEntry[] = result.channelOrder.map((id) => ({
        id,
        label: result.channelLabels[id] ?? id,
        detailLabel: result.channelDetailLabels?.[id],
        accounts: result.channelAccounts[id] ?? [],
        defaultAccountId: result.channelDefaultAccountId[id] ?? 'default',
        summary: result.channels[id] ?? {},
      }));

      // Also fetch disabled channels from config — channels.status only returns
      // enabled channels, so disabled ones vanish from the list. We need them
      // visible so the user can re-enable them via the Switch.
      try {
        const configSnapshot = await client.request<{
          config?: Record<string, unknown>;
          resolved?: Record<string, unknown>;
        }>('config.get', {});
        // Use `config` (has runtime defaults) over `resolved` (lacks models.providers etc.)
        // See b4a9c0e for the same fix in config.ts.
        const configObj = (configSnapshot.config ?? configSnapshot.resolved ?? {}) as Record<string, unknown>;
        const channelsCfg = configObj.channels as Record<string, unknown> | undefined;
        if (channelsCfg) {
          const activeIds = new Set(entries.map((e) => e.id));
          for (const [id, cfg] of Object.entries(channelsCfg)) {
            if (activeIds.has(id)) continue;
            // Only include objects (skip scalar fields like "defaults")
            if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
            const cfgObj = cfg as Record<string, unknown>;
            // QR-login channels (WeChat, WhatsApp) store tokens on filesystem,
            // not in config — treat their presence in config as "configured".
            const hasTokenInConfig = !!(cfgObj.token || cfgObj.botToken || cfgObj.appToken);
            const isConfigured = QR_LOGIN_CHANNELS.has(id) || hasTokenInConfig;
            // This is a disabled channel — create a placeholder entry
            entries.push({
              id,
              label: id,
              accounts: [{
                accountId: 'default',
                enabled: cfgObj.enabled !== undefined ? Boolean(cfgObj.enabled) : true,
                configured: isConfigured,
                connected: false,
                running: false,
              }],
              defaultAccountId: 'default',
              summary: { configured: isConfigured },
            });
          }
        }
      } catch {
        // config.get failed — proceed with active channels only
      }

      set({ channels: entries, channelsLoaded: true });
    } catch (err) {
      console.warn('[ExtensionsStore] loadChannels failed:', err);
    } finally {
      set({ channelsLoading: false });
    }
  },

  logoutChannel: async (channelId: string, accountId?: string) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    try {
      await client.request('channels.logout', {
        channel: channelId,
        ...(accountId ? { accountId } : {}),
      });
      // Reload channels to reflect new state
      await get().loadChannels();
    } catch (err) {
      console.error('[ExtensionsStore] logoutChannel failed:', err);
      throw err;
    }
  },

  enableChannel: async (channelId: string, enabled: boolean) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    try {
      // Get baseHash for config.patch
      const snapshot = await client.request<{ hash?: string }>('config.get', {});
      const baseHash = snapshot.hash ?? undefined;

      // OC 2026.6.1 validates the full merged config on config.patch and rejects
      // the RC-only `plugins.installs` key. Strip it in the same patch; run.sh's
      // ensure-config re-adds it on the next startup.
      const patch = {
        channels: { [channelId]: { enabled } },
        plugins: { installs: null },
      };

      await client.request('config.patch', {
        raw: JSON.stringify(patch),
        ...(baseHash ? { baseHash } : {}),
        note: `${enabled ? 'Enable' : 'Disable'} channel ${channelId}`,
      });

      // Gateway auto-restarts via SIGUSR1 — wait for it to settle, then reload
      setTimeout(() => {
        get().loadChannels();
      }, 3000);
    } catch (err) {
      console.error('[ExtensionsStore] enableChannel failed:', err);
      throw err;
    }
  },

  deleteChannel: async (channelId: string) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    try {
      // Get baseHash for config.patch
      const snapshot = await client.request<{ hash?: string }>('config.get', {});
      const baseHash = snapshot.hash ?? undefined;

      // JSON merge patch: null = delete key. Also strip the RC-only
      // `plugins.installs` key, which OC 2026.6.1's config validation rejects;
      // run.sh's ensure-config re-adds it on the next startup.
      const patch = {
        channels: { [channelId]: null },
        plugins: { installs: null },
      };

      await client.request('config.patch', {
        raw: JSON.stringify(patch),
        ...(baseHash ? { baseHash } : {}),
        note: `Delete channel ${channelId}`,
      });

      // Gateway auto-restarts via SIGUSR1 — wait for it to settle, then reload
      setTimeout(() => {
        get().loadChannels();
      }, 3000);
    } catch (err) {
      console.error('[ExtensionsStore] deleteChannel failed:', err);
      throw err;
    }
  },

  // ── QR Login ────────────────────────────────────────────────────────────

  startQrLogin: (channelId: string, accountId?: string) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    if (get().qrLoginState !== 'idle') return;

    set({
      qrLoginChannelId: channelId,
      qrLoginState: 'loading',
      qrLoginDataUrl: null,
      qrLoginMessage: null,
      qrLoginError: null,
    });

    // Step 1: web.login.start — generate QR code (30s timeout is fine)
    client.request<{
      qrDataUrl?: string;
      message: string;
    }>('web.login.start', {
      force: true,
      ...(accountId ? { accountId } : {}),
    }).then((startResult) => {
      if (get().qrLoginState !== 'loading') return;

      if (!startResult.qrDataUrl || !startResult.qrDataUrl.startsWith('data:')) {
        set({
          qrLoginState: 'error',
          qrLoginError: startResult.message || 'Failed to generate QR code',
        });
        return;
      }

      set({
        qrLoginState: 'waiting',
        qrLoginDataUrl: startResult.qrDataUrl,
        qrLoginMessage: startResult.message,
      });

      // Step 2: web.login.wait — block until user scans (120s server, 150s client)
      client.request<{
        connected: boolean;
        message: string;
      }>('web.login.wait', {
        timeoutMs: 120_000,
        ...(accountId ? { accountId } : {}),
      }, { timeoutMs: 150_000 }).then((waitResult) => {
        if (get().qrLoginState !== 'waiting') return;

        if (waitResult.connected) {
          set({
            qrLoginState: 'success',
            qrLoginMessage: waitResult.message || '连接成功！',
          });
          // Nudge gateway to reload: config.patch triggers SIGUSR1 restart so
          // the newly-saved QR credentials are picked up by the channel runtime.
          client.request<{ hash?: string }>('config.get', {}).then((snap) => {
            client.request('config.patch', {
              raw: JSON.stringify({ channels: { [channelId]: { enabled: true } }, plugins: { installs: null } }),
              ...(snap.hash ? { baseHash: snap.hash } : {}),
              note: 'Reload after QR login',
            }).catch(() => { /* best-effort */ });
          }).catch(() => { /* best-effort */ });
          // Wait for restart, then reload with probe
          setTimeout(() => { get().loadChannels(true); }, 4000);
        } else {
          set({
            qrLoginState: 'error',
            qrLoginError: waitResult.message || 'Login timed out',
          });
        }
      }).catch((err) => {
        if (get().qrLoginState !== 'waiting') return;
        set({
          qrLoginState: 'error',
          qrLoginError: err instanceof Error ? err.message : String(err),
        });
      });
    }).catch((err) => {
      if (get().qrLoginState !== 'loading') return;
      set({
        qrLoginState: 'error',
        qrLoginError: err instanceof Error ? err.message : String(err),
      });
    });
  },

  cancelQrLogin: () => {
    set({
      qrLoginChannelId: null,
      qrLoginState: 'idle',
      qrLoginDataUrl: null,
      qrLoginMessage: null,
      qrLoginError: null,
    });
  },

  // ── Plugins ─────────────────────────────────────────────────────────────

  loadPlugins: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    try {
      const result = await client.request<{
        config?: Record<string, unknown>;
        resolved?: Record<string, unknown>;
      }>('config.get', {});

      // Use `config` (has runtime defaults) over `resolved` (lacks models.providers etc.)
      // See b4a9c0e for the same fix in config.ts.
      const configObj = (result.config ?? result.resolved ?? {}) as Record<string, unknown>;

      const pluginsSection = configObj.plugins as {
        load?: { paths?: string[] };
        entries?: Record<string, { enabled?: boolean; config?: Record<string, unknown> }>;
      } | undefined;

      const entries: PluginEntry[] = [];
      const paths = pluginsSection?.load?.paths ?? [];
      const pluginEntries = pluginsSection?.entries ?? {};

      for (const [name, entry] of Object.entries(pluginEntries)) {
        let matchingPath = paths.find((p) => p.includes(name)) ?? '';
        // Fallback: globally installed plugins aren't in load.paths.
        // Mark as "global install" so UI doesn't show "—".
        if (!matchingPath) {
          matchingPath = `~/.openclaw/extensions/${name}`;
        }
        entries.push({
          name,
          enabled: entry.enabled !== false,
          path: matchingPath,
          config: entry.config ?? {},
        });
      }

      set({ plugins: entries, pluginsLoaded: true });
    } catch (err) {
      console.warn('[ExtensionsStore] loadPlugins failed:', err);
    }
  },

  togglePlugin: async (name: string, enabled: boolean) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    // Optimistic update
    set((s) => ({
      plugins: s.plugins.map((p) => (p.name === name ? { ...p, enabled } : p)),
    }));

    try {
      // Need baseHash for config.patch
      const snapshot = await client.request<{ hash?: string }>('config.get', {});
      const baseHash = snapshot.hash ?? undefined;

      const patch = {
        plugins: { entries: { [name]: { enabled } } },
      };

      await client.request('config.patch', {
        raw: JSON.stringify(patch),
        ...(baseHash ? { baseHash } : {}),
        note: `Toggle plugin ${name}: ${enabled ? 'enabled' : 'disabled'}`,
      });

      // config.patch triggers gateway restart — plugin state will refresh on reconnect
    } catch (err) {
      console.error('[ExtensionsStore] togglePlugin failed:', err);
      await get().loadPlugins(); // Rollback optimistic
    }
  },

}));
