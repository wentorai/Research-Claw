import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { Badge, Button, Dropdown, Empty, Typography } from 'antd';
import {
  BellOutlined,
  ClockCircleOutlined,
  AlertOutlined,
  WarningOutlined,
  InfoCircleOutlined,
  CheckOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useUiStore } from '../stores/ui';
import { useSessionsStore } from '../stores/sessions';
import { normalizeSessionKey } from '../utils/session-key';
import { useConfigStore } from '../stores/config';
import { getThemeTokens } from '../styles/theme';
import type { Notification as AppNotification } from '../stores/ui';

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
  }
}

function relativeTimestamp(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function NotificationItem({
  item,
  tokens,
  onMarkRead,
}: {
  item: AppNotification;
  tokens: ReturnType<typeof getThemeTokens>;
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
        <Text
          style={{
            fontSize: 13,
            fontWeight: item.read ? 400 : 600,
            color: tokens.text.primary,
            display: 'block',
            lineHeight: '18px',
            whiteSpace: hovered ? 'normal' : undefined,
            wordBreak: hovered ? 'break-word' : undefined,
          }}
          ellipsis={!hovered}
        >
          {item.title}
        </Text>
        {item.body && (
          <Text
            style={{
              fontSize: 12,
              color: tokens.text.secondary,
              display: 'block',
              marginTop: 2,
              lineHeight: '16px',
              whiteSpace: hovered ? 'normal' : undefined,
              wordBreak: hovered ? 'break-word' : undefined,
            }}
            ellipsis={!hovered}
          >
            {item.body}
          </Text>
        )}
        <Text
          style={{
            fontSize: 11,
            color: tokens.text.muted,
            display: 'block',
            marginTop: 3,
          }}
        >
          {relativeTimestamp(item.timestamp)}
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
