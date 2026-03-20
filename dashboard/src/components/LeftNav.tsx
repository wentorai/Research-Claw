import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Dropdown, Input, Tooltip, Typography } from 'antd';
import {
  ApiOutlined,
  BookOutlined,
  FolderOutlined,
  CheckSquareOutlined,
  EyeOutlined,
  SettingOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  AppstoreOutlined,
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useUiStore, type PanelTab } from '../stores/ui';
import { useSessionsStore, MAIN_SESSION_KEY } from '../stores/sessions';

const { Text } = Typography;

interface NavItem {
  key: PanelTab;
  icon: React.ReactNode;
  labelKey: string;
}

const NAV_ITEMS: NavItem[] = [
  { key: 'library', icon: <BookOutlined />, labelKey: 'nav.library' },
  { key: 'workspace', icon: <FolderOutlined />, labelKey: 'nav.workspace' },
  { key: 'tasks', icon: <CheckSquareOutlined />, labelKey: 'nav.tasks' },
  { key: 'monitor', icon: <EyeOutlined />, labelKey: 'nav.monitor' },
  { key: 'extensions', icon: <ApiOutlined />, labelKey: 'nav.extensions' },
  { key: 'settings', icon: <SettingOutlined />, labelKey: 'nav.settings' },
];

/** Get display name for a session. Prefers label > derivedTitle > short key. */
function getSessionName(session: { key: string; label?: string; derivedTitle?: string; displayName?: string }, t: (k: string) => string): string {
  if (session.label) return session.label;
  if (session.derivedTitle) return session.derivedTitle;
  if (session.displayName) return session.displayName;
  const { key } = session;
  // For the main session, show a friendly name
  if (key === 'main' || key === 'agent:main:main') return t('project.mainSession');
  // Strip "agent:main:" prefix for readability
  const display = key.replace(/^agent:main:/, '');
  return display.length > 20 ? `${display.slice(0, 20)}…` : display;
}

export default function LeftNav() {
  const { t } = useTranslation();
  const collapsed = useUiStore((s) => s.leftNavCollapsed);
  const toggleLeftNav = useUiStore((s) => s.toggleLeftNav);
  const rightPanelTab = useUiStore((s) => s.rightPanelTab);
  const setRightPanelTab = useUiStore((s) => s.setRightPanelTab);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);

  const sessions = useSessionsStore((s) => s.sessions);
  const activeSessionKey = useSessionsStore((s) => s.activeSessionKey);
  const loadSessions = useSessionsStore((s) => s.loadSessions);
  const switchSession = useSessionsStore((s) => s.switchSession);
  const createSession = useSessionsStore((s) => s.createSession);
  const deleteSession = useSessionsStore((s) => s.deleteSession);
  const renameSession = useSessionsStore((s) => s.renameSession);
  const isMainSession = useSessionsStore((s) => s.isMainSession);

  useEffect(() => {
    loadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleNavClick = (tab: PanelTab) => {
    if (rightPanelTab === tab && rightPanelOpen) {
      toggleRightPanel();
    } else {
      setRightPanelTab(tab);
    }
  };

  const handleRename = (key: string, currentLabel: string) => {
    const newLabel = prompt(t('project.renamePrompt'), currentLabel);
    if (newLabel !== null && newLabel !== currentLabel) {
      renameSession(key, newLabel);
    }
  };

  const handleDelete = (key: string) => {
    if (isMainSession(key)) return;
    if (confirm(t('project.deleteConfirm'))) {
      deleteSession(key);
    }
  };

  // ── Project switcher dropdown content ──────────────────────────────────────

  const [sessionSearch, setSessionSearch] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);

  // Reset search when dropdown closes
  const handleDropdownOpenChange = useCallback((open: boolean) => {
    setDropdownOpen(open);
    if (!open) setSessionSearch('');
  }, []);

  const filteredSessions = useMemo(() => {
    const list = sessions.slice(0, 30);
    if (!sessionSearch.trim()) return list;
    const q = sessionSearch.toLowerCase();
    return list.filter((s) => {
      const name = getSessionName(s, t).toLowerCase();
      return name.includes(q);
    });
  }, [sessions, sessionSearch, t]);

  const projectDropdownRender = useCallback(() => (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        boxShadow: '0 6px 16px rgba(0,0,0,0.3)',
        minWidth: 220,
        display: 'flex',
        flexDirection: 'column',
        maxHeight: '66vh',
      }}
    >
      {/* Search */}
      <div style={{ padding: '8px 8px 4px' }}>
        <Input
          size="small"
          placeholder={t('project.searchSessions', 'Search sessions...')}
          prefix={<SearchOutlined style={{ color: 'var(--text-tertiary)' }} />}
          value={sessionSearch}
          onChange={(e) => setSessionSearch(e.target.value)}
          allowClear
          autoFocus
          onKeyDown={(e) => e.stopPropagation()}
        />
      </div>

      {/* Scrollable session list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {filteredSessions.map((session) => {
          const isActive = session.key === activeSessionKey;
          const isMain = isMainSession(session.key);
          const name = getSessionName(session, t);

          return (
            <div
              key={session.key}
              onClick={() => { switchSession(session.key); setDropdownOpen(false); }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 12px',
                cursor: 'pointer',
                background: isActive ? 'var(--surface-active)' : 'transparent',
                transition: 'background 0.1s',
              }}
              onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'var(--surface-hover)'; }}
              onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <div
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  flexShrink: 0,
                  background: isActive ? 'var(--accent-primary)' : 'var(--text-tertiary)',
                }}
              />
              <span style={{
                flex: 1,
                fontWeight: isActive ? 600 : 400,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: 13,
                color: 'var(--text-primary)',
              }}>
                {name}
              </span>
              <EditOutlined
                style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0 }}
                onClick={(e) => { e.stopPropagation(); handleRename(session.key, name); }}
              />
              {!isMain && (
                <DeleteOutlined
                  style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0 }}
                  onClick={(e) => { e.stopPropagation(); handleDelete(session.key); }}
                />
              )}
            </div>
          );
        })}
        {filteredSessions.length === 0 && (
          <div style={{ padding: '8px 12px', color: 'var(--text-tertiary)', fontSize: 12, textAlign: 'center' }}>
            {t('project.noResults', 'No matching sessions')}
          </div>
        )}
      </div>

      {/* Fixed footer: New Project */}
      <div style={{ borderTop: '1px solid var(--border)', padding: '4px 0' }}>
        <div
          onClick={async () => { await createSession(); setDropdownOpen(false); }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            cursor: 'pointer',
            color: 'var(--text-secondary)',
            fontSize: 13,
            transition: 'background 0.1s',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--surface-hover)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
        >
          <PlusOutlined style={{ fontSize: 12 }} />
          <span>{t('project.newProject')}</span>
        </div>
      </div>
    </div>
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [filteredSessions, activeSessionKey, sessionSearch, t]);

  const activeSessionLabel = useMemo(() => {
    const session = sessions.find((s) => s.key === activeSessionKey);
    if (session) return getSessionName(session, t);
    // Active key not in list yet (e.g. just created, not yet on server)
    if (isMainSession(activeSessionKey)) return t('project.mainSession');
    const display = activeSessionKey.replace(/^agent:main:/, '');
    return display.length > 20 ? `${display.slice(0, 20)}…` : display;
  }, [activeSessionKey, sessions, t, isMainSession]);

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--surface)',
        overflow: 'hidden',
      }}
    >
      {/* Project switcher */}
      <div
        style={{
          padding: collapsed ? '12px 8px' : '12px 16px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        {collapsed ? (
          <Tooltip title={t('project.switchProject')} placement="right">
            <Dropdown open={dropdownOpen} onOpenChange={handleDropdownOpenChange} dropdownRender={projectDropdownRender} trigger={['click']} placement="bottomLeft">
              <Button
                type="text"
                icon={<AppstoreOutlined />}
                style={{ width: '100%', color: 'var(--text-secondary)' }}
              />
            </Dropdown>
          </Tooltip>
        ) : (
          <Dropdown open={dropdownOpen} onOpenChange={handleDropdownOpenChange} dropdownRender={projectDropdownRender} trigger={['click']} placement="bottomLeft">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
                padding: '4px 0',
              }}
            >
              <AppstoreOutlined style={{ color: 'var(--accent-secondary)', fontSize: 16 }} />
              <Text
                ellipsis
                style={{
                  flex: 1,
                  fontSize: 13,
                  fontWeight: 500,
                }}
              >
                {activeSessionLabel}
              </Text>
            </div>
          </Dropdown>
        )}
      </div>

      {/* Function rail */}
      <div style={{ flex: 1, padding: '8px 0', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {NAV_ITEMS.map((item) => {
          const isActive = rightPanelTab === item.key && rightPanelOpen;
          const btnStyle: React.CSSProperties = {
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: collapsed ? 'center' : 'flex-start',
            padding: collapsed ? '8px 0' : '8px 16px',
            height: 40,
            borderRadius: 0,
            color: isActive ? 'var(--accent-primary)' : 'var(--text-secondary)',
            background: isActive ? 'var(--surface-active)' : 'transparent',
            borderLeft: isActive ? '2px solid var(--accent-primary)' : '2px solid transparent',
            transition: 'all 0.15s ease',
          };

          const button = (
            <Button
              key={item.key}
              type="text"
              icon={item.icon}
              onClick={() => handleNavClick(item.key)}
              style={btnStyle}
            >
              {!collapsed && (
                <span style={{ marginLeft: 8, fontSize: 13 }}>{t(item.labelKey)}</span>
              )}
            </Button>
          );

          return collapsed ? (
            <Tooltip key={item.key} title={t(item.labelKey)} placement="right">
              {button}
            </Tooltip>
          ) : (
            button
          );
        })}
      </div>

      {/* Collapse toggle */}
      <div
        style={{
          padding: '8px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          justifyContent: collapsed ? 'center' : 'flex-end',
        }}
      >
        <Tooltip title={collapsed ? t('nav.expand') : t('nav.collapse')} placement="right">
          <Button
            type="text"
            size="small"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={toggleLeftNav}
            aria-label={collapsed ? t('a11y.expandNav') : t('a11y.collapseNav')}
            style={{ color: 'var(--text-tertiary)' }}
          />
        </Tooltip>
      </div>
    </div>
  );
}
