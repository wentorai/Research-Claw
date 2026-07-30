import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  classifySkill,
  getSkillRuntimeState,
  useExtensionsStore,
} from './extensions';
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
  mockRequest.mockReset();
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
    expect(skills).toHaveLength(6);
    expect(skillsLoaded).toBe(true);
    expect(managedSkillsDir).toBe('/Users/test/.openclaw/skills');
    expect(skills[0]).toEqual(expect.objectContaining({
      source: 'openclaw-extra',
      blockedByAgentFilter: false,
      modelVisible: true,
      userInvocable: true,
      commandVisible: true,
    }));
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
    // Enabling is a configuration mutation. Runtime eligibility/visibility is
    // authoritative only after the follow-up skills.status response.
    expect(discord?.eligible).toBe(false);
    expect(discord?.modelVisible).toBe(false);

    await promise;
    await togglePromise;
  });

  it('rolls back and rejects when skills.update fails', async () => {
    useExtensionsStore.setState({
      skills: SKILLS_STATUS_RESPONSE.skills,
      skillsLoaded: true,
    });
    mockRequest
      .mockRejectedValueOnce(new Error('update denied'))
      .mockResolvedValueOnce(SKILLS_STATUS_RESPONSE);

    await expect(
      useExtensionsStore.getState().toggleSkill('discord', true),
    ).rejects.toThrow('update denied');

    expect(mockRequest).toHaveBeenNthCalledWith(2, 'skills.status', {});
    expect(
      useExtensionsStore.getState().skills.find((skill) => skill.skillKey === 'discord')?.disabled,
    ).toBe(true);
  });
});

describe('skill provenance and runtime state', () => {
  it.each([
    ['research-sop', 'local'],
    ['search_arxiv', 'research-plugins'],
    ['style-journal-rewrite', 'workspace'],
    ['managed-private-skill', 'managed'],
    ['computer', 'bundled'],
  ] as const)('classifies %s from real OC source/path fields as %s', (skillKey, expected) => {
    const skill = SKILLS_STATUS_RESPONSE.skills.find((entry) => entry.skillKey === skillKey);
    expect(skill).toBeDefined();
    expect(classifySkill(skill!)).toBe(expected);
  });

  it('does not confuse arbitrary openclaw-extra skills with Research Plugins', () => {
    const local = SKILLS_STATUS_RESPONSE.skills.find((entry) => entry.skillKey === 'research-sop')!;
    expect(local.source).toBe('openclaw-extra');
    expect(classifySkill(local)).toBe('local');
  });

  it('derives an explicit runtime state instead of treating eligible as model-visible', () => {
    const blocked = SKILLS_STATUS_RESPONSE.skills.find(
      (entry) => entry.skillKey === 'managed-private-skill',
    )!;
    expect(blocked.eligible).toBe(true);
    expect(blocked.modelVisible).toBe(false);
    expect(getSkillRuntimeState(blocked)).toBe('agent-blocked');
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

describe('enableChannel', () => {
  it('patches regular channel enabled state', async () => {
    mockRequest
      .mockResolvedValueOnce({ hash: 'abc123' })
      .mockResolvedValueOnce({ ok: true });

    await useExtensionsStore.getState().enableChannel('telegram', false);

    expect(mockRequest).toHaveBeenCalledWith('config.patch', expect.objectContaining({
      raw: JSON.stringify({
        channels: { telegram: { enabled: false } },
        plugins: { installs: null },
      }),
      baseHash: 'abc123',
    }));
  });

  it('also toggles the plugin entry for QR-login channels', async () => {
    mockRequest
      .mockResolvedValueOnce({ hash: 'abc123' })
      .mockResolvedValueOnce({ ok: true });

    await useExtensionsStore.getState().enableChannel('openclaw-weixin', false);

    expect(mockRequest).toHaveBeenCalledWith('config.patch', expect.objectContaining({
      raw: JSON.stringify({
        channels: { 'openclaw-weixin': { enabled: false } },
        plugins: {
          installs: null,
          entries: { 'openclaw-weixin': { enabled: false } },
        },
      }),
      baseHash: 'abc123',
    }));
  });
});

// ── Plugins ──────────────────────────────────────────────────────────────────

describe('loadPlugins', () => {
  it('builds plugin disclosure from entries, allow, load paths, and installs', async () => {
    mockRequest.mockResolvedValueOnce(CONFIG_GET_RESPONSE);

    await useExtensionsStore.getState().loadPlugins();

    const { plugins, pluginsLoaded } = useExtensionsStore.getState();
    expect(pluginsLoaded).toBe(true);
    expect(plugins.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      'research-claw-core',
      'research-plugins',
      'browser',
      'openclaw-weixin',
    ]));
    const core = plugins.find((entry) => entry.name === 'research-claw-core')!;
    expect(core.enabled).toBe(true);
    expect(core.path).toContain('research-claw-core');
    expect(core.config.dbPath).toBe('~/.research-claw/library.db');

    const researchPlugins = plugins.find((entry) => entry.name === 'research-plugins')!;
    expect(researchPlugins).toEqual(expect.objectContaining({
      allowed: true,
      configured: false,
      installed: true,
      installSource: 'npm',
      path: '/Users/test/.openclaw/extensions/research-plugins',
    }));
  });

  it('invalidates cached extension snapshots for reconnect refresh', () => {
    useExtensionsStore.setState({
      skillsLoaded: true,
      channelsLoaded: true,
      pluginsLoaded: true,
    });

    useExtensionsStore.getState().invalidate();

    expect(useExtensionsStore.getState()).toEqual(expect.objectContaining({
      skillsLoaded: false,
      channelsLoaded: false,
      pluginsLoaded: false,
    }));
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
          configured: true,
          installed: true,
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
