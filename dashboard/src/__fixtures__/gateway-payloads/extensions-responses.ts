/**
 * Fixtures for extensions store tests.
 * Based on real OpenClaw gateway RPC response shapes.
 */

import type { SkillStatusEntry, ChannelAccount } from '../../stores/extensions';

// ── skills.status ───────────────────────────────────────────────────────────

export const SKILLS_STATUS_RESPONSE = {
  workspaceDir: '/Users/test/research-claw/workspace',
  managedSkillsDir: '/Users/test/.openclaw/skills',
  skills: [
    {
      name: 'research-sop',
      description: 'Research methodology & SOP guide',
      source: '/Users/test/research-claw/skills',
      bundled: false,
      filePath: '/Users/test/research-claw/skills/research-sop/SKILL.md',
      baseDir: '/Users/test/research-claw/skills/research-sop',
      skillKey: 'research-sop',
      emoji: '🔬',
      always: true,
      disabled: false,
      blockedByAllowlist: false,
      eligible: true,
      requirements: { bins: [], anyBins: [], env: [], config: [], os: [] },
      missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
      configChecks: [],
      install: [],
    },
    {
      name: 'search_arxiv',
      description: 'Search arXiv preprint database',
      source: '@wentorai/research-plugins',
      bundled: false,
      filePath: '/Users/test/.openclaw/skills/research-plugins/curated/academic-search/arxiv/SKILL.md',
      baseDir: '/Users/test/.openclaw/skills/research-plugins/curated/academic-search/arxiv',
      skillKey: 'search_arxiv',
      emoji: '📄',
      homepage: 'https://arxiv.org',
      always: false,
      disabled: false,
      blockedByAllowlist: false,
      eligible: true,
      requirements: { bins: ['node'], anyBins: [], env: [], config: [], os: [] },
      missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
      configChecks: [],
      install: [],
    },
    {
      name: 'computer',
      description: 'Desktop automation',
      source: 'openclaw-bundled',
      bundled: true,
      filePath: '/Users/test/.openclaw/bundled/computer/SKILL.md',
      baseDir: '/Users/test/.openclaw/bundled/computer',
      skillKey: 'computer',
      emoji: '🤖',
      always: false,
      disabled: false,
      blockedByAllowlist: false,
      eligible: true,
      requirements: { bins: [], anyBins: [], env: [], config: [], os: ['darwin'] },
      missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
      configChecks: [],
      install: [],
    },
    {
      name: 'discord',
      description: 'Send messages to Discord',
      source: 'openclaw-bundled',
      bundled: true,
      filePath: '/Users/test/.openclaw/bundled/discord/SKILL.md',
      baseDir: '/Users/test/.openclaw/bundled/discord',
      skillKey: 'discord',
      primaryEnv: 'DISCORD_BOT_TOKEN',
      emoji: '🎮',
      always: false,
      disabled: true,
      blockedByAllowlist: false,
      eligible: false,
      requirements: { bins: [], anyBins: [], env: ['DISCORD_BOT_TOKEN'], config: ['channels.discord.token'], os: [] },
      missing: { bins: [], anyBins: [], env: ['DISCORD_BOT_TOKEN'], config: ['channels.discord.token'], os: [] },
      configChecks: [{ path: 'channels.discord.token', satisfied: false }],
      install: [],
    },
  ] as SkillStatusEntry[],
};

export const SKILLS_UPDATE_RESPONSE = {
  ok: true,
  skillKey: 'discord',
  config: { enabled: true },
};

// ── channels.status ─────────────────────────────────────────────────────────

export const CHANNELS_STATUS_RESPONSE = {
  ts: Date.now(),
  channelOrder: ['telegram', 'discord', 'web'],
  channelLabels: {
    telegram: 'Telegram',
    discord: 'Discord',
    web: 'Web',
  },
  channelDetailLabels: {
    telegram: 'Telegram Bot',
    discord: 'Discord Bot',
    web: 'Web Interface',
  },
  channels: {
    telegram: { configured: true },
    discord: { configured: true },
    web: { configured: true },
  },
  channelAccounts: {
    telegram: [
      {
        accountId: 'default',
        name: '@research_bot',
        enabled: true,
        configured: true,
        connected: true,
        running: true,
        mode: 'webhook',
        lastInboundAt: Date.now() - 7200_000,
        lastOutboundAt: Date.now() - 900_000,
        lastError: null,
      },
    ] as ChannelAccount[],
    discord: [
      {
        accountId: 'default',
        name: 'ResearchClaw#1234',
        enabled: false,
        configured: true,
        connected: false,
        running: false,
        tokenStatus: 'configured',
        lastError: null,
      },
    ] as ChannelAccount[],
    web: [
      {
        accountId: 'default',
        enabled: true,
        configured: true,
        connected: true,
        running: true,
        mode: 'local',
        lastError: null,
      },
    ] as ChannelAccount[],
  },
  channelDefaultAccountId: {
    telegram: 'default',
    discord: 'default',
    web: 'default',
  },
};

export const CHANNELS_LOGOUT_RESPONSE = {
  channel: 'telegram',
  accountId: 'default',
  cleared: true,
};

// ── config.get (plugins section) ────────────────────────────────────────────

export const CONFIG_GET_RESPONSE = {
  config: {
    plugins: {
      enabled: true,
      load: {
        paths: ['/Users/test/research-claw/extensions/research-claw-core'],
      },
      entries: {
        'research-claw-core': {
          enabled: true,
          config: {
            dbPath: '.research-claw/library.db',
            autoTrackGit: true,
            defaultCitationStyle: 'apa',
            heartbeatDeadlineWarningHours: 48,
          },
        },
      },
    },
  },
  resolved: {},
  raw: null,
  hash: 'abc123',
};
