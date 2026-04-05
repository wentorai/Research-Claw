import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useExtensionsStore } from './extensions';
import { useGatewayStore } from './gateway';
import {
  SKILLS_STATUS_RESPONSE,
  SKILLS_UPDATE_RESPONSE,
  CHANNELS_STATUS_RESPONSE,
  CHANNELS_LOGOUT_RESPONSE,
  CONFIG_GET_RESPONSE,
} from '../__fixtures__/gateway-payloads/extensions-responses';

const mockRequest = vi.fn();

function setConnected(connected: boolean) {
  useGatewayStore.setState({
    state: connected ? 'connected' : 'disconnected',
    client: connected
      ? ({ isConnected: true, request: mockRequest } as never)
      : null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useExtensionsStore.setState({
    skills: [],
    skillsLoading: false,
    skillsLoaded: false,
    managedSkillsDir: '',
    channels: [],
    channelsLoading: false,
    channelsLoaded: false,
    plugins: [],
    pluginsLoaded: false,
  });
  setConnected(true);
});

// ── Skills ───────────────────────────────────────────────────────────────────

describe('loadSkills', () => {
  it('fetches skills via skills.status RPC', async () => {
    mockRequest.mockResolvedValueOnce(SKILLS_STATUS_RESPONSE);

    await useExtensionsStore.getState().loadSkills();

    expect(mockRequest).toHaveBeenCalledWith('skills.status', {});
    const { skills, skillsLoaded, managedSkillsDir } = useExtensionsStore.getState();
    expect(skills).toHaveLength(4);
    expect(skillsLoaded).toBe(true);
    expect(managedSkillsDir).toBe('/Users/test/.openclaw/skills');
  });

  it('skips when disconnected', async () => {
    setConnected(false);
    await useExtensionsStore.getState().loadSkills();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('skips when already loading', async () => {
    useExtensionsStore.setState({ skillsLoading: true });
    await useExtensionsStore.getState().loadSkills();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('handles RPC error gracefully', async () => {
    mockRequest.mockRejectedValueOnce(new Error('network'));
    await useExtensionsStore.getState().loadSkills();
    expect(useExtensionsStore.getState().skillsLoading).toBe(false);
  });
});

describe('toggleSkill', () => {
  it('calls skills.update and re-fetches', async () => {
    useExtensionsStore.setState({
      skills: SKILLS_STATUS_RESPONSE.skills,
      skillsLoaded: true,
    });

    mockRequest
      .mockResolvedValueOnce(SKILLS_UPDATE_RESPONSE) // skills.update
      .mockResolvedValueOnce(SKILLS_STATUS_RESPONSE); // skills.status (re-fetch)

    await useExtensionsStore.getState().toggleSkill('discord', true);

    expect(mockRequest).toHaveBeenCalledWith('skills.update', {
      skillKey: 'discord',
      enabled: true,
    });
    // Second call is re-fetch
    expect(mockRequest).toHaveBeenCalledWith('skills.status', {});
  });

  it('applies optimistic update', async () => {
    useExtensionsStore.setState({
      skills: SKILLS_STATUS_RESPONSE.skills,
      skillsLoaded: true,
    });

    // Don't resolve yet — check optimistic state
    const promise = new Promise<void>((resolve) => {
      mockRequest.mockImplementation(() =>
        new Promise((r) => setTimeout(() => { r(SKILLS_UPDATE_RESPONSE); resolve(); }, 50)),
      );
    });

    const togglePromise = useExtensionsStore.getState().toggleSkill('discord', true);

    // Before resolution, check optimistic update
    await new Promise((r) => setTimeout(r, 10));
    const discord = useExtensionsStore.getState().skills.find((s) => s.skillKey === 'discord');
    expect(discord?.disabled).toBe(false);

    await promise;
    await togglePromise;
  });
});


// ── Channels ─────────────────────────────────────────────────────────────────

describe('loadChannels', () => {
  it('fetches channels via channels.status RPC', async () => {
    mockRequest.mockResolvedValueOnce(CHANNELS_STATUS_RESPONSE);

    await useExtensionsStore.getState().loadChannels();

    expect(mockRequest).toHaveBeenCalledWith('channels.status', { probe: false });
    const { channels, channelsLoaded } = useExtensionsStore.getState();
    expect(channels).toHaveLength(3);
    expect(channelsLoaded).toBe(true);
    expect(channels[0].label).toBe('Telegram');
    expect(channels[0].accounts[0].connected).toBe(true);
  });

  it('passes probe=true on manual refresh', async () => {
    mockRequest.mockResolvedValueOnce(CHANNELS_STATUS_RESPONSE);
    await useExtensionsStore.getState().loadChannels(true);
    expect(mockRequest).toHaveBeenCalledWith('channels.status', { probe: true });
  });

  it('skips when disconnected', async () => {
    setConnected(false);
    await useExtensionsStore.getState().loadChannels();
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe('logoutChannel', () => {
  it('calls channels.logout and re-fetches', async () => {
    useExtensionsStore.setState({
      channels: [
        {
          id: 'telegram',
          label: 'Telegram',
          accounts: CHANNELS_STATUS_RESPONSE.channelAccounts.telegram,
          defaultAccountId: 'default',
          summary: {},
        },
      ],
      channelsLoaded: true,
    });

    mockRequest
      .mockResolvedValueOnce(CHANNELS_LOGOUT_RESPONSE) // channels.logout
      .mockResolvedValueOnce(CHANNELS_STATUS_RESPONSE); // channels.status (re-fetch)

    await useExtensionsStore.getState().logoutChannel('telegram');

    expect(mockRequest).toHaveBeenCalledWith('channels.logout', { channel: 'telegram' });
  });
});

// ── Plugins ──────────────────────────────────────────────────────────────────

describe('loadPlugins', () => {
  it('extracts plugins from config.get response', async () => {
    mockRequest.mockResolvedValueOnce(CONFIG_GET_RESPONSE);

    await useExtensionsStore.getState().loadPlugins();

    const { plugins, pluginsLoaded } = useExtensionsStore.getState();
    expect(pluginsLoaded).toBe(true);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe('research-claw-core');
    expect(plugins[0].enabled).toBe(true);
    expect(plugins[0].path).toContain('research-claw-core');
    expect(plugins[0].config.dbPath).toBe('~/.research-claw/library.db');
  });
});

describe('togglePlugin', () => {
  it('applies optimistic update and calls config.patch', async () => {
    useExtensionsStore.setState({
      plugins: [
        {
          name: 'research-claw-core',
          enabled: true,
          path: '/path/to/plugin',
          config: {},
        },
      ],
      pluginsLoaded: true,
    });

    mockRequest
      .mockResolvedValueOnce({ hash: 'abc123' }) // config.get for baseHash
      .mockResolvedValueOnce({ ok: true }); // config.patch

    await useExtensionsStore.getState().togglePlugin('research-claw-core', false);

    // Check optimistic update applied
    expect(useExtensionsStore.getState().plugins[0].enabled).toBe(false);

    // Verify config.patch was called
    expect(mockRequest).toHaveBeenCalledWith('config.patch', expect.objectContaining({
      raw: expect.stringContaining('"research-claw-core"'),
      baseHash: 'abc123',
    }));
  });
});
