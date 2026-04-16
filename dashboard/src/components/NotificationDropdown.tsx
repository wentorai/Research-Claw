import type { MouseEvent, ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { App, Badge, Button, Dropdown, Empty, Typography } from 'antd';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  BellOutlined,
  ClockCircleOutlined,
  AlertOutlined,
  WarningOutlined,
  InfoCircleOutlined,
  CheckOutlined,
  CloudDownloadOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useUiStore } from '../stores/ui';
import { useGatewayStore } from '../stores/gateway';
import { useSessionsStore } from '../stores/sessions';
import { normalizeSessionKey } from '../utils/session-key';
import { useConfigStore } from '../stores/config';
import { getThemeTokens } from '../styles/theme';
import { relativeTime } from '../utils/relativeTime';
import type { Notification as AppNotification } from '../stores/ui';
import { confirmApplyAppUpdate } from '../utils/app-update-ui';

const { Text } = Typography;

const MAX_VISIBLE = 50;

function getNotificationIcon(type: AppNotification['type'], tokens: ReturnType<typeof getThemeTokens>): ReactNode {
  switch (type) {
    case 'deadline':
      return <ClockCircleOutlined style={{ color: tokens.accent.red }} />;
    case 'heartbeat':
      return <AlertOutlined style={{ color: tokens.accent.amber }} />;
    case 'system':
      return <InfoCircleOutlined style={{ color: tokens.accent.blue }} />;
    case 'error':
      return <WarningOutlined style={{ color: tokens.accent.red }} />;
    case 'update':
      return <CloudDownloadOutlined style={{ color: tokens.accent.blue }} />;
    default:
      return <InfoCircleOutlined style={{ color: tokens.accent.blue }} />;
  }
}

function UpdateNotificationActions({
  meta,
}: {
  meta: NonNullable<AppNotification['updateMeta']>;
}) {
  const { t } = useTranslation();
  const { modal, message } = App.useApp();
  const configTheme = useConfigStore((s) => s.theme);

  const copyHint = async (e: MouseEvent) => {
    e.stopPropagation();
    const hint = meta.shellHint;
    if (!hint) return;
    try {
      await navigator.clipboard.writeText(hint);
      message.success(t('settings.updateCommandsCopied'));
    } catch {
      message.error(t('settings.copyFailed'));
    }
  };

  const applyUpdate = (e: MouseEvent) => {
    e.stopPropagation();
    confirmApplyAppUpdate({ modal, message, theme: configTheme, t });
  };

  return (
    <div
      role="group"
      aria-label={t('notification.updateTitle', { latest: meta.latest })}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}
    >
      <Button size="small" onClick={(e) => void copyHint(e)} disabled={!meta.shellHint}>
        {t('notification.updateCopyCommand')}
      </Button>
      <Button size="small" type="primary" onClick={applyUpdate}>
        {t('notification.updateApplyShort')}
      </Button>
    </div>
  );
}

function NotificationItem({
  item,
  tokens,
  locale,
  onMarkRead,
}: {
  item: AppNotification;
  tokens: ReturnType<typeof getThemeTokens>;
  locale: string;
  onMarkRead: (id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      role="button"
      tabIndex={0}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => {
        if (!item.read) onMarkRead(item.id);
        // Layer 2 (#33): navigate to target session when notification has targetSessionKey
        if (item.targetSessionKey) {
          // Auto-expand cron fold group if navigating to a cron session
          const bare = normalizeSessionKey(item.targetSessionKey);
          if (bare.toLowerCase().startsWith('cron:')) {
            useUiStore.getState().setCronSessionsFolded(false);
          }
          useSessionsStore.getState().switchSession(item.targetSessionKey);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (!item.read) onMarkRead(item.id);
          if (item.targetSessionKey) {
            const bare = normalizeSessionKey(item.targetSessionKey);
            if (bare.toLowerCase().startsWith('cron:')) {
              useUiStore.getState().setCronSessionsFolded(false);
            }
            useSessionsStore.getState().switchSession(item.targetSessionKey);
          }
        }
      }}
      style={{
        padding: '10px 14px',
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        background: item.read ? 'transparent' : tokens.bg.surfaceHover,
        cursor: item.read ? 'default' : 'pointer',
        borderBottom: `1px solid ${tokens.border.default}`,
        transition: 'background 0.15s ease',
      }}
    >
      {/* Type icon */}
      <span style={{ flexShrink: 0, marginTop: 2, fontSize: 14 }}>
        {getNotificationIcon(item.type, tokens)}
      </span>

      {/* Content — expand on hover */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Use CSS text-overflow instead of antd Typography ellipsis to avoid
            internal DOM manipulation that causes insertBefore errors on hover toggle */}
        <div
          style={{
            fontSize: 13,
            fontWeight: item.read ? 400 : 600,
            color: tokens.text.primary,
            lineHeight: '18px',
            ...(hovered
              ? { whiteSpace: 'normal', wordBreak: 'break-word' }
              : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
          }}
        >
          {item.title}
        </div>
        {item.body && (
          <div
            style={{
              fontSize: 12,
              color: tokens.text.secondary,
              marginTop: 2,
              lineHeight: '16px',
              ...(hovered
                ? { wordBreak: 'break-word' }
                : { overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const }),
            }}
            className={hovered ? 'notification-markdown-body' : undefined}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                p: ({ children }) => <span style={{ display: 'block', margin: 0 }}>{children}</span>,
                ul: ({ children }) => <ul style={{ margin: '2px 0', paddingLeft: 16 }}>{children}</ul>,
                ol: ({ children }) => <ol style={{ margin: '2px 0', paddingLeft: 16 }}>{children}</ol>,
                li: ({ children }) => <li style={{ margin: 0 }}>{children}</li>,
                code: ({ children }) => (
                  <code style={{ background: 'var(--surface-active, rgba(255,255,255,0.08))', padding: '1px 3px', borderRadius: 2, fontSize: '0.9em' }}>
                    {children}
                  </code>
                ),
                pre: ({ children }) => <>{children}</>,
                h1: ({ children }) => <strong>{children}</strong>,
                h2: ({ children }) => <strong>{children}</strong>,
                h3: ({ children }) => <strong>{children}</strong>,
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-secondary, #3B82F6)' }}>
                    {children}
                  </a>
                ),
              }}
            >
              {item.body}
            </ReactMarkdown>
          </div>
        )}
        {item.type === 'update' && item.updateMeta && (
          <UpdateNotificationActions meta={item.updateMeta} />
        )}
        <Text
          style={{
            fontSize: 11,
            color: tokens.text.muted,
            display: 'block',
            marginTop: 3,
          }}
        >
          {relativeTime(item.timestamp, locale)}
        </Text>
      </div>

      {/* Unread indicator dot */}
      {!item.read && (
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: tokens.accent.blue,
            flexShrink: 0,
            marginTop: 6,
          }}
        />
      )}
    </div>
  );
}

export default function NotificationDropdown() {
  const { t } = useTranslation();
  const theme = useConfigStore((s) => s.theme);
  const locale = useConfigStore((s) => s.locale);
  const tokens = useMemo(() => getThemeTokens(theme), [theme]);
  const notifications = useUiStore((s) => s.notifications);
  const unreadCount = useUiStore((s) => s.unreadCount);
  const markRead = useUiStore((s) => s.markNotificationRead);
  const markAllRead = useUiStore((s) => s.markAllNotificationsRead);

  const visibleNotifications = useMemo(
    () => notifications.slice(0, MAX_VISIBLE),
    [notifications],
  );

  const emptyContent = (
    <div
      style={{
        padding: '24px 16px',
        textAlign: 'center',
        minWidth: 280,
      }}
    >
      <Empty
        image={
          <BellOutlined
            style={{
              fontSize: 32,
              color: tokens.text.muted,
            }}
          />
        }
        imageStyle={{ height: 40 }}
        description={
          <Text style={{ color: tokens.text.muted, fontSize: 13 }}>
            {t('notification.noNotifications')}
          </Text>
        }
      />
    </div>
  );

  const dropdownContent = (
    <div
      role="log"
      aria-label={t('a11y.notifications')}
      style={{
        minWidth: 320,
        maxWidth: 380,
        background: tokens.bg.secondary,
        border: `1px solid ${tokens.border.default}`,
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '10px 14px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderBottom: `1px solid ${tokens.border.default}`,
        }}
      >
        <Text strong style={{ color: tokens.text.primary, fontSize: 14 }}>
          {t('topbar.notifications')}
        </Text>
        {unreadCount > 0 && (
          <Button
            type="link"
            size="small"
            icon={<CheckOutlined />}
            onClick={(e) => {
              e.stopPropagation();
              markAllRead();
            }}
            style={{ color: tokens.accent.blue, fontSize: 12, padding: '0 4px' }}
          >
            {t('notification.markAllRead')}
          </Button>
        )}
      </div>

      {/* List */}
      {visibleNotifications.length === 0 ? (
        emptyContent
      ) : (
        <div style={{ maxHeight: 400, overflowY: 'auto' }}>
          {visibleNotifications.map((item) => (
            <NotificationItem
              key={item.id}
              item={item}
              tokens={tokens}
              locale={locale}
              onMarkRead={markRead}
            />
          ))}
        </div>
      )}
    </div>
  );

  return (
    <Dropdown
      dropdownRender={() => dropdownContent}
      trigger={['click']}
      placement="bottomRight"
    >
      <Badge count={unreadCount} size="small" offset={[-2, 2]} overflowCount={99}>
        <Button
          type="text"
          icon={<BellOutlined />}
          title={t('topbar.notifications')}
          aria-label={t('a11y.notifications')}
          style={{ color: tokens.text.secondary }}
        />
      </Badge>
    </Dropdown>
  );
}
