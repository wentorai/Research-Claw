/**
 * ExtensionsPanel — Skills, Channels, and Plugins management
 *
 * Three sub-tabs via Segmented control:
 *   - Skills:   SKILL.md-based capabilities (local + research-plugins + bundled)
 *   - Channels: Messaging/integration channels (Telegram, Discord, etc.)
 *   - Plugins:  Plugin entries from openclaw.json
 *
 * Pattern: follows MonitorPanel (expandable cards + toggle switches)
 */

import React, { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { App, Button, Input, Modal, Segmented, Switch, Tag, Tooltip, Typography } from 'antd';
import {
  ApiOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CopyOutlined,
  DownOutlined,
  ExclamationCircleOutlined,
  LinkOutlined,
  LoadingOutlined,
  LogoutOutlined,
  ReloadOutlined,
  SettingOutlined,
  UpOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useGatewayStore } from '../../stores/gateway';
import { useConfigStore } from '../../stores/config';
import {
  useExtensionsStore,
  classifySkill,
  GROUP_ORDER,
  type SkillStatusEntry,
  type SkillGroup,
  type ChannelEntry,
  type ChannelAccount,
  type PluginEntry,
} from '../../stores/extensions';
import { getThemeTokens } from '../../styles/theme';
import { relativeTime } from '../../utils/relativeTime';

const { Text } = Typography;
const { Search } = Input;

type SubTab = 'skills' | 'channels' | 'plugins';

// ── Skill Card ──────────────────────────────────────────────────────────────

function SkillCard({
  skill,
  expanded,
  onToggleExpand,
  tokens,
}: {
  skill: SkillStatusEntry;
  expanded: boolean;
  onToggleExpand: () => void;
  tokens: ReturnType<typeof getThemeTokens>;
}) {
  const { t } = useTranslation();
  const { message: messageApi } = App.useApp();
  const { toggleSkill } = useExtensionsStore();

  const isActive = !skill.disabled && skill.eligible;
  const hasMissing =
    skill.missing.bins.length > 0 ||
    skill.missing.env.length > 0 ||
    skill.missing.config.length > 0;

  const handleToggle = useCallback(
    (checked: boolean) => {
      toggleSkill(skill.skillKey, checked).then(() => {
        messageApi.success(
          checked
            ? t('extensions.skills.enableSuccess', 'Skill enabled')
            : t('extensions.skills.disableSuccess', 'Skill disabled'),
        );
      }).catch(() => {
        messageApi.error(t('extensions.skills.updateFailed', 'Failed to update skill'));
      });
    },
    [skill.skillKey, toggleSkill, messageApi, t],
  );

  const handleCopyPath = useCallback((path: string) => {
    navigator.clipboard.writeText(path).then(
      () => messageApi.success(t('extensions.skills.pathCopied', 'Path copied')),
      () => messageApi.error(t('extensions.skills.copyFailed', 'Copy failed')),
    );
  }, [messageApi, t]);

  // Truncate path for display
  const shortPath = useMemo(() => {
    const p = skill.filePath;
    if (p.length <= 50) return p;
    const parts = p.split('/');
    if (parts.length <= 4) return p;
    return `~/${parts.slice(-3).join('/')}`;
  }, [skill.filePath]);

  return (
    <>
      {/* Collapsed row */}
      <div
        onClick={onToggleExpand}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggleExpand();
          }
        }}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={skill.name}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          cursor: 'pointer',
          borderRadius: expanded ? '6px 6px 0 0' : 6,
          background: expanded ? tokens.bg.surfaceHover : 'transparent',
          borderLeft: `3px solid ${isActive ? tokens.accent.green : hasMissing ? tokens.accent.amber : tokens.text.muted}`,
          transition: 'background 0.15s',
        }}
      >
        {/* Emoji or icon */}
        <span style={{ fontSize: 14, width: 18, textAlign: 'center', flexShrink: 0 }}>
          {skill.emoji || '📄'}
        </span>

        {/* Name + description */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Text strong style={{ color: tokens.text.primary, fontSize: 13 }} ellipsis>
              {skill.name}
            </Text>
          </div>
          <Text
            style={{ color: tokens.text.muted, fontSize: 11, display: 'block' }}
            ellipsis
          >
            {skill.description}
          </Text>
        </div>

        {/* Missing deps warning */}
        {hasMissing && !skill.disabled && (
          <Tooltip title={t('extensions.skills.missingDeps', 'Missing dependencies')}>
            <ExclamationCircleOutlined style={{ color: tokens.accent.amber, fontSize: 12 }} />
          </Tooltip>
        )}

        {/* Toggle */}
        <Switch
          size="small"
          checked={!skill.disabled}
          onChange={handleToggle}
          onClick={(_, e) => e.stopPropagation()}
        />

        {/* Expand arrow */}
        <span style={{ color: tokens.text.muted, fontSize: 10 }}>
          {expanded ? <UpOutlined /> : <DownOutlined />}
        </span>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div
          style={{
            padding: '8px 12px 12px 24px',
            borderLeft: `3px solid ${isActive ? tokens.accent.green : hasMissing ? tokens.accent.amber : tokens.text.muted}`,
            background: tokens.bg.surfaceHover,
            borderRadius: '0 0 6px 6px',
            marginTop: -2,
          }}
        >
          {/* Key */}
          <div style={{ marginBottom: 4 }}>
            <Text style={{ color: tokens.text.muted, fontSize: 11 }}>
              {t('extensions.skills.key', 'Key')}:{' '}
            </Text>
            <Text style={{ color: tokens.text.primary, fontSize: 12, fontFamily: 'var(--font-mono)' }}>
              {skill.skillKey}
            </Text>
          </div>

          {/* Source */}
          <div style={{ marginBottom: 4 }}>
            <Text style={{ color: tokens.text.muted, fontSize: 11 }}>
              {t('extensions.skills.source', 'Source')}:{' '}
            </Text>
            <Text style={{ color: tokens.text.secondary, fontSize: 12 }}>
              {skill.source}
            </Text>
          </div>

          {/* Path */}
          <div style={{ marginBottom: 4 }}>
            <Text style={{ color: tokens.text.muted, fontSize: 11 }}>
              {t('extensions.skills.path', 'Path')}:{' '}
            </Text>
            <Text
              style={{ color: tokens.text.secondary, fontSize: 11, fontFamily: 'var(--font-mono)' }}
            >
              {shortPath}
            </Text>
          </div>

          {/* Requirements */}
          {(skill.requirements.bins.length > 0 ||
            skill.requirements.env.length > 0 ||
            skill.configChecks.length > 0) && (
            <div style={{ marginBottom: 6 }}>
              <Text style={{ color: tokens.text.muted, fontSize: 11 }}>
                {t('extensions.skills.requirements', 'Requirements')}:
              </Text>
              {skill.requirements.bins.map((bin) => (
                <div key={bin} style={{ fontSize: 11, paddingLeft: 8 }}>
                  <span style={{ color: skill.missing.bins.includes(bin) ? tokens.accent.red : tokens.accent.green }}>
                    {skill.missing.bins.includes(bin) ? '✕' : '✓'}
                  </span>{' '}
                  <Text style={{ color: tokens.text.secondary, fontFamily: 'var(--font-mono)' }}>{bin}</Text>
                </div>
              ))}
              {skill.configChecks.map((check) => (
                <div key={check.path} style={{ fontSize: 11, paddingLeft: 8 }}>
                  <span style={{ color: check.satisfied ? tokens.accent.green : tokens.accent.red }}>
                    {check.satisfied ? '✓' : '✕'}
                  </span>{' '}
                  <Text style={{ color: tokens.text.secondary, fontFamily: 'var(--font-mono)' }}>{check.path}</Text>
                </div>
              ))}
              {skill.requirements.env.map((env) => (
                <div key={env} style={{ fontSize: 11, paddingLeft: 8 }}>
                  <span style={{ color: skill.missing.env.includes(env) ? tokens.accent.red : tokens.accent.green }}>
                    {skill.missing.env.includes(env) ? '✕' : '✓'}
                  </span>{' '}
                  <Text style={{ color: tokens.text.secondary, fontFamily: 'var(--font-mono)' }}>{env}</Text>
                </div>
              ))}
            </div>
          )}

          {/* Homepage link */}
          {skill.homepage && (
            <div style={{ marginBottom: 6 }}>
              <a
                href={skill.homepage}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: tokens.accent.blue, fontSize: 11 }}
              >
                <LinkOutlined /> {skill.homepage}
              </a>
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Button size="small" icon={<CopyOutlined />} onClick={() => handleCopyPath(skill.filePath)}>
              {t('extensions.skills.copyFilePath', 'Copy File Path')}
            </Button>
            <Button size="small" icon={<CopyOutlined />} onClick={() => handleCopyPath(skill.baseDir)}>
              {t('extensions.skills.copyDirPath', 'Copy Dir Path')}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

// ── Channel Card ────────────────────────────────────────────────────────────

function ChannelCard({
  channel,
  expanded,
  onToggleExpand,
  tokens,
}: {
  channel: ChannelEntry;
  expanded: boolean;
  onToggleExpand: () => void;
  tokens: ReturnType<typeof getThemeTokens>;
}) {
  const { t } = useTranslation();
  const { message: messageApi } = App.useApp();
  const { logoutChannel } = useExtensionsStore();
  const [logoutConfirm, setLogoutConfirm] = useState(false);

  const defaultAccount: ChannelAccount | undefined =
    channel.accounts.find((a) => a.accountId === channel.defaultAccountId) ?? channel.accounts[0];

  const isConnected = defaultAccount?.connected === true;
  const isConfigured = defaultAccount?.configured === true;
  const hasError = !!defaultAccount?.lastError;

  const statusColor = isConnected
    ? tokens.accent.green
    : isConfigured
      ? tokens.accent.blue
      : hasError
        ? tokens.accent.red
        : tokens.text.muted;

  const statusText = isConnected
    ? t('extensions.channels.connected', 'Connected')
    : isConfigured
      ? t('extensions.channels.configured', 'Configured')
      : hasError
        ? t('extensions.channels.error', 'Error')
        : t('extensions.channels.notConfigured', 'Not configured');

  const handleLogout = useCallback(() => {
    setLogoutConfirm(true);
  }, []);

  const confirmLogout = useCallback(() => {
    logoutChannel(channel.id, defaultAccount?.accountId).then(() => {
      messageApi.success(t('extensions.channels.logoutSuccess', 'Logged out'));
    }).catch(() => {
      messageApi.error(t('extensions.channels.logoutFailed', 'Logout failed'));
    });
    setLogoutConfirm(false);
  }, [channel.id, defaultAccount?.accountId, logoutChannel, messageApi, t]);

  return (
    <>
      {/* Collapsed row */}
      <div
        onClick={onToggleExpand}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggleExpand();
          }
        }}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={channel.label}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          cursor: 'pointer',
          borderRadius: expanded ? '6px 6px 0 0' : 6,
          background: expanded ? tokens.bg.surfaceHover : 'transparent',
          borderLeft: `3px solid ${statusColor}`,
          transition: 'background 0.15s',
        }}
      >
        {/* Status dot */}
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            backgroundColor: statusColor,
            flexShrink: 0,
          }}
        />

        {/* Label + account */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Text strong style={{ color: tokens.text.primary, fontSize: 13 }} ellipsis>
              {channel.label}
            </Text>
            <Tag
              style={{
                fontSize: 10,
                lineHeight: '16px',
                padding: '0 4px',
                border: 'none',
                background: tokens.bg.surfaceHover,
                color: statusColor,
              }}
            >
              {statusText}
            </Tag>
          </div>
          <Text style={{ color: tokens.text.muted, fontSize: 11, display: 'block' }} ellipsis>
            {t('extensions.channels.account', 'Account')}: {defaultAccount?.name ?? defaultAccount?.accountId ?? 'default'}
          </Text>
        </div>

        {/* Expand arrow */}
        <span style={{ color: tokens.text.muted, fontSize: 10 }}>
          {expanded ? <UpOutlined /> : <DownOutlined />}
        </span>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div
          style={{
            padding: '8px 12px 12px 24px',
            borderLeft: `3px solid ${statusColor}`,
            background: tokens.bg.surfaceHover,
            borderRadius: '0 0 6px 6px',
            marginTop: -2,
          }}
        >
          {/* Accounts list */}
          {channel.accounts.map((account) => (
            <div
              key={account.accountId}
              style={{
                marginBottom: 6,
                padding: '4px 0',
                borderBottom: channel.accounts.length > 1 ? `1px solid ${tokens.border.default}` : 'none',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                <span style={{ color: account.connected ? tokens.accent.green : tokens.text.muted, fontSize: 12 }}>
                  {account.connected ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
                </span>
                <Text style={{ color: tokens.text.primary, fontSize: 12 }}>
                  {account.name ?? account.accountId}
                  {account.accountId === channel.defaultAccountId && (
                    <Text style={{ color: tokens.text.muted, fontSize: 10 }}> (default)</Text>
                  )}
                </Text>
              </div>

              {account.mode && (
                <div style={{ fontSize: 11, paddingLeft: 20, color: tokens.text.muted }}>
                  {t('extensions.channels.mode', 'Mode')}: {account.mode}
                </div>
              )}

              {account.lastInboundAt && (
                <div style={{ fontSize: 11, paddingLeft: 20, color: tokens.text.muted }}>
                  {t('extensions.channels.lastInbound', 'Last inbound')}: {relativeTime(new Date(account.lastInboundAt).toISOString())}
                </div>
              )}

              {account.lastOutboundAt && (
                <div style={{ fontSize: 11, paddingLeft: 20, color: tokens.text.muted }}>
                  {t('extensions.channels.lastOutbound', 'Last outbound')}: {relativeTime(new Date(account.lastOutboundAt).toISOString())}
                </div>
              )}

              {account.lastError && (
                <div
                  style={{
                    margin: '4px 0 4px 20px',
                    padding: '4px 8px',
                    background: 'rgba(239, 68, 68, 0.1)',
                    borderRadius: 4,
                    fontSize: 11,
                    color: tokens.accent.red,
                  }}
                >
                  {account.lastError}
                </div>
              )}
            </div>
          ))}

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            {isConfigured && (
              <Button
                size="small"
                danger
                icon={<LogoutOutlined />}
                onClick={handleLogout}
              >
                {t('extensions.channels.logout', 'Logout')}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Logout confirm modal */}
      <Modal
        title={t('extensions.channels.logoutConfirmTitle', 'Logout from channel')}
        open={logoutConfirm}
        onOk={confirmLogout}
        onCancel={() => setLogoutConfirm(false)}
        okText={t('extensions.channels.logout', 'Logout')}
        okButtonProps={{ danger: true }}
      >
        {t('extensions.channels.logoutConfirmContent', {
          defaultValue: 'Logout from {{channel}}? Credentials will be cleared.',
          channel: channel.label,
        })}
      </Modal>
    </>
  );
}

// ── Plugin Card ─────────────────────────────────────────────────────────────

function PluginCard({
  plugin,
  expanded,
  onToggleExpand,
  tokens,
}: {
  plugin: PluginEntry;
  expanded: boolean;
  onToggleExpand: () => void;
  tokens: ReturnType<typeof getThemeTokens>;
}) {
  const { t } = useTranslation();
  const { message: messageApi } = App.useApp();
  const { togglePlugin } = useExtensionsStore();

  const handleToggle = useCallback(
    (checked: boolean) => {
      togglePlugin(plugin.name, checked).catch(() => {
        messageApi.error(t('extensions.plugins.toggleFailed', 'Failed to toggle plugin'));
      });
    },
    [plugin.name, togglePlugin, messageApi, t],
  );

  // Truncate path for display
  const shortPath = useMemo(() => {
    const p = plugin.path;
    if (!p) return '—';
    if (p.length <= 45) return p;
    const parts = p.split('/');
    if (parts.length <= 3) return p;
    return `.../${parts.slice(-2).join('/')}`;
  }, [plugin.path]);

  return (
    <>
      <div
        onClick={onToggleExpand}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggleExpand();
          }
        }}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={plugin.name}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          cursor: 'pointer',
          borderRadius: expanded ? '6px 6px 0 0' : 6,
          background: expanded ? tokens.bg.surfaceHover : 'transparent',
          borderLeft: `3px solid ${plugin.enabled ? tokens.accent.green : tokens.text.muted}`,
          transition: 'background 0.15s',
        }}
      >
        <span style={{ fontSize: 14, color: tokens.accent.blue }}>
          <SettingOutlined />
        </span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <Text strong style={{ color: tokens.text.primary, fontSize: 13 }} ellipsis>
            {plugin.name}
          </Text>
          <Text style={{ color: tokens.text.muted, fontSize: 11, display: 'block' }} ellipsis>
            {shortPath}
          </Text>
        </div>

        <Switch
          size="small"
          checked={plugin.enabled}
          onChange={handleToggle}
          onClick={(_, e) => e.stopPropagation()}
        />

        <span style={{ color: tokens.text.muted, fontSize: 10 }}>
          {expanded ? <UpOutlined /> : <DownOutlined />}
        </span>
      </div>

      {expanded && (
        <div
          style={{
            padding: '8px 12px 12px 24px',
            borderLeft: `3px solid ${plugin.enabled ? tokens.accent.green : tokens.text.muted}`,
            background: tokens.bg.surfaceHover,
            borderRadius: '0 0 6px 6px',
            marginTop: -2,
          }}
        >
          <div style={{ marginBottom: 4 }}>
            <Text style={{ color: tokens.text.muted, fontSize: 11 }}>
              {t('extensions.plugins.path', 'Path')}:{' '}
            </Text>
            <Text style={{ color: tokens.text.secondary, fontSize: 11, fontFamily: 'var(--font-mono)' }}>
              {plugin.path || '—'}
            </Text>
          </div>

          {Object.keys(plugin.config).length > 0 && (
            <div style={{ marginTop: 6 }}>
              <Text style={{ color: tokens.text.muted, fontSize: 11 }}>
                {t('extensions.plugins.config', 'Config')}:
              </Text>
              {Object.entries(plugin.config).map(([key, value]) => (
                <div
                  key={key}
                  style={{ fontSize: 11, paddingLeft: 8, color: tokens.text.secondary }}
                >
                  <Text style={{ fontFamily: 'var(--font-mono)', color: tokens.text.muted }}>
                    {key}:
                  </Text>{' '}
                  {String(value)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ── Skills Sub-Tab ──────────────────────────────────────────────────────────

function SkillsTab({ tokens }: { tokens: ReturnType<typeof getThemeTokens> }) {
  const { t } = useTranslation();
  const { skills, skillsLoading } = useExtensionsStore();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const filteredSkills = useMemo(() => {
    if (!filter.trim()) return skills;
    const q = filter.toLowerCase();
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.skillKey.toLowerCase().includes(q),
    );
  }, [skills, filter]);

  const grouped = useMemo(() => {
    const map = new Map<SkillGroup, SkillStatusEntry[]>();
    for (const group of GROUP_ORDER) {
      map.set(group, []);
    }
    for (const skill of filteredSkills) {
      const group = classifySkill(skill);
      map.get(group)!.push(skill);
    }
    // Remove empty groups
    for (const group of GROUP_ORDER) {
      if (map.get(group)!.length === 0) map.delete(group);
    }
    return map;
  }, [filteredSkills]);

  if (skillsLoading) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 16px' }}>
        <LoadingOutlined style={{ fontSize: 24, color: tokens.text.muted, display: 'block', marginBottom: 12 }} />
        <Text style={{ color: tokens.text.muted, fontSize: 13 }}>
          {t('extensions.loading', 'Loading extensions...')}
        </Text>
      </div>
    );
  }

  if (skills.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 16px' }}>
        <ApiOutlined style={{ fontSize: 32, color: tokens.text.muted, display: 'block', marginBottom: 12 }} />
        <Text style={{ color: tokens.text.muted, fontSize: 13 }}>
          {t('extensions.skills.empty', 'No skills loaded.')}
        </Text>
      </div>
    );
  }

  return (
    <div>
      {/* Search/filter */}
      <div style={{ padding: '8px 12px 4px' }}>
        <Search
          placeholder={t('extensions.skills.search', 'Filter skills...')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          allowClear
          size="small"
        />
      </div>

      {/* Grouped skill list */}
      <div style={{ padding: '4px 8px' }}>
        {GROUP_ORDER.filter((g) => grouped.has(g)).map((group) => (
          <div key={group} style={{ marginBottom: 12 }}>
            <Text
              style={{
                color: tokens.text.muted,
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
                display: 'block',
                padding: '8px 4px 4px',
              }}
            >
              {t(`extensions.skills.group.${group}`, group)}
            </Text>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {grouped.get(group)!.map((skill) => (
                <SkillCard
                  key={skill.skillKey}
                  skill={skill}
                  expanded={expandedKey === skill.skillKey}
                  onToggleExpand={() => setExpandedKey((prev) => (prev === skill.skillKey ? null : skill.skillKey))}
                  tokens={tokens}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Channels Sub-Tab ────────────────────────────────────────────────────────

function ChannelsTab({ tokens }: { tokens: ReturnType<typeof getThemeTokens> }) {
  const { t } = useTranslation();
  const { channels, channelsLoading } = useExtensionsStore();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (channelsLoading) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 16px' }}>
        <LoadingOutlined style={{ fontSize: 24, color: tokens.text.muted, display: 'block', marginBottom: 12 }} />
        <Text style={{ color: tokens.text.muted, fontSize: 13 }}>
          {t('extensions.loading', 'Loading extensions...')}
        </Text>
      </div>
    );
  }

  if (channels.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 16px' }}>
        <ApiOutlined style={{ fontSize: 32, color: tokens.text.muted, display: 'block', marginBottom: 12 }} />
        <Text style={{ color: tokens.text.muted, fontSize: 13 }}>
          {t('extensions.channels.empty', 'No channels configured.')}
        </Text>
        <br />
        <Text style={{ color: tokens.text.muted, fontSize: 12 }}>
          {t('extensions.channels.emptyHint', 'Configure messaging channels in openclaw.json to enable integrations.')}
        </Text>
      </div>
    );
  }

  return (
    <div style={{ padding: '8px 8px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {channels.map((channel) => (
          <ChannelCard
            key={channel.id}
            channel={channel}
            expanded={expandedId === channel.id}
            onToggleExpand={() => setExpandedId((prev) => (prev === channel.id ? null : channel.id))}
            tokens={tokens}
          />
        ))}
      </div>
    </div>
  );
}

// ── Plugins Sub-Tab ─────────────────────────────────────────────────────────

function PluginsTab({ tokens }: { tokens: ReturnType<typeof getThemeTokens> }) {
  const { t } = useTranslation();
  const { message: messageApi } = App.useApp();
  const { plugins, pluginsLoaded } = useExtensionsStore();
  const [expandedName, setExpandedName] = useState<string | null>(null);

  const handleCopyConfigPath = useCallback(() => {
    // Config path is typically ~/.openclaw/openclaw.json
    const configPath = '~/.openclaw/openclaw.json';
    navigator.clipboard.writeText(configPath).then(
      () => messageApi.success(t('extensions.skills.pathCopied', 'Path copied')),
      () => messageApi.error(t('extensions.skills.copyFailed', 'Copy failed')),
    );
  }, [messageApi, t]);

  if (!pluginsLoaded) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 16px' }}>
        <LoadingOutlined style={{ fontSize: 24, color: tokens.text.muted, display: 'block', marginBottom: 12 }} />
        <Text style={{ color: tokens.text.muted, fontSize: 13 }}>
          {t('extensions.loading', 'Loading extensions...')}
        </Text>
      </div>
    );
  }

  if (plugins.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 16px' }}>
        <SettingOutlined style={{ fontSize: 32, color: tokens.text.muted, display: 'block', marginBottom: 12 }} />
        <Text style={{ color: tokens.text.muted, fontSize: 13 }}>
          {t('extensions.plugins.empty', 'No plugins loaded.')}
        </Text>
      </div>
    );
  }

  return (
    <div>
      <div style={{ padding: '8px 8px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {plugins.map((plugin) => (
            <PluginCard
              key={plugin.name}
              plugin={plugin}
              expanded={expandedName === plugin.name}
              onToggleExpand={() => setExpandedName((prev) => (prev === plugin.name ? null : plugin.name))}
              tokens={tokens}
            />
          ))}
        </div>
      </div>

      {/* Copy config path button */}
      <div style={{ padding: '12px 12px 8px', borderTop: `1px solid ${tokens.border.default}` }}>
        <Button
          block
          icon={<CopyOutlined />}
          onClick={handleCopyConfigPath}
          style={{ borderStyle: 'dashed', color: tokens.text.secondary }}
        >
          {t('extensions.plugins.copyConfigPath', 'Copy openclaw.json Path')}
        </Button>
      </div>
    </div>
  );
}

// ── Main Panel ──────────────────────────────────────────────────────────────

export default function ExtensionsPanel() {
  const { t } = useTranslation();
  const theme = useConfigStore((s) => s.theme);
  const tokens = getThemeTokens(theme);
  const isConnected = useGatewayStore((s) => s.state === 'connected');
  const skills = useExtensionsStore((s) => s.skills);
  const channels = useExtensionsStore((s) => s.channels);
  const skillsLoading = useExtensionsStore((s) => s.skillsLoading);
  const channelsLoading = useExtensionsStore((s) => s.channelsLoading);
  const skillsLoaded = useExtensionsStore((s) => s.skillsLoaded);
  const channelsLoaded = useExtensionsStore((s) => s.channelsLoaded);
  const pluginsLoaded = useExtensionsStore((s) => s.pluginsLoaded);
  const { loadSkills, loadChannels, loadPlugins } = useExtensionsStore();

  const [activeTab, setActiveTab] = useState<SubTab>('skills');
  const [isPending, startTransition] = useTransition();

  // Load data on connection
  useEffect(() => {
    if (isConnected && !skillsLoaded) loadSkills();
    if (isConnected && !channelsLoaded) loadChannels();
    if (isConnected && !pluginsLoaded) loadPlugins();
  }, [isConnected, skillsLoaded, channelsLoaded, pluginsLoaded, loadSkills, loadChannels, loadPlugins]);

  const handleRefresh = useCallback(() => {
    if (activeTab === 'skills') loadSkills();
    else if (activeTab === 'channels') loadChannels(true); // probe on manual refresh
    else loadPlugins();
  }, [activeTab, loadSkills, loadChannels, loadPlugins]);

  const isLoading = activeTab === 'skills' ? skillsLoading : activeTab === 'channels' ? channelsLoading : false;

  const totalCount = skills.length + channels.length;
  const activeCount = skills.filter((s) => !s.disabled && s.eligible).length +
    channels.filter((c) => {
      const account = c.accounts.find((a) => a.accountId === c.defaultAccountId) ?? c.accounts[0];
      return account?.connected === true;
    }).length;

  if (!isConnected) {
    return (
      <div style={{ padding: 16, textAlign: 'center' }}>
        <Text style={{ color: tokens.text.muted }}>
          {t('extensions.disconnected', 'Connect to gateway to view extensions')}
        </Text>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          borderBottom: `1px solid ${tokens.border.default}`,
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ApiOutlined style={{ color: tokens.accent.blue }} />
          <Text strong style={{ color: tokens.text.primary, fontSize: 14 }}>
            {t('extensions.title', 'Extensions')}
          </Text>
          {totalCount > 0 && (
            <Tag
              style={{
                fontSize: 10,
                lineHeight: '16px',
                padding: '0 6px',
                border: 'none',
                background: tokens.bg.surfaceHover,
                color: tokens.text.secondary,
              }}
            >
              {activeCount} / {totalCount}
            </Tag>
          )}
        </div>
        <Button size="small" icon={<ReloadOutlined />} onClick={handleRefresh} loading={isLoading} />
      </div>

      {/* Sub-tab selector */}
      <div style={{ padding: '8px 16px', flexShrink: 0 }}>
        <Segmented
          block
          value={activeTab}
          onChange={(val) => startTransition(() => setActiveTab(val as SubTab))}
          options={[
            { label: t('extensions.tabs.skills', 'Skills'), value: 'skills' },
            { label: t('extensions.tabs.channels', 'Channels'), value: 'channels' },
            { label: t('extensions.tabs.plugins', 'Plugins'), value: 'plugins' },
          ]}
          size="small"
        />
      </div>

      {/* Content — show spinner overlay during tab transition */}
      <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
        {isPending && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--surface)',
            zIndex: 1,
          }}>
            <LoadingOutlined style={{ fontSize: 24, color: tokens.text.muted }} />
          </div>
        )}
        {activeTab === 'skills' && <SkillsTab tokens={tokens} />}
        {activeTab === 'channels' && <ChannelsTab tokens={tokens} />}
        {activeTab === 'plugins' && <PluginsTab tokens={tokens} />}
      </div>
    </div>
  );
}
