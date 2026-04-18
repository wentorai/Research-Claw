/**
 * SupervisorPanel — Audit log & stats for dual-model supervision
 *
 * Layout:
 *   - Stats overview (4 cards)
 *   - Filter bar (type / action / search)
 *   - Grouped audit log list (collapsible by type)
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Input, Select, Tag, Typography } from 'antd';
import {
  ReloadOutlined,
  SafetyCertificateOutlined,
  FileTextOutlined,
  ToolOutlined,
  CheckCircleOutlined,
  LockOutlined,
  CompassOutlined,
  SyncOutlined,
  LineChartOutlined,
  UpOutlined,
  DownOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useGatewayStore } from '../../stores/gateway';
import { useSupervisorStore, type AuditLogEntry } from '../../stores/supervisor';
import { getThemeTokens } from '../../styles/theme';
import { useConfigStore } from '../../stores/config';
import { useUiStore } from '../../stores/ui';

const { Text } = Typography;

// ── Type / Action metadata ────────────────────────────────────────────────

const LOG_TYPE_META: Record<string, { icon: React.ReactNode; color: string; labelKey: string }> = {
  output_review:      { icon: <FileTextOutlined />,     color: '#3B82F6', labelKey: 'supervisor.typeOutputReview' },
  tool_review:        { icon: <ToolOutlined />,          color: '#8B5CF6', labelKey: 'supervisor.typeToolReview' },
  consistency_check:  { icon: <CheckCircleOutlined />,   color: '#06B6D4', labelKey: 'supervisor.typeConsistencyCheck' },
  memory_guard:       { icon: <LockOutlined />,          color: '#F59E0B', labelKey: 'supervisor.typeMemoryGuard' },
  course_correction:  { icon: <CompassOutlined />,       color: '#10B981', labelKey: 'supervisor.typeCourseCorrection' },
  force_regenerate:   { icon: <SyncOutlined />,          color: '#EF4444', labelKey: 'supervisor.typeForceRegenerate' },
  session_analysis:   { icon: <LineChartOutlined />,     color: '#71717A', labelKey: 'supervisor.typeSessionAnalysis' },
};

const ACTION_COLORS: Record<string, string> = {
  pass: '#10B981',
  block: '#EF4444',
  correct: '#3B82F6',
  warn: '#F59E0B',
  info: '#71717A',
};

const TYPE_SELECT_OPTIONS = Object.entries(LOG_TYPE_META).map(([key, meta]) => ({
  value: key,
  labelKey: meta.labelKey,
}));

const ACTION_SELECT_OPTIONS = ['pass', 'block', 'correct', 'warn', 'info'].map((key) => ({
  value: key,
  labelKey: `supervisor.action${key.charAt(0).toUpperCase() + key.slice(1)}` as const,
}));

// ── Helper: ms timestamp → ISO string ─────────────────────────────────────

function relativeTimeFromMs(ms: number, locale: string): string {
  const date = new Date(ms);
  const now = Date.now();
  const diffMs = now - date.getTime();
  if (diffMs < 0) return date.toLocaleString();

  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (locale.startsWith('zh')) {
    if (diffSec < 60) return '刚刚';
    if (diffMin < 60) return `${diffMin} 分钟前`;
    if (diffHour < 24) return `${diffHour} 小时前`;
    if (diffDay < 7) return `${diffDay} 天前`;
  } else {
    if (diffSec < 60) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHour < 24) return `${diffHour}h ago`;
    if (diffDay < 7) return `${diffDay}d ago`;
  }
  return date.toLocaleString();
}

// ── Stats Card ────────────────────────────────────────────────────────────

function StatsCard({ value, label, color }: { value: number; label: string; color: string }) {
  const tokens = getThemeTokens(useConfigStore.getState().theme);
  return (
    <div style={{
      flex: '1 1 45%',
      padding: '8px 10px',
      background: tokens.bg.surfaceHover,
      borderRadius: 6,
      borderLeft: `3px solid ${color}`,
      minWidth: 0,
    }}>
      <div style={{ fontSize: 18, fontWeight: 700, color, fontFamily: "'Fira Code', monospace", lineHeight: 1.2 }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: tokens.text.muted, marginTop: 2 }}>{label}</div>
    </div>
  );
}

// ── Log Entry Card ────────────────────────────────────────────────────────

function LogEntryCard({ entry, tokens, locale, t }: { entry: AuditLogEntry; tokens: ReturnType<typeof getThemeTokens>; locale: string; t: TFunction }) {
  const [expanded, setExpanded] = useState(false);
  const actionColor = ACTION_COLORS[entry.action] ?? '#71717A';
  const timeStr = relativeTimeFromMs(entry.timestamp, locale);

  // Fallback title when details is empty: use type label + action label
  const typeMeta = LOG_TYPE_META[entry.type];
  const typeLabel = t(typeMeta?.labelKey ?? 'supervisor.typeUnknown', entry.type || 'Unknown');
  const actionKey = `supervisor.action${entry.action.charAt(0).toUpperCase() + entry.action.slice(1)}` as const;
  const actionLabel = t(actionKey, entry.action);
  const displayText = entry.details || `${typeLabel} — ${actionLabel}`;

  return (
    <div style={{ padding: '4px 0' }}>
      <div
        onClick={() => setExpanded(!expanded)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(!expanded); } }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 6px',
          cursor: 'pointer',
          borderRadius: 4,
          transition: 'background 0.1s',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = tokens.bg.surfaceHover; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
      >
        {/* Time */}
        <Text style={{ fontSize: 10, color: tokens.text.muted, fontFamily: "'Fira Code', monospace", flexShrink: 0, width: 52 }}>
          {timeStr}
        </Text>
        {/* Action tag */}
        <Tag style={{
          fontSize: 10,
          lineHeight: '16px',
          padding: '0 4px',
          border: 'none',
          background: `${actionColor}22`,
          color: actionColor,
          flexShrink: 0,
          fontWeight: 600,
        }}>
          {entry.action.toUpperCase()}
        </Tag>
        {/* Details */}
        <Text ellipsis style={{ fontSize: 11, color: entry.details ? tokens.text.secondary : tokens.text.muted, flex: 1, minWidth: 0, fontStyle: entry.details ? undefined : 'italic' }}>
          {displayText}
        </Text>
        {/* Expand arrow */}
        <span style={{ color: tokens.text.muted, fontSize: 9, flexShrink: 0 }}>
          {expanded ? <UpOutlined /> : <DownOutlined />}
        </span>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div style={{
          padding: '12px 12px 12px 20px',
          background: tokens.bg.surfaceHover,
          borderRadius: '0 0 6px 6px',
          marginTop: -2,
          borderLeft: `2px solid ${tokens.border.default}`,
        }}>
          {/* Full details */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 10, color: tokens.text.muted, marginBottom: 4 }}>
              {t('supervisor.details', 'Details')}
            </div>
            <Text style={{ fontSize: 13, color: tokens.text.primary, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
              {displayText}
            </Text>
          </div>
          {/* Session ID */}
          {entry.sessionId && (
            <div style={{ marginBottom: 10, display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <Text style={{ fontSize: 11, color: tokens.text.muted, whiteSpace: 'nowrap' }}>
                {t('supervisor.sessionId', 'Session ID')}:
              </Text>
              <Text style={{ fontSize: 12, color: tokens.text.secondary, fontFamily: "'Fira Code', monospace" }}>
                {entry.sessionId.length > 16 ? `${entry.sessionId.slice(0, 16)}…` : entry.sessionId}
              </Text>
            </div>
          )}
          {/* Metadata */}
          {entry.metadata && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 10, color: tokens.text.muted, marginBottom: 4 }}>
                {t('supervisor.metadata', 'Metadata')}
              </div>
              <div style={{
                padding: '6px 8px',
                background: tokens.bg.surface,
                borderRadius: 4,
                border: `1px solid ${tokens.border.default}`,
              }}>
                <Text style={{ fontSize: 12, color: tokens.text.secondary, fontFamily: "'Fira Code', monospace", lineHeight: 1.5 }}>
                  {entry.metadata.length > 200 ? `${entry.metadata.slice(0, 200)}…` : entry.metadata}
                </Text>
              </div>
            </div>
          )}
          {/* Full timestamp */}
          <div style={{ 
            paddingTop: 8, 
            borderTop: `1px solid ${tokens.border.default}`,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}>
            <Text style={{ fontSize: 11, color: tokens.text.muted }}>
              {t('supervisor.timestamp', 'Timestamp')}:
            </Text>
            <Text style={{ fontSize: 11, color: tokens.text.secondary, fontFamily: "'Fira Code', monospace" }}>
              {new Date(entry.timestamp).toLocaleString()}
            </Text>
          </div>
        </div>
      )}
    </div>
  );
}



// ── Main Panel ────────────────────────────────────────────────────────────

export default function SupervisorPanel() {
  const { t, i18n } = useTranslation();
  const theme = useConfigStore((s) => s.theme);
  const tokens = getThemeTokens(theme);
  const locale = i18n.language;
  const isConnected = useGatewayStore((s) => s.state === 'connected');

  const { status, auditLog, auditLogTotal, loadStatus, loadAuditLog, startPolling, stopPolling } = useSupervisorStore();

  const [filterType, setFilterType] = useState<string | undefined>(undefined);
  const [filterAction, setFilterAction] = useState<string | undefined>(undefined);
  const [searchKeyword, setSearchKeyword] = useState('');

  // Auto-polling when connected
  useEffect(() => {
    if (isConnected) {
      startPolling(3000);
    } else {
      stopPolling();
    }
    return () => { stopPolling(); };
  }, [isConnected, startPolling, stopPolling]);

  const handleRefresh = useCallback(() => {
    loadStatus();
    loadAuditLog({ limit: 200 });
  }, [loadStatus, loadAuditLog]);

  // Apply RPC-level filters (OR logic: match type OR action)
  const handleFilterChange = useCallback((type?: string, action?: string) => {
    setFilterType(type);
    setFilterAction(action);
    // Always load all data, filter client-side with OR logic
    loadAuditLog({ limit: 200 });
  }, [loadAuditLog]);

  // Client-side filtered + grouped entries
  const filteredEntries = useMemo(() => {
    let entries = auditLog;

    if (filterType || filterAction) {
      entries = entries.filter((e) => {
        const typeMatch = filterType ? e.type === filterType : false;
        const actionMatch = filterAction ? e.action === filterAction : false;
        return typeMatch || actionMatch;
      });
    }

    // Apply search keyword filter
    if (searchKeyword.trim()) {
      const q = searchKeyword.trim().toLowerCase();
      entries = entries.filter((e) => e.details.toLowerCase().includes(q));
    }
    return entries;
  }, [auditLog, searchKeyword, filterType, filterAction]);

  const groupedEntries = useMemo(() => {
    const groups: Record<string, AuditLogEntry[]> = {};
    for (const entry of filteredEntries) {
      const type = entry.type || 'unknown';
      if (!groups[type]) groups[type] = [];
      groups[type].push(entry);
    }
    // Sort groups by type order defined in LOG_TYPE_META
    const orderedKeys = Object.keys(LOG_TYPE_META);
    const sortedKeys = [
      ...orderedKeys.filter((k) => groups[k]),
      ...Object.keys(groups).filter((k) => !orderedKeys.includes(k)),
    ];
    return sortedKeys.map((key) => ({ type: key, entries: groups[key] }));
  }, [filteredEntries]);

  const stats = status?.stats ?? { total: 0, blocked: 0, corrected: 0, warnings: 0 };

  if (!isConnected) {
    return (
      <div style={{ padding: 16, textAlign: 'center' }}>
        <Text style={{ color: tokens.text.muted }}>{t('supervisor.disconnected', 'Connect to gateway to view audit logs')}</Text>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* ── Header ────────────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px',
        borderBottom: `1px solid ${tokens.border.default}`,
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <SafetyCertificateOutlined style={{ color: tokens.accent.blue }} />
          <Text strong style={{ color: tokens.text.primary, fontSize: 14 }}>
            {t('supervisor.title', 'Audit Log')}
          </Text>
          {status && (
            <Tag style={{
              fontSize: 10,
              lineHeight: '16px',
              padding: '0 5px',
              border: 'none',
              background: status.enabled ? '#10B98122' : tokens.bg.surfaceHover,
              color: status.enabled ? '#10B981' : tokens.text.muted,
            }}>
              {status.enabled ? t('supervisor.statusOn', 'ON') : t('supervisor.statusOff', 'OFF')}
            </Tag>
          )}
        </div>
        <Button size="small" icon={<ReloadOutlined />} onClick={handleRefresh} />
      </div>

      {/* ── Disabled banner ─────────────────────────────────────── */}
      {status && !status.enabled && (
        <Alert
          type="info"
          showIcon
          message={
            <span>
              {t('supervisor.disabledBanner', 'Quality control is disabled.')}
              {' '}
              <a
                onClick={() => useUiStore.getState().setRightPanelTab('settings')}
                style={{ cursor: 'pointer' }}
              >
                {t('supervisor.goToSettings', 'Go to Settings')}
              </a>
            </span>
          }
          style={{
            margin: '8px 12px 0',
            fontSize: 12,
            flexShrink: 0,
          }}
        />
      )}

      {/* ── Status bar ────────────────────────────────────────── */}
      {status && (
        <div style={{
          padding: '6px 16px',
          borderBottom: `1px solid ${tokens.border.default}`,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexShrink: 0,
          flexWrap: 'wrap',
        }}>
          <Tag style={{ fontSize: 10, lineHeight: '16px', padding: '0 5px', border: 'none', background: tokens.bg.surfaceHover, color: tokens.text.secondary }}>
            {status.reviewMode}
          </Tag>
          {status.supervisorModel && (
            <Text style={{ fontSize: 10, color: tokens.text.muted, fontFamily: "'Fira Code', monospace" }}>
              {status.supervisorModel}
            </Text>
          )}
          {status.activeSessions > 0 && (
            <Text style={{ fontSize: 10, color: tokens.text.muted }}>
              {status.activeSessions} {t('supervisor.activeSessions', 'active session(s)')}
            </Text>
          )}
        </div>
      )}

      {/* ── Stats overview ────────────────────────────────────── */}
      <div style={{
        padding: '8px 12px',
        borderBottom: `1px solid ${tokens.border.default}`,
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        flexShrink: 0,
      }}>
        <StatsCard value={stats.total} label={t('supervisor.statTotal', 'Total')} color="#3B82F6" />
        <StatsCard value={stats.blocked} label={t('supervisor.statBlocked', 'Blocked')} color="#EF4444" />
        <StatsCard value={stats.corrected} label={t('supervisor.statCorrected', 'Corrected')} color="#10B981" />
        <StatsCard value={stats.warnings} label={t('supervisor.statWarnings', 'Warnings')} color="#F59E0B" />
      </div>

      {/* ── Filter bar ────────────────────────────────────────── */}
      <div style={{
        padding: '8px 12px',
        borderBottom: `1px solid ${tokens.border.default}`,
        display: 'flex',
        gap: 6,
        flexShrink: 0,
      }}>
        <Select
          size="small"
          placeholder={t('supervisor.filterType', 'Type')}
          allowClear
          value={filterType}
          onChange={(val) => handleFilterChange(val ?? undefined, filterAction)}
          options={TYPE_SELECT_OPTIONS.map(opt => ({
            value: opt.value,
            label: t(opt.labelKey, opt.value),
          }))}
          style={{ width: 110, flexShrink: 0 }}
          popupMatchSelectWidth={false}
        />
        <Select
          size="small"
          placeholder={t('supervisor.filterAction', 'Action')}
          allowClear
          value={filterAction}
          onChange={(val) => handleFilterChange(filterType, val ?? undefined)}
          options={ACTION_SELECT_OPTIONS.map(opt => ({
            value: opt.value,
            label: t(opt.labelKey, opt.value),
          }))}
          style={{ width: 90, flexShrink: 0 }}
          popupMatchSelectWidth={false}
        />
        <Input
          size="small"
          placeholder={t('supervisor.searchPlaceholder', 'Search...')}
          prefix={<SearchOutlined style={{ color: tokens.text.muted, fontSize: 11 }} />}
          value={searchKeyword}
          onChange={(e) => setSearchKeyword(e.target.value)}
          allowClear
          style={{ flex: 1, minWidth: 0 }}
        />
      </div>

      {/* ── Audit log groups ──────────────────────────────────── */}
      <div style={{ flex: 1, overflow: 'auto', padding: '8px 8px' }}>
        {groupedEntries.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 16px' }}>
            <SafetyCertificateOutlined style={{ fontSize: 32, color: tokens.text.muted, display: 'block', marginBottom: 12 }} />
            <Text style={{ color: tokens.text.muted, fontSize: 13 }}>
              {t('supervisor.empty', 'No audit logs yet.')}
            </Text>
            <br />
            <Text style={{ color: tokens.text.muted, fontSize: 12 }}>
              {t('supervisor.emptyHint', 'Audit entries will appear here when the supervisor reviews outputs.')}
            </Text>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {groupedEntries.map(({ type, entries }) => (
              <TypeGroupWrapper
                key={type}
                type={type}
                entries={entries}
                tokens={tokens}
                locale={locale}
                t={t}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Footer ────────────────────────────────────────────── */}
      {auditLogTotal > 0 && (
        <div style={{
          padding: '6px 12px',
          borderTop: `1px solid ${tokens.border.default}`,
          flexShrink: 0,
          display: 'flex',
          justifyContent: 'center',
        }}>
          <Text style={{ fontSize: 11, color: tokens.text.muted }}>
            {t('supervisor.showingCount', 'Showing {{count}} of {{total}}', { count: filteredEntries.length, total: auditLogTotal })}
          </Text>
        </div>
      )}
    </div>
  );
}

// ── TypeGroupWrapper ─────────────────────────────────────────────────────

function TypeGroupWrapper({
  type,
  entries,
  tokens,
  locale,
  t,
}: {
  type: string;
  entries: AuditLogEntry[];
  tokens: ReturnType<typeof getThemeTokens>;
  locale: string;
  t: TFunction;
}) {
  const [expanded, setExpanded] = useState(false);

  const meta = LOG_TYPE_META[type];
  const icon = meta?.icon ?? <SafetyCertificateOutlined />;
  const color = meta?.color ?? '#71717A';
  const label = t(meta?.labelKey ?? 'supervisor.typeUnknown', type);

  return (
    <div style={{ marginBottom: 4 }}>
      <div
        onClick={() => setExpanded(!expanded)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(!expanded); } }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          cursor: 'pointer',
          borderRadius: 6,
          borderLeft: `3px solid ${color}`,
          background: expanded ? tokens.bg.surfaceHover : 'transparent',
          transition: 'background 0.15s',
        }}
      >
        <span style={{ color, fontSize: 14 }}>{icon}</span>
        <Text strong style={{ fontSize: 12, color: tokens.text.primary, flex: 1 }}>{label}</Text>
        <Tag style={{
          fontSize: 10,
          lineHeight: '16px',
          padding: '0 5px',
          border: 'none',
          background: `${color}22`,
          color,
        }}>
          {entries.length}
        </Tag>
        <span style={{ color: tokens.text.muted, fontSize: 10 }}>
          {expanded ? <UpOutlined /> : <DownOutlined />}
        </span>
      </div>

      {expanded && (
        <div style={{
          padding: '4px 4px 4px 14px',
          borderLeft: `3px solid ${color}`,
          background: tokens.bg.surfaceHover,
          borderRadius: '0 0 6px 6px',
          marginTop: -2,
          maxHeight: 320,
          overflowY: 'auto',
        }}>
            {entries.map((entry) => (
            <LogEntryCard key={entry.id} entry={entry} tokens={tokens} locale={locale} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}
