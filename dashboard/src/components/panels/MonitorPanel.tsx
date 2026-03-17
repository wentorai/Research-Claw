/**
 * MonitorPanel — Universal monitoring dashboard
 *
 * Replaces RadarPanel with a data-driven N-monitor system.
 * Each monitor is an independent information source watcher
 * (arXiv, GitHub, RSS, webpage, etc.) backed by a gateway cron job.
 *
 * Layout:
 *   - Monitor list (expandable cards with toggle/schedule/last results)
 *   - [+ Add Monitor] button at bottom
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Button, Modal, Select, Switch, Tag, Typography, Input, Tooltip } from 'antd';
import {
  EyeOutlined,
  ReloadOutlined,
  PlusOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  RobotOutlined,
  CaretRightOutlined,
  UpOutlined,
  DownOutlined,
  GithubOutlined,
  FileTextOutlined,
  GlobalOutlined,
  ExperimentOutlined,
  SearchOutlined,
  ThunderboltOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '../../stores/chat';
import { useGatewayStore } from '../../stores/gateway';
import { useMonitorStore, type Monitor } from '../../stores/monitor';
import { getThemeTokens } from '../../styles/theme';
import { useConfigStore } from '../../stores/config';
import { cronToHuman } from '../../utils/cronToHuman';
import { relativeTime } from '../../utils/relativeTime';

const { Text } = Typography;

// ── Source type icons ─────────────────────────────────────────────────────────

function sourceIcon(sourceType: string): React.ReactNode {
  switch (sourceType) {
    case 'arxiv': return <FileTextOutlined />;
    case 'semantic_scholar': return <SearchOutlined />;
    case 'github': return <GithubOutlined />;
    case 'rss': return <GlobalOutlined />;
    case 'webpage': return <EyeOutlined />;
    case 'openalex': return <ExperimentOutlined />;
    case 'twitter': return <ThunderboltOutlined />;
    case 'custom': return <RobotOutlined />;
    default: return <EyeOutlined />;
  }
}

function sourceLabel(sourceType: string): string {
  switch (sourceType) {
    case 'arxiv': return 'arXiv';
    case 'semantic_scholar': return 'Semantic Scholar';
    case 'github': return 'GitHub';
    case 'rss': return 'RSS';
    case 'webpage': return 'Webpage';
    case 'openalex': return 'OpenAlex';
    case 'twitter': return 'X / Twitter';
    case 'custom': return 'Custom';
    default: return sourceType;
  }
}

// ── MonitorCard sub-component ─────────────────────────────────────────────────

function MonitorCard({
  monitor,
  expanded,
  onToggleExpand,
  tokens,
  locale,
}: {
  monitor: Monitor;
  expanded: boolean;
  onToggleExpand: () => void;
  tokens: ReturnType<typeof getThemeTokens>;
  locale: string;
}) {
  const { t } = useTranslation();
  const { message: messageApi } = App.useApp();
  const { toggleMonitor, deleteMonitor, runMonitor } = useMonitorStore();
  const send = useChatStore((s) => s.send);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const handleToggle = useCallback((checked: boolean) => {
    toggleMonitor(monitor.id, checked);
  }, [monitor.id, toggleMonitor]);

  const handleDelete = useCallback(() => {
    setDeleteConfirm(true);
  }, []);

  const confirmDelete = useCallback(() => {
    deleteMonitor(monitor.id);
    setDeleteConfirm(false);
  }, [monitor.id, deleteMonitor]);

  const handleRun = useCallback(() => {
    if (!monitor.gateway_job_id) {
      messageApi.warning(t('monitor.enableFirst', 'Enable this monitor first'));
      return;
    }
    runMonitor(monitor.id);
    messageApi.info(t('monitor.runTriggered', 'Monitor triggered'));
  }, [monitor, runMonitor, messageApi, t]);

  const handleAskAgent = useCallback(() => {
    send(
      t('monitor.askAgentPrompt', {
        defaultValue: 'Please check and report on the monitor "{{name}}" ({{source}}). Run the scan now and summarize findings.',
        name: monitor.name,
        source: sourceLabel(monitor.source_type),
      }),
    );
  }, [monitor, send, t]);

  const schedule = cronToHuman(monitor.schedule, locale);
  const lastCheck = monitor.last_check_at ? relativeTime(monitor.last_check_at) : t('monitor.neverRun', 'Never run');

  // Parse last_results for display
  const findings = useMemo(() => {
    if (!monitor.last_results || !Array.isArray(monitor.last_results)) return [];
    return monitor.last_results.slice(0, 5);
  }, [monitor.last_results]);

  return (
    <>
      {/* ── Collapsed row ──────────────────────────────────────────── */}
      <div
        onClick={onToggleExpand}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggleExpand(); } }}
        role="button"
        tabIndex={0}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          cursor: 'pointer',
          borderRadius: 6,
          background: expanded ? tokens.bg.surfaceHover : 'transparent',
          borderLeft: `3px solid ${monitor.enabled ? tokens.accent.green : tokens.text.muted}`,
          transition: 'background 0.15s',
        }}
      >
        {/* Source icon */}
        <span style={{ color: tokens.accent.blue, fontSize: 14 }}>
          {sourceIcon(monitor.source_type)}
        </span>

        {/* Name + meta */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Text strong style={{ color: tokens.text.primary, fontSize: 13 }} ellipsis>
              {monitor.name}
            </Text>
            <Tag
              style={{
                fontSize: 10,
                lineHeight: '16px',
                padding: '0 4px',
                border: 'none',
                background: tokens.bg.surfaceHover,
                color: tokens.text.secondary,
              }}
            >
              {sourceLabel(monitor.source_type)}
            </Tag>
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 2 }}>
            <Text style={{ color: tokens.text.muted, fontSize: 11, fontFamily: 'var(--font-mono)' }}>
              {schedule}
            </Text>
            <Text style={{ color: tokens.text.muted, fontSize: 11 }}>
              {lastCheck}
            </Text>
            {monitor.finding_count > 0 && (
              <Text style={{ color: tokens.accent.blue, fontSize: 11 }}>
                {monitor.finding_count} {t('monitor.findings', 'findings')}
              </Text>
            )}
            {monitor.last_error && (
              <Text style={{ color: tokens.accent.red, fontSize: 11 }}>
                {t('monitor.error', 'Error')}
              </Text>
            )}
          </div>
        </div>

        {/* Toggle */}
        <Switch
          size="small"
          checked={monitor.enabled}
          onChange={handleToggle}
          onClick={(_, e) => e.stopPropagation()}
        />

        {/* Expand arrow */}
        <span style={{ color: tokens.text.muted, fontSize: 10 }}>
          {expanded ? <UpOutlined /> : <DownOutlined />}
        </span>
      </div>

      {/* ── Expanded detail ────────────────────────────────────────── */}
      {expanded && (
        <div style={{
          padding: '8px 12px 12px 24px',
          borderLeft: `3px solid ${monitor.enabled ? tokens.accent.green : tokens.text.muted}`,
          background: tokens.bg.surfaceHover,
          borderRadius: '0 0 6px 6px',
          marginTop: -2,
        }}>
          {/* Target */}
          {monitor.target && (
            <div style={{ marginBottom: 6 }}>
              <Text style={{ color: tokens.text.muted, fontSize: 11 }}>{t('monitor.target', 'Target')}: </Text>
              <Text style={{ color: tokens.text.primary, fontSize: 12, fontFamily: 'var(--font-mono)' }}>{monitor.target}</Text>
            </div>
          )}

          {/* Filters */}
          {Object.keys(monitor.filters).length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <Text style={{ color: tokens.text.muted, fontSize: 11 }}>{t('monitor.filters', 'Filters')}: </Text>
              <Text style={{ color: tokens.text.secondary, fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                {JSON.stringify(monitor.filters)}
              </Text>
            </div>
          )}

          {/* Schedule */}
          <div style={{ marginBottom: 6 }}>
            <Text style={{ color: tokens.text.muted, fontSize: 11 }}>
              <ClockCircleOutlined /> {schedule}
            </Text>
            {monitor.check_count > 0 && (
              <Text style={{ color: tokens.text.muted, fontSize: 11, marginLeft: 12 }}>
                {t('monitor.totalChecks', '{{count}} checks', { count: monitor.check_count })}
              </Text>
            )}
          </div>

          {/* Last error */}
          {monitor.last_error && (
            <div style={{
              marginBottom: 6,
              padding: '4px 8px',
              background: 'rgba(239, 68, 68, 0.1)',
              borderRadius: 4,
              fontSize: 11,
              color: tokens.accent.red,
            }}>
              {monitor.last_error}
            </div>
          )}

          {/* Recent findings */}
          {findings.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <Text style={{ color: tokens.text.secondary, fontSize: 11, fontWeight: 600 }}>
                {t('monitor.recentFindings', 'Recent findings')}:
              </Text>
              {findings.map((f: unknown, i: number) => {
                const item = f as Record<string, unknown>;
                const title = typeof item.title === 'string' ? item.title : JSON.stringify(item).slice(0, 80);
                return (
                  <div key={i} style={{ fontSize: 11, color: tokens.text.secondary, padding: '2px 0', paddingLeft: 8 }}>
                    • {title}
                  </div>
                );
              })}
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Tooltip title={t('monitor.runNow', 'Run now')}>
              <Button
                size="small"
                icon={<PlayCircleOutlined />}
                onClick={handleRun}
                disabled={!monitor.enabled || !monitor.gateway_job_id}
              >
                {t('monitor.runNow', 'Run now')}
              </Button>
            </Tooltip>
            <Button
              size="small"
              icon={<RobotOutlined />}
              onClick={handleAskAgent}
            >
              {t('monitor.askAgent', 'Ask Agent')}
            </Button>
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={handleDelete}
            >
              {t('monitor.delete', 'Delete')}
            </Button>
          </div>
        </div>
      )}

      {/* Delete confirm modal */}
      <Modal
        title={t('monitor.deleteConfirmTitle', 'Delete Monitor')}
        open={deleteConfirm}
        onOk={confirmDelete}
        onCancel={() => setDeleteConfirm(false)}
        okText={t('monitor.delete', 'Delete')}
        okButtonProps={{ danger: true }}
      >
        {t('monitor.deleteConfirmContent', {
          defaultValue: 'Delete "{{name}}"? It will stop running and all cached results will be lost.',
          name: monitor.name,
        })}
      </Modal>
    </>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function MonitorPanel() {
  const { t, i18n } = useTranslation();
  const theme = useConfigStore((s) => s.theme);
  const tokens = getThemeTokens(theme);
  const isConnected = useGatewayStore((s) => s.state === 'connected');
  const { monitors, loading, loaded, loadMonitors } = useMonitorStore();
  const send = useChatStore((s) => s.send);
  const locale = i18n.language;

  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (isConnected && !loaded) {
      loadMonitors();
    }
  }, [isConnected, loaded, loadMonitors]);

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const handleAddMonitor = useCallback(() => {
    send(
      t('monitor.addPrompt', {
        defaultValue: 'I want to set up a new monitor. Help me configure it. Available source types: arXiv, Semantic Scholar, GitHub, RSS, Webpage, OpenAlex, Twitter, Custom.',
      }),
    );
  }, [send, t]);

  const enabledCount = monitors.filter((m) => m.enabled).length;

  if (!isConnected) {
    return (
      <div style={{ padding: 16, textAlign: 'center' }}>
        <Text style={{ color: tokens.text.muted }}>{t('monitor.disconnected', 'Connect to gateway to view monitors')}</Text>
      </div>
    );
  }

  if (loading && !loaded) {
    return (
      <div style={{ padding: 32, textAlign: 'center' }}>
        <Text style={{ color: tokens.text.muted }}>{t('monitor.loading', 'Loading monitors...')}</Text>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* ── Header ──────────────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px',
        borderBottom: `1px solid ${tokens.border.default}`,
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <EyeOutlined style={{ color: tokens.accent.blue }} />
          <Text strong style={{ color: tokens.text.primary, fontSize: 14 }}>
            {t('monitor.title', 'Monitors')}
          </Text>
          {monitors.length > 0 && (
            <Tag style={{
              fontSize: 10,
              lineHeight: '16px',
              padding: '0 6px',
              border: 'none',
              background: tokens.bg.surfaceHover,
              color: tokens.text.secondary,
            }}>
              {enabledCount} / {monitors.length}
            </Tag>
          )}
        </div>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          onClick={loadMonitors}
          loading={loading}
        />
      </div>

      {/* ── Monitor list ────────────────────────────────────────── */}
      <div style={{ flex: 1, overflow: 'auto', padding: '8px 8px' }}>
        {monitors.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 16px' }}>
            <EyeOutlined style={{ fontSize: 32, color: tokens.text.muted, display: 'block', marginBottom: 12 }} />
            <Text style={{ color: tokens.text.muted, fontSize: 13 }}>
              {t('monitor.empty', 'No monitors configured.')}
            </Text>
            <br />
            <Text style={{ color: tokens.text.muted, fontSize: 12 }}>
              {t('monitor.emptyHint', 'Ask your Research-Claw to set up monitoring for arXiv papers, GitHub repos, RSS feeds, and more.')}
            </Text>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {monitors.map((monitor) => (
              <MonitorCard
                key={monitor.id}
                monitor={monitor}
                expanded={expandedId === monitor.id}
                onToggleExpand={() => handleToggleExpand(monitor.id)}
                tokens={tokens}
                locale={locale}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Add monitor button ──────────────────────────────────── */}
      <div style={{
        padding: '8px 12px',
        borderTop: `1px solid ${tokens.border.default}`,
        flexShrink: 0,
      }}>
        <Button
          block
          icon={<PlusOutlined />}
          onClick={handleAddMonitor}
          style={{
            borderStyle: 'dashed',
            color: tokens.text.secondary,
          }}
        >
          {t('monitor.add', 'Add Monitor')}
        </Button>
      </div>
    </div>
  );
}
