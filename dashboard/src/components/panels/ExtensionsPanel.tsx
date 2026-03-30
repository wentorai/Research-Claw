/**
 * ExtensionsPanel — Skills, Channels, and Plugins management
 *
 * Three sub-tabs via Segmented control:
 *   - Skills:   SKILL.md-based capabilities (local + research-plugins + bundled)
 *   - Channels: Messaging/integration channels (Telegram, Discord, etc.)
 *   - Plugins:  Plugin entries from openclaw.json
 *
 * Pattern: follows MonitorPanel (expandable cards + toggle switches)
 *
 * Performance: Skills tab uses react-window v2 virtual list to handle 500+ skills
 * without DOM bloat. SkillCard is React.memo'd with stable props.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App, Button, Input, Modal, Segmented, Select, Switch, Tag, Tooltip, Typography } from 'antd';
import {
  ApiOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownOutlined,
  ExclamationCircleOutlined,
  LinkOutlined,
  QuestionCircleOutlined,
  LoadingOutlined,
  MessageOutlined,
  ReloadOutlined,
  SettingOutlined,
  UpOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { List } from 'react-window';
import { useGatewayStore } from '../../stores/gateway';
import { useChatStore } from '../../stores/chat';
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
import DockerFileModal from './DockerFileModal';
import type { DockerFileModalProps } from './DockerFileModal';

const { Text } = Typography;
const { Search } = Input;

type SubTab = 'skills' | 'channels' | 'plugins' | 'ppt';

/** Channels that support QR code login via web.login.start / web.login.wait */
const QR_LOGIN_CHANNELS = new Set(['openclaw-weixin', 'whatsapp']);

// ── Virtual list types & constants ───────────────────────────────────────────

type FlatItem =
  | { type: 'header'; group: SkillGroup }
  | { type: 'skill'; skill: SkillStatusEntry };

interface SkillRowProps {
  flatItems: FlatItem[];
  expandedKey: string | null;
  onToggleExpand: (skillKey: string) => void;
  onToggle: (skillKey: string, enabled: boolean) => Promise<void>;
  tokens: ReturnType<typeof getThemeTokens>;
  groupLabels: Record<string, string>;
}

const COLLAPSED_SKILL_HEIGHT = 52;
const GROUP_HEADER_HEIGHT = 36;

function estimateExpandedHeight(skill: SkillStatusEntry): number {
  let h = 50; // collapsed row
  h += 22; // detail padding (8 top + 12 bottom + marginTop -2 overlap)
  h += 20; // key line + margin
  h += 20; // source line + margin
  h += 20; // path line + margin
  const reqCount =
    skill.requirements.bins.length +
    skill.configChecks.length +
    skill.requirements.env.length;
  if (reqCount > 0) {
    h += 20; // "Requirements:" label
    h += reqCount * 18;
    h += 8; // section margin
  }
  if (skill.homepage) h += 26;
  h += 44; // action buttons + marginTop
  h += 16; // safety buffer
  return h;
}

// ── Skill Card (memoized) ────────────────────────────────────────────────────

const SkillCard = React.memo(function SkillCard({
  skill,
  expanded,
  onToggleExpand,
  onToggle,
  tokens,
}: {
  skill: SkillStatusEntry;
  expanded: boolean;
  onToggleExpand: (skillKey: string) => void;
  onToggle: (skillKey: string, enabled: boolean) => Promise<void>;
  tokens: ReturnType<typeof getThemeTokens>;
}) {
  const { t } = useTranslation();
  const { message: messageApi } = App.useApp();

  const isActive = !skill.disabled && skill.eligible;
  const hasMissing =
    skill.missing.bins.length > 0 ||
    skill.missing.env.length > 0 ||
    skill.missing.config.length > 0;

  const handleToggle = useCallback(
    (checked: boolean) => {
      onToggle(skill.skillKey, checked).then(() => {
        messageApi.success(
          checked
            ? t('extensions.skills.enableSuccess', 'Skill enabled')
            : t('extensions.skills.disableSuccess', 'Skill disabled'),
        );
      }).catch(() => {
        messageApi.error(t('extensions.skills.updateFailed', 'Failed to update skill'));
      });
    },
    [skill.skillKey, onToggle, messageApi, t],
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

  const handleExpand = useCallback(() => {
    onToggleExpand(skill.skillKey);
  }, [onToggleExpand, skill.skillKey]);

  return (
    <>
      {/* Collapsed row */}
      <div
        onClick={handleExpand}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleExpand();
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
});

// ── Skill Row (virtual list row renderer for react-window v2) ────────────────

function SkillRow({
  index,
  style,
  flatItems,
  expandedKey,
  onToggleExpand,
  onToggle,
  tokens,
  groupLabels,
}: SkillRowProps & {
  index: number;
  style: React.CSSProperties;
  ariaAttributes: { 'aria-posinset': number; 'aria-setsize': number; role: 'listitem' };
}) {
  const item = flatItems[index];
  if (!item) return null;

  if (item.type === 'header') {
    return (
      <div style={{ ...style, padding: '8px 12px 4px' }}>
        <Text
          style={{
            color: tokens.text.muted,
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}
        >
          {groupLabels[item.group] ?? item.group}
        </Text>
      </div>
    );
  }

  return (
    <div style={{ ...style, padding: '0 8px' }}>
      <SkillCard
        skill={item.skill}
        expanded={expandedKey === item.skill.skillKey}
        onToggleExpand={onToggleExpand}
        onToggle={onToggle}
        tokens={tokens}
      />
    </div>
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
  const { enableChannel, deleteChannel } = useExtensionsStore();
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const defaultAccount: ChannelAccount | undefined =
    channel.accounts.find((a) => a.accountId === channel.defaultAccountId) ?? channel.accounts[0];

  // OC built-in channels vary in which status fields they set:
  //   Discord, WhatsApp, WeChat → set connected=true explicitly
  //   Telegram, Slack, Signal, iMessage → only set running=true
  // Normalize: running + configured ≡ connected (live provider with valid creds).
  const isLive = (a: ChannelAccount) =>
    a.connected === true || (a.running === true && a.configured === true);

  // For channel-level status: use the best account (live > configured > any)
  // This prevents "not configured" when the default account is stale but another works fine.
  const bestAccount = useMemo(() => {
    const accts = channel.accounts;
    return accts.find(isLive)
      ?? accts.find((a) => a.configured)
      ?? defaultAccount;
  }, [channel.accounts, defaultAccount]);

  const isConnected = isLive(bestAccount ?? {} as ChannelAccount);
  const isConfigured = bestAccount?.configured === true;
  const isRunning = bestAccount?.running === true;
  const isEnabled = bestAccount?.enabled !== false;

  // Status priority: disabled > hasError > connected > configured > not configured
  // A disabled channel (enabled=false in config) should show as "disabled", not "error"
  const derivedDown = isEnabled && isConfigured && !isRunning && !isConnected;
  const hasError = isEnabled && (!!bestAccount?.lastError || derivedDown);

  const statusColor = !isEnabled
    ? tokens.text.muted
    : hasError
      ? tokens.accent.red
      : isConnected
        ? tokens.accent.green
        : isConfigured
          ? tokens.accent.blue
          : tokens.text.muted;

  const statusText = !isEnabled
    ? t('extensions.channels.disabled', 'Disabled')
    : hasError
      ? t('extensions.channels.error', 'Error')
      : isConnected
        ? t('extensions.channels.connected', 'Connected')
        : isConfigured
          ? t('extensions.channels.configured', 'Configured')
          : t('extensions.channels.notConfigured', 'Not configured');

  // Card-level error: only show structural issues (derivedDown).
  // Per-account lastError is shown in the expanded account list — no duplication.
  const errorMessage = derivedDown
    ? t('extensions.channels.providerDown', 'Provider not running')
    : '';

  const handleEnableToggle = useCallback(
    (checked: boolean) => {
      enableChannel(channel.id, checked).then(() => {
        messageApi.success(
          checked
            ? t('extensions.channels.enableSuccess', 'Channel enabled')
            : t('extensions.channels.disableSuccess', 'Channel disabled'),
        );
      }).catch(() => {
        messageApi.error(t('extensions.channels.toggleFailed', 'Failed to toggle channel'));
      });
    },
    [channel.id, enableChannel, messageApi, t],
  );

  const handleDelete = useCallback(() => {
    setDeleteConfirm(true);
  }, []);

  const confirmDelete = useCallback(() => {
    deleteChannel(channel.id).then(() => {
      messageApi.success(t('extensions.channels.deleteSuccess', 'Channel deleted'));
    }).catch(() => {
      messageApi.error(t('extensions.channels.deleteFailed', 'Failed to delete channel'));
    });
    setDeleteConfirm(false);
  }, [channel.id, deleteChannel, messageApi, t]);

  const handleAskAgent = useCallback(() => {
    let message: string;
    if (hasError) {
      message = `请帮我修复 ${channel.label} 通道连接`;
    } else if (!isConfigured) {
      message = `请帮我配置 ${channel.label} 通道`;
    } else {
      return; // No action needed for healthy configured channels
    }
    useChatStore.getState().send(message);
  }, [channel.label, hasError, isConfigured]);

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

        {/* Label + status */}
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

        {/* Enable/Disable switch */}
        {isConfigured && (
          <Switch
            size="small"
            checked={isEnabled}
            onChange={handleEnableToggle}
            onClick={(_, e) => e.stopPropagation()}
          />
        )}

        {/* Delete button */}
        {isConfigured && (
          <Tooltip title={t('extensions.channels.delete', 'Delete channel')}>
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                handleDelete();
              }}
              style={{ minWidth: 24, padding: '0 4px' }}
            />
          </Tooltip>
        )}

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
          {/* Error display */}
          {errorMessage && (
            <div
              style={{
                margin: '0 0 8px 0',
                padding: '4px 8px',
                background: 'rgba(239, 68, 68, 0.1)',
                borderRadius: 4,
                fontSize: 11,
                color: tokens.accent.red,
              }}
            >
              {errorMessage}
            </div>
          )}

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
                <span style={{ color: isLive(account) ? tokens.accent.green : tokens.text.muted, fontSize: 12 }}>
                  {isLive(account) ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
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
            {QR_LOGIN_CHANNELS.has(channel.id) && isEnabled && (
              <Button
                size="small"
                type="primary"
                icon={<LinkOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  useExtensionsStore.getState().startQrLogin(
                    channel.id,
                    defaultAccount?.accountId !== 'default' ? defaultAccount?.accountId : undefined,
                  );
                }}
              >
                {isConnected
                  ? t('extensions.channels.reconnect', 'Reconnect')
                  : t('extensions.channels.connect', 'Connect')}
              </Button>
            )}
            {(hasError || !isConfigured) && !QR_LOGIN_CHANNELS.has(channel.id) && (
              <Button
                size="small"
                icon={<MessageOutlined />}
                onClick={handleAskAgent}
              >
                {hasError
                  ? t('extensions.channels.askAgentFix', 'Ask Agent to Fix')
                  : t('extensions.channels.askAgentConfigure', 'Ask Agent to Configure')}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Delete confirm modal */}
      <Modal
        title={t('extensions.channels.deleteConfirmTitle', 'Delete channel')}
        open={deleteConfirm}
        onOk={confirmDelete}
        onCancel={() => setDeleteConfirm(false)}
        okText={t('extensions.channels.confirmDelete', 'Delete')}
        okButtonProps={{ danger: true }}
        centered
      >
        {t('extensions.channels.deleteConfirmContent', {
          defaultValue: 'Delete {{channel}}? This will remove the channel configuration.',
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

// ── Skills Sub-Tab (virtualized) ─────────────────────────────────────────────

function SkillsTab({ tokens }: { tokens: ReturnType<typeof getThemeTokens> }) {
  const { t } = useTranslation();
  const skills = useExtensionsStore((s) => s.skills);
  const skillsLoading = useExtensionsStore((s) => s.skillsLoading);
  const skillsLoaded = useExtensionsStore((s) => s.skillsLoaded);
  const toggleSkill = useExtensionsStore((s) => s.toggleSkill);
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

  // Flatten grouped skills into a single list for virtual rendering
  const flatItems = useMemo(() => {
    const map = new Map<SkillGroup, SkillStatusEntry[]>();
    for (const group of GROUP_ORDER) map.set(group, []);
    for (const skill of filteredSkills) {
      const group = classifySkill(skill);
      map.get(group)!.push(skill);
    }
    const items: FlatItem[] = [];
    for (const group of GROUP_ORDER) {
      const groupSkills = map.get(group)!;
      if (groupSkills.length === 0) continue;
      items.push({ type: 'header', group });
      for (const skill of groupSkills) {
        items.push({ type: 'skill', skill });
      }
    }
    return items;
  }, [filteredSkills]);

  const handleToggleExpand = useCallback((skillKey: string) => {
    setExpandedKey((prev) => (prev === skillKey ? null : skillKey));
  }, []);

  const groupLabels = useMemo(() => ({
    local: t('extensions.skills.group.local', 'local'),
    'research-plugins': t('extensions.skills.group.research-plugins', 'research-plugins'),
    managed: t('extensions.skills.group.managed', 'managed'),
    bundled: t('extensions.skills.group.bundled', 'bundled'),
  }), [t]);

  // Row height calculator — receives current rowProps so heights update when expandedKey changes
  const getRowHeight = useCallback(
    (index: number, rowProps: SkillRowProps): number => {
      const item = rowProps.flatItems[index];
      if (!item) return COLLAPSED_SKILL_HEIGHT;
      if (item.type === 'header') return GROUP_HEADER_HEIGHT;
      if (rowProps.expandedKey === item.skill.skillKey) {
        return estimateExpandedHeight(item.skill);
      }
      return COLLAPSED_SKILL_HEIGHT;
    },
    [],
  );

  const rowProps = useMemo<SkillRowProps>(
    () => ({
      flatItems,
      expandedKey,
      onToggleExpand: handleToggleExpand,
      onToggle: toggleSkill,
      tokens,
      groupLabels,
    }),
    [flatItems, expandedKey, handleToggleExpand, toggleSkill, tokens, groupLabels],
  );

  if (!skillsLoaded || skillsLoading) {
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
    <>
      {/* Search/filter */}
      <div style={{ padding: '8px 12px 4px', flexShrink: 0 }}>
        <Search
          placeholder={t('extensions.skills.search', 'Filter skills...')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          allowClear
          size="small"
        />
      </div>

      {/* Virtualized skill list — react-window v2 auto-sizes via ResizeObserver */}
      <List<SkillRowProps>
        rowComponent={SkillRow}
        rowCount={flatItems.length}
        rowHeight={getRowHeight}
        rowProps={rowProps}
        overscanCount={10}
        defaultHeight={600}
        style={{ flex: '1 1 0', minHeight: 0 }}
      />
    </>
  );
}

// ── Channels Sub-Tab ────────────────────────────────────────────────────────

// ── QR Login Modal ──────────────────────────────────────────────────────────

function QrLoginModal({ tokens }: { tokens: ReturnType<typeof getThemeTokens> }) {
  const { t } = useTranslation();
  const { message: messageApi } = App.useApp();
  const qrLoginState = useExtensionsStore((s) => s.qrLoginState);
  const qrLoginDataUrl = useExtensionsStore((s) => s.qrLoginDataUrl);
  const qrLoginMessage = useExtensionsStore((s) => s.qrLoginMessage);
  const qrLoginError = useExtensionsStore((s) => s.qrLoginError);
  const qrLoginChannelId = useExtensionsStore((s) => s.qrLoginChannelId);
  const cancelQrLogin = useExtensionsStore((s) => s.cancelQrLogin);

  const isOpen = qrLoginState !== 'idle';

  const handleClose = useCallback(() => {
    cancelQrLogin();
  }, [cancelQrLogin]);

  const handleRetry = useCallback(() => {
    const channelId = qrLoginChannelId;
    if (channelId) {
      cancelQrLogin();
      setTimeout(() => {
        useExtensionsStore.getState().startQrLogin(channelId);
      }, 100);
    }
  }, [qrLoginChannelId, cancelQrLogin]);

  useEffect(() => {
    if (qrLoginState === 'success') {
      messageApi.success(qrLoginMessage || t('extensions.channels.qrLoginSuccess', 'Connected!'));
      const timer = setTimeout(() => cancelQrLogin(), 2000);
      return () => clearTimeout(timer);
    }
  }, [qrLoginState, qrLoginMessage, messageApi, t, cancelQrLogin]);

  return (
    <Modal
      title={t('extensions.channels.qrLoginTitle', 'Scan QR Code to Connect')}
      open={isOpen}
      onCancel={handleClose}
      footer={null}
      centered
      width={360}
      destroyOnClose
    >
      <div style={{ textAlign: 'center', padding: '16px 0' }}>
        {qrLoginState === 'loading' && (
          <>
            <LoadingOutlined style={{ fontSize: 32, color: tokens.accent.blue, display: 'block', marginBottom: 16 }} />
            <Text style={{ color: tokens.text.muted, fontSize: 13 }}>
              {t('extensions.channels.qrLoginGenerating', 'Generating QR code...')}
            </Text>
          </>
        )}

        {qrLoginState === 'waiting' && qrLoginDataUrl && (
          <>
            <img
              src={qrLoginDataUrl}
              alt="QR Code"
              style={{
                width: 240,
                height: 240,
                borderRadius: 8,
                border: `1px solid ${tokens.border.default}`,
                background: '#fff',
                marginBottom: 16,
              }}
            />
            <div style={{ marginBottom: 8 }}>
              <Text style={{ color: tokens.text.primary, fontSize: 13 }}>
                {qrLoginMessage || t('extensions.channels.qrLoginScanPrompt', 'Scan the QR code with your app')}
              </Text>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <LoadingOutlined style={{ fontSize: 14, color: tokens.accent.blue }} />
              <Text style={{ color: tokens.text.muted, fontSize: 12 }}>
                {t('extensions.channels.qrLoginWaiting', 'Waiting for scan...')}
              </Text>
            </div>
          </>
        )}

        {qrLoginState === 'success' && (
          <>
            <CheckCircleOutlined style={{ fontSize: 48, color: tokens.accent.green, display: 'block', marginBottom: 16 }} />
            <Text style={{ color: tokens.accent.green, fontSize: 14, fontWeight: 600 }}>
              {qrLoginMessage || t('extensions.channels.qrLoginSuccess', 'Connected!')}
            </Text>
          </>
        )}

        {qrLoginState === 'error' && (
          <>
            <ExclamationCircleOutlined style={{ fontSize: 48, color: tokens.accent.red, display: 'block', marginBottom: 16 }} />
            <div style={{ marginBottom: 12 }}>
              <Text style={{ color: tokens.accent.red, fontSize: 13 }}>
                {qrLoginError || t('extensions.channels.qrLoginFailed', 'Login failed')}
              </Text>
            </div>
            <Button size="small" onClick={handleRetry}>
              {t('extensions.channels.qrLoginRetry', 'Retry')}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}

// ── Channels Sub-Tab ────────────────────────────────────────────────────────

function ChannelsTab({ tokens }: { tokens: ReturnType<typeof getThemeTokens> }) {
  const { t } = useTranslation();
  const channels = useExtensionsStore((s) => s.channels);
  const channelsLoading = useExtensionsStore((s) => s.channelsLoading);
  const channelsLoaded = useExtensionsStore((s) => s.channelsLoaded);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleAddChannel = useCallback(() => {
    useChatStore.getState().send('请帮我添加一个新的 IM 通道');
  }, []);

  if (!channelsLoaded || channelsLoading) {
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
        <Text style={{ color: tokens.text.muted, fontSize: 12, marginBottom: 12, display: 'inline-block' }}>
          {t('extensions.channels.emptyHint', 'Ask the agent to help you configure a messaging channel.')}
        </Text>
        <br />
        <Button
          icon={<MessageOutlined />}
          onClick={handleAddChannel}
          style={{ marginTop: 12, borderStyle: 'dashed', color: tokens.text.secondary }}
        >
          {t('extensions.channels.addChannel', 'Add Channel')}
        </Button>
      </div>
    );
  }

  return (
    <div>
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

      {/* Add Channel button — always visible at bottom */}
      <div style={{ padding: '12px 12px 8px', borderTop: `1px solid ${tokens.border.default}` }}>
        <Button
          block
          icon={<MessageOutlined />}
          onClick={handleAddChannel}
          style={{ borderStyle: 'dashed', color: tokens.text.secondary }}
        >
          {t('extensions.channels.addChannel', 'Add Channel')}
        </Button>
      </div>

      {/* QR Login Modal — rendered once, state-driven */}
      <QrLoginModal tokens={tokens} />
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

// ── PPT Sub-Tab (A+B integration) ───────────────────────────────────────────

type PptStatus = {
  pptRoot: string;
  exists: boolean;
  scriptsRoot: string;
  hasProjectManager: boolean;
  hasSvgToPptx: boolean;
};

type PptOutputsList = {
  root: string;
  files: string[];
};

const PROJECT_NAME_RE = /^[a-zA-Z0-9._-]+$/;

/** Canvas format definitions — from ppt-master/skills/ppt-master/scripts/config.py */
const CANVAS_FORMATS = [
  { key: 'ppt169',      dims: '1280×720' },
  { key: 'ppt43',       dims: '1024×768' },
  { key: 'xiaohongshu', dims: '1242×1660' },
  { key: 'moments',     dims: '1080×1080' },
  { key: 'story',       dims: '1080×1920' },
  { key: 'wechat',      dims: '900×383' },
  { key: 'banner',      dims: '1920×1080' },
  { key: 'a4',          dims: '1240×1754' },
] as const;

const LS_PROJECT_NAME = 'rc-ppt-project-name';
const LS_FORMAT = 'rc-ppt-format';

function PptTab({ tokens }: { tokens: ReturnType<typeof getThemeTokens> }) {
  const { t } = useTranslation();
  const { message: messageApi, modal: modalApi } = App.useApp();
  const client = useGatewayStore((s) => s.client);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<PptStatus | null>(null);
  const [lastResult, setLastResult] = useState<unknown>(null);
  const [availableOutputPath, setAvailableOutputPath] = useState<string>('');
  const [selectedSourceFilePath, setSelectedSourceFilePath] = useState<string>('');
  const [sourceFiles, setSourceFiles] = useState<string[]>([]);
  const [projectName, setProjectName] = useState(
    () => localStorage.getItem(LS_PROJECT_NAME) || 'demo-deck',
  );
  const [format, setFormat] = useState(
    () => localStorage.getItem(LS_FORMAT) || 'ppt169',
  );
  const [projectPath, setProjectPath] = useState('projects/demo-deck');
  const [stage, setStage] = useState('final');
  const [dockerModal, setDockerModal] = useState<Omit<DockerFileModalProps, 'open' | 'onClose'> | null>(null);

  // Refs for values used inside effect-triggered callbacks (avoids identity-change → effect re-fire loops)
  const selectedSourceRef = useRef(selectedSourceFilePath);
  selectedSourceRef.current = selectedSourceFilePath;

  const fieldLabelStyle: React.CSSProperties = {
    color: tokens.text.muted,
    fontSize: 12,
    lineHeight: '18px',
  };

  const isValidProjectName = PROJECT_NAME_RE.test(projectName);
  const canSubmit = isValidProjectName && !!selectedSourceFilePath && !loading;
  const canOpenOutput = !!availableOutputPath && !loading;

  // Persist user preferences to localStorage
  useEffect(() => { localStorage.setItem(LS_PROJECT_NAME, projectName); }, [projectName]);
  useEffect(() => { localStorage.setItem(LS_FORMAT, format); }, [format]);

  const SOURCE_EXTS = useMemo(
    () => new Set(['.md', '.markdown', '.txt', '.pdf', '.docx', '.doc', '.html', '.htm']),
    [],
  );

  const formatOptions = useMemo(
    () => CANVAS_FORMATS.map(({ key, dims }) => ({
      value: key,
      label: `${key} (${dims})`,
      desc: t(`extensions.ppt.formats.${key}`, key),
    })),
    [t],
  );

  const callRpc = useCallback(async <T,>(method: string, params: Record<string, unknown>) => {
    if (!client || !client.isConnected) {
      throw new Error(t('extensions.disconnected', 'Connect to gateway to view extensions'));
    }
    return client.request<T>(method, params);
  }, [client]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await callRpc<PptStatus>('rc.ppt.status', {});
      setStatus(res);
      setLastResult(res);
      if (!res.exists || !res.hasProjectManager || !res.hasSvgToPptx) {
        messageApi.warning(t('extensions.ppt.statusWarn', 'ppt-master integration path is incomplete'));
      } else {
        messageApi.success(t('extensions.ppt.statusOk', 'ppt-master integration is ready'));
      }
    } catch (err) {
      messageApi.error(err instanceof Error ? err.message : t('extensions.ppt.actionFailed', 'Action failed'));
    } finally {
      setLoading(false);
    }
  }, [callRpc, messageApi, t]);

  const doSubmit = useCallback(() => {
    const baseName = selectedSourceFilePath.split('/').pop() ?? selectedSourceFilePath;
    const dotIdx = baseName.lastIndexOf('.');
    const ext = dotIdx >= 0 ? baseName.slice(dotIdx).toLowerCase() : '';
    const fileName = selectedSourceFilePath.split('/').pop() ?? selectedSourceFilePath;
    const prompt = [
      '请使用 ppt-master 根据下面的源文件内容生成 PPTX。',
      `源文件路径：${selectedSourceFilePath}`,
      `源文件名：${fileName}`,
      ext ? `源文件类型：${ext}` : '',
      `项目名：${projectName}`,
      `画布格式：${format}`,
      '请使用推荐模板与风格（按推荐自动选择，跳过模板/风格询问）。',
      '请完成项目初始化、导入 sources、生成并导出最终 PPTX（导出到 workspace/outputs/ppt/ 按日期目录）。',
    ].filter(Boolean).join('\n');

    useChatStore.getState().send(prompt);
    messageApi.success(t('extensions.ppt.initOk', 'PPT generation task submitted'));
  }, [selectedSourceFilePath, projectName, format, messageApi, t]);

  const handleSubmit = useCallback(() => {
    modalApi.confirm({
      title: t('extensions.ppt.submitConfirmTitle', 'Confirm Submission'),
      content: t('extensions.ppt.submitConfirmContent', 'Research-Claw will start generating the PPT. Please do not submit repeatedly.'),
      okText: t('extensions.ppt.submitOk', 'OK'),
      cancelText: t('extensions.ppt.submitCancel', 'Cancel'),
      onOk: doSubmit,
    });
  }, [modalApi, t, doSubmit]);

  const handleExport = useCallback(async () => {
    setLoading(true);
    try {
      const res = await callRpc<{ outputPath?: string }>('rc.ppt.export', { projectPath, stage });
      setLastResult(res);
      if (typeof res.outputPath === 'string') {
        setAvailableOutputPath(res.outputPath);
      }
      messageApi.success(t('extensions.ppt.exportOk', 'Export completed'));
    } catch (err) {
      messageApi.error(err instanceof Error ? err.message : t('extensions.ppt.actionFailed', 'Action failed'));
    } finally {
      setLoading(false);
    }
  }, [callRpc, projectPath, stage, messageApi, t]);

  const handleRefreshSources = useCallback(async () => {
    setLoading(true);
    try {
      const res = await callRpc<PptOutputsList>('rc.ppt.outputs.list', {});
      const filtered = res.files.filter((f) => {
        const lower = f.toLowerCase();
        if (lower.endsWith('.pptx')) return false;
        return Array.from(SOURCE_EXTS).some((ext) => lower.endsWith(ext));
      });
      setSourceFiles(filtered);
      const cur = selectedSourceRef.current;
      if (!cur || !filtered.includes(cur)) {
        setSelectedSourceFilePath(filtered[0] ?? '');
      }

      // Also refresh available outputs in the same RPC result
      const pptxFiles = res.files.filter(
        (f) => f.toLowerCase().endsWith('.pptx') && f.includes('/outputs/ppt/'),
      );
      const prefix = `ppt-${projectName}-`;
      const matched = pptxFiles.find((f) => {
        const base = f.split('/').pop() ?? '';
        return base.startsWith(prefix);
      });
      setAvailableOutputPath(matched ?? pptxFiles[0] ?? '');
    } catch (err) {
      // messageApi/t accessed via closure — stable enough for error display
      messageApi.error(err instanceof Error ? err.message : t('extensions.ppt.actionFailed', 'Action failed'));
    } finally {
      setLoading(false);
    }
  }, [callRpc, SOURCE_EXTS, projectName]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleOpenOutput = useCallback(async () => {
    if (!availableOutputPath) return;
    setLoading(true);
    try {
      // Rename output to source-based name if a source file was selected
      let pathToOpen = availableOutputPath;
      if (selectedSourceFilePath) {
        const base = selectedSourceFilePath.split('/').pop() ?? selectedSourceFilePath;
        const dotIdx = base.lastIndexOf('.');
        const desiredBaseName = dotIdx >= 0 ? base.slice(0, dotIdx) : base;
        if (desiredBaseName) {
          try {
            const renameRes = await callRpc<{ ok: boolean; oldPath: string; newPath: string }>(
              'rc.ppt.outputs.rename',
              { inputPath: pathToOpen, desiredBaseName },
            );
            if (renameRes?.ok && renameRes.newPath) {
              pathToOpen = renameRes.newPath;
              setAvailableOutputPath(pathToOpen);
            }
          } catch {
            // Ignore rename failures; still try to open the file.
          }
        }
      }
      // Use workspace openExternal for consistent Docker/desktop handling
      const res = await callRpc<{
        ok: boolean;
        fallback?: string;
        containerPath?: string;
        relativePath?: string;
        fileName?: string;
      }>('rc.ws.openExternal', { path: pathToOpen });
      setLastResult(res);
      if (res?.fallback === 'docker') {
        setDockerModal({
          mode: 'file',
          containerPath: String(res.containerPath ?? ''),
          relativePath: String(res.relativePath ?? pathToOpen),
          fileName: String(res.fileName ?? pathToOpen.split('/').pop() ?? 'output.pptx'),
        });
      } else {
        messageApi.success(t('extensions.ppt.openOk', 'Opened output file'));
      }
    } catch (err) {
      messageApi.error(err instanceof Error ? err.message : t('extensions.ppt.openFailed', 'Failed to open output file'));
    } finally {
      setLoading(false);
    }
  }, [callRpc, availableOutputPath, selectedSourceFilePath, messageApi, t]);

  useEffect(() => {
    if (!client?.isConnected) return;
    handleRefreshSources();
  }, [client?.isConnected, handleRefreshSources]);

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Text style={{ color: tokens.text.secondary, fontSize: 12 }}>
        {t('extensions.ppt.hint', 'Select a source file and submit, Research-Claw will generate PPT automatically.')}
      </Text>

      <div style={{ display: 'flex', gap: 8 }}>
        <Button type="primary" onClick={handleStatus} loading={loading}>
          {t('extensions.ppt.checkStatus', 'Check Status')}
        </Button>
      </div>

      {status && (
        <div
          style={{
            border: `1px solid ${tokens.border.default}`,
            borderRadius: 8,
            padding: 10,
            background: tokens.bg.surfaceHover,
            fontSize: 12,
          }}
        >
          <div><Text strong>{t('extensions.ppt.root', 'Root')}:</Text> <Text code>{status.pptRoot}</Text></div>
          <div><Text strong>{t('extensions.ppt.exists', 'Exists')}:</Text> {status.exists ? 'yes' : 'no'}</div>
          <div><Text strong>project_manager.py:</Text> {status.hasProjectManager ? 'yes' : 'no'}</div>
          <div><Text strong>svg_to_pptx.py:</Text> {status.hasSvgToPptx ? 'yes' : 'no'}</div>
        </div>
      )}

      <div
        style={{
          border: `1px solid ${tokens.border.default}`,
          borderRadius: 8,
          padding: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <Text strong>{t('extensions.ppt.initTitle', 'Generate PPT')}</Text>
        <Text style={fieldLabelStyle}>{t('extensions.ppt.projectName', 'Project name')}</Text>
        <Input
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          placeholder={t('extensions.ppt.projectNamePlaceholder', 'Project name (letters, numbers, _, -, .)')}
          status={projectName && !isValidProjectName ? 'error' : undefined}
        />
        {projectName && !isValidProjectName && (
          <Text style={{ color: tokens.accent.red, fontSize: 11 }}>
            {t('extensions.ppt.projectNameInvalid', 'Only letters, numbers, underscore, dash, and dot are allowed')}
          </Text>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Text style={fieldLabelStyle}>{t('extensions.ppt.format', 'Canvas format')}</Text>
          <Tooltip
            title={t('extensions.ppt.formatTooltip', 'Canvas format determines the dimensions and aspect ratio of the generated content. Choose based on your use case.')}
            placement="right"
            overlayStyle={{ maxWidth: 280 }}
          >
            <QuestionCircleOutlined
              style={{ fontSize: 12, color: tokens.text.muted, cursor: 'help' }}
            />
          </Tooltip>
        </div>
        <Select
          value={format}
          onChange={(v) => setFormat(v)}
          optionLabelProp="label"
          style={{ width: '100%' }}
        >
          {formatOptions.map((opt) => (
            <Select.Option key={opt.value} value={opt.value} label={opt.label}>
              <div>
                <span style={{ fontWeight: 500 }}>{opt.value}</span>
                <span style={{ color: tokens.text.muted, marginLeft: 8, fontSize: 12 }}>
                  {opt.desc}
                </span>
              </div>
            </Select.Option>
          ))}
        </Select>
        <Text style={fieldLabelStyle}>
          {t('extensions.ppt.sourceFileSelect', 'Select source file from workspace outputs')}
        </Text>
        <Select
          value={selectedSourceFilePath || undefined}
          onChange={(v) => setSelectedSourceFilePath(v ?? '')}
          options={sourceFiles.map((file) => {
            const base = file.split('/').pop() ?? file;
            return { value: file, label: base };
          })}
          placeholder={t(
            'extensions.ppt.sourceFileSelect',
            'Select source file from workspace outputs',
          )}
          style={{ width: '100%' }}
          showSearch
          optionFilterProp="label"
          allowClear
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button onClick={handleRefreshSources} loading={loading}>
            {t('extensions.ppt.refreshSourcesBtn', 'Refresh sources')}
          </Button>
          <Tooltip title={!canSubmit && !loading ? (
            !isValidProjectName
              ? t('extensions.ppt.projectNameInvalid', 'Only letters, numbers, underscore, dash, and dot are allowed')
              : t('extensions.ppt.sourceFileSelect', 'Select source file from workspace outputs')
          ) : undefined}>
            <Button
              type="primary"
              onClick={handleSubmit}
              disabled={!canSubmit}
              loading={loading}
              style={{ flex: 1 }}
            >
              {t('extensions.ppt.submitBtn', 'Submit Task')}
            </Button>
          </Tooltip>
        </div>
      </div>

      <div
        style={{
          border: `1px solid ${tokens.border.default}`,
          borderRadius: 8,
          padding: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <Text strong>{t('extensions.ppt.exportTitle', 'Output')}</Text>
        <Text style={fieldLabelStyle}>
          {t(
            'extensions.ppt.outputHint',
            'After generation, open the matching PPTX under workspace/outputs/ppt/.',
          )}
        </Text>
        <Tooltip title={!canOpenOutput ? t('extensions.ppt.noOutput', 'No output file available') : undefined}>
          <Button onClick={handleOpenOutput} disabled={!canOpenOutput} loading={loading}>
            {t('extensions.ppt.openBtn', 'Open Output')}
          </Button>
        </Tooltip>
      </div>

      {Boolean(lastResult) && (
        <div>
          <Text strong>{t('extensions.ppt.lastResult', 'Last Result')}</Text>
          <pre
            style={{
              marginTop: 6,
              padding: 8,
              borderRadius: 6,
              background: 'var(--code-bg, rgba(0,0,0,0.2))',
              border: `1px solid ${tokens.border.default}`,
              fontSize: 11,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: tokens.text.secondary,
              maxHeight: 220,
              overflow: 'auto',
            }}
          >
{JSON.stringify(lastResult, null, 2)}
          </pre>
        </div>
      )}

      {dockerModal && (
        <DockerFileModal
          open
          onClose={() => setDockerModal(null)}
          {...dockerModal}
        />
      )}
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
  // Track which tabs have been visited — render once, then keep in DOM with display:none
  const [visited, setVisited] = useState<Set<SubTab>>(() => new Set(['skills']));

  const handleTabChange = useCallback((tab: SubTab) => {
    setActiveTab(tab);
    setVisited((prev) => {
      if (prev.has(tab)) return prev;
      const next = new Set(prev);
      next.add(tab);
      return next;
    });
  }, []);

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

  const totalCount = useMemo(() => skills.length + channels.length, [skills, channels]);
  const activeCount = useMemo(
    () =>
      skills.filter((s) => !s.disabled && s.eligible).length +
      channels.filter((c) => {
        const account = c.accounts.find((a) => a.accountId === c.defaultAccountId) ?? c.accounts[0];
        return account?.connected === true;
      }).length,
    [skills, channels],
  );

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
          onChange={(val) => handleTabChange(val as SubTab)}
          options={[
            { label: t('extensions.tabs.skills', 'Skills'), value: 'skills' },
            { label: t('extensions.tabs.channels', 'Channels'), value: 'channels' },
            { label: t('extensions.tabs.plugins', 'Plugins'), value: 'plugins' },
            { label: t('extensions.tabs.ppt', 'PPT'), value: 'ppt' },
          ]}
          size="small"
        />
      </div>

      {/* Content — Skills uses virtual list (internal scroll), Channels/Plugins use native scroll */}
      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
        {visited.has('skills') && (
          <div style={{ display: activeTab === 'skills' ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
            <SkillsTab tokens={tokens} />
          </div>
        )}
        {visited.has('channels') && (
          <div style={{ display: activeTab === 'channels' ? 'block' : 'none', height: '100%', overflow: 'auto' }}>
            <ChannelsTab tokens={tokens} />
          </div>
        )}
        {visited.has('plugins') && (
          <div style={{ display: activeTab === 'plugins' ? 'block' : 'none', height: '100%', overflow: 'auto' }}>
            <PluginsTab tokens={tokens} />
          </div>
        )}
        {visited.has('ppt') && (
          <div style={{ display: activeTab === 'ppt' ? 'block' : 'none', height: '100%', overflow: 'auto' }}>
            <PptTab tokens={tokens} />
          </div>
        )}
      </div>
    </div>
  );
}
