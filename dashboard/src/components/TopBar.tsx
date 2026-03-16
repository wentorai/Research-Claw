import { useTranslation } from 'react-i18next';
import { useConfigStore } from '../stores/config';
import { useUiStore } from '../stores/ui';
import NotificationDropdown from './NotificationDropdown';
import type { AgentStatus } from '../stores/ui';

const STATUS_COLORS: Record<AgentStatus, string> = {
  idle: '#22C55E',
  thinking: '#F59E0B',
  tool_running: '#F59E0B',
  streaming: '#3B82F6',
  error: '#EF4444',
  disconnected: '#6B7280',
};

const PULSE_STATES = new Set<AgentStatus>(['thinking', 'tool_running', 'streaming']);

function AgentStatusDot({ status }: { status: AgentStatus }) {
  const { t } = useTranslation();
  const color = STATUS_COLORS[status];
  const pulse = PULSE_STATES.has(status);

  return (
    <div
      title={t(`agent.${status === 'tool_running' ? 'toolRunning' : status}`)}
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        backgroundColor: color,
        animation: pulse ? 'pulse 1.5s ease-in-out infinite' : undefined,
        flexShrink: 0,
      }}
    />
  );
}

function SunIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

export default function TopBar() {
  const { t } = useTranslation();
  const theme = useConfigStore((s) => s.theme);
  const setTheme = useConfigStore((s) => s.setTheme);
  const locale = useConfigStore((s) => s.locale);
  const setLocale = useConfigStore((s) => s.setLocale);
  const agentStatus = useUiStore((s) => s.agentStatus);

  const isDark = theme === 'dark';

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(var(--glass-blur))',
        WebkitBackdropFilter: 'blur(var(--glass-blur))',
        borderBottom: '1px solid var(--border)',
      }}
    >
      {/* Logo */}
      <a
        href="https://wentor.ai/"
        target="_blank"
        rel="noopener noreferrer"
        style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}
      >
        <span style={{ fontSize: 18, lineHeight: 1 }}>{'\u{1F99E}'}</span>
        <span
          style={{
            fontSize: 14,
            fontWeight: 700,
            fontFamily: "'Fira Code', 'JetBrains Mono', Consolas, monospace",
            color: 'var(--accent-primary)',
            letterSpacing: -0.3,
          }}
        >
          {t('app.name')}
        </span>
      </a>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Right actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <NotificationDropdown />

        <AgentStatusDot status={agentStatus} />

        {/* Language toggle: EN | 中 */}
        <div
          onClick={() => setLocale(locale === 'en' ? 'zh-CN' : 'en')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setLocale(locale === 'en' ? 'zh-CN' : 'en'); }}
          aria-label={locale === 'en' ? 'Switch to Chinese' : '切换为英文'}
          style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 13, cursor: 'pointer', userSelect: 'none' }}
        >
          <span
            style={{
              padding: '2px 6px',
              borderRadius: 4,
              color: locale === 'en' ? 'var(--text-primary)' : 'var(--text-tertiary)',
              fontWeight: locale === 'en' ? 600 : 400,
              transition: 'color 0.2s',
            }}
          >
            EN
          </span>
          <span style={{ color: 'var(--text-tertiary)' }}>|</span>
          <span
            style={{
              padding: '2px 6px',
              borderRadius: 4,
              color: locale === 'zh-CN' ? 'var(--text-primary)' : 'var(--text-tertiary)',
              fontWeight: locale === 'zh-CN' ? 600 : 400,
              transition: 'color 0.2s',
            }}
          >
            中
          </span>
        </div>

        {/* Theme toggle: Sun / Moon */}
        <button
          onClick={() => setTheme(isDark ? 'light' : 'dark')}
          title={t('topbar.themeToggle')}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 32,
            height: 32,
            padding: 4,
            borderRadius: 6,
            border: 'none',
            background: 'transparent',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            transition: 'background 0.2s, color 0.2s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--surface-hover)';
            e.currentTarget.style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--text-secondary)';
          }}
        >
          {isDark ? <SunIcon /> : <MoonIcon />}
        </button>
      </div>
    </div>
  );
}
