/**
 * Extensions Store — Skills, Channels, and Plugins management
 *
 * Talks to OpenClaw gateway RPCs:
 *   - skills.status / skills.update (skill listing + enable/disable)
 *   - channels.status / channels.logout (channel listing + logout)
 *   - config.get / config.patch / config.openFile (plugin management)
 *   - rc.ws.openExternal / rc.ws.openFolder (open skill files)
 */

import { create } from 'zustand';
import { useGatewayStore } from './gateway';

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
    }
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

      const configObj = (result.resolved && Object.keys(result.resolved).length > 0
        ? result.resolved
        : result.config ?? {}) as Record<string, unknown>;

      const pluginsSection = configObj.plugins as {
        load?: { paths?: string[] };
        entries?: Record<string, { enabled?: boolean; config?: Record<string, unknown> }>;
      } | undefined;

      const entries: PluginEntry[] = [];
      const paths = pluginsSection?.load?.paths ?? [];
      const pluginEntries = pluginsSection?.entries ?? {};

      for (const [name, entry] of Object.entries(pluginEntries)) {
        const matchingPath = paths.find((p) => p.includes(name)) ?? '';
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
