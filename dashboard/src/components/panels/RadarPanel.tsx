import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Button, Modal, Select, Spin, Switch, Tag, Typography } from 'antd';
import {
  RadarChartOutlined,
  ReloadOutlined,
  PlusOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  RobotOutlined,
  EditOutlined,
  CheckOutlined,
  CloseOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '../../stores/chat';
import { useGatewayStore } from '../../stores/gateway';
import { useRadarStore } from '../../stores/radar';
import { useCronStore, type CronPreset } from '../../stores/cron';
import { getThemeTokens } from '../../styles/theme';
import { useConfigStore } from '../../stores/config';
import { cronToHuman } from '../../utils/cronToHuman';
import { relativeTime } from '../../utils/relativeTime';

const { Text, Link } = Typography;

// ── Preset metadata for expanded view ────────────────────────────────────────

const PRESET_META: Record<string, {
  descKey: string;
  relatedKey: string;
}> = {
  arxiv_daily_scan: {
    descKey: 'radar.cron.desc.arxiv_daily_scan',
    relatedKey: 'radar.cron.related.arxiv_daily_scan',
  },
  citation_tracking_weekly: {
    descKey: 'radar.cron.desc.citation_tracking_weekly',
    relatedKey: 'radar.cron.related.citation_tracking_weekly',
  },
  deadline_reminders_daily: {
    descKey: 'radar.cron.desc.deadline_reminders_daily',
    relatedKey: 'radar.cron.related.deadline_reminders_daily',
  },
  group_meeting_prep: {
    descKey: 'radar.cron.desc.group_meeting_prep',
    relatedKey: 'radar.cron.related.group_meeting_prep',
  },
  weekly_report: {
    descKey: 'radar.cron.desc.weekly_report',
    relatedKey: 'radar.cron.related.weekly_report',
  },
};

// ── Scan result type ─────────────────────────────────────────────────────────

interface ScanResultItem {
  source: string;
  query: string;
  papers: Array<{ title: string; authors: string[]; year?: number; url: string }>;
  total_found: number;
  papers_skipped: number;
  errors: string[];
}

// ── TrackingSection sub-component ────────────────────────────────────────────

function TrackingSection({
  label,
  items,
  tokens,
  accentColor,
}: {
  label: string;
  items: string[];
  tokens: ReturnType<typeof getThemeTokens>;
  accentColor?: string;
}) {
  if (items.length === 0) return null;

  return (
    <div style={{ marginBottom: 12 }}>
      <Text style={{ fontSize: 12, color: tokens.text.muted }}>{label}</Text>
      <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {items.map((item) => (
          <Tag key={item} style={{ fontSize: 11 }} color={accentColor}>
            {item}
          </Tag>
        ))}
      </div>
    </div>
  );
}

// ── ScheduleEditor sub-component ─────────────────────────────────────────────

type ScheduleFreq = 'daily' | 'weekdays' | 'weekly';

/** Parse cron "min hour * * dow" into structured fields. */
function parseCron(cron: string): { freq: ScheduleFreq; day: number; hour: number; minute: number } {
  const parts = cron.trim().split(/\s+/);
  const minute = parseInt(parts[0]) || 0;
  const hour = parseInt(parts[1]) || 0;
  const dow = parts[4] || '*';
  if (dow === '*') return { freq: 'daily', day: 1, hour, minute };
  if (dow === '1-5') return { freq: 'weekdays', day: 1, hour, minute };
  return { freq: 'weekly', day: parseInt(dow) || 1, hour, minute };
}

function ScheduleEditor({
  schedule,
  onSave,
  onCancel,
  saving,
  locale,
}: {
  schedule: string;
  onSave: (cron: string) => void;
  onCancel: () => void;
  saving: boolean;
  locale: string;
}) {
  const init = parseCron(schedule);
  const [freq, setFreq] = useState<ScheduleFreq>(init.freq);
  const [day, setDay] = useState(init.day);
  const [hour, setHour] = useState(init.hour);
  const [minute, setMinute] = useState(init.minute);

  const buildCron = useCallback(() => {
    const dow = freq === 'daily' ? '*' : freq === 'weekdays' ? '1-5' : String(day);
    return `${minute} ${hour} * * ${dow}`;
  }, [freq, day, hour, minute]);

  const isZh = locale.startsWith('zh');

  const freqOptions = [
    { value: 'daily' as const, label: isZh ? '每天' : 'Daily' },
    { value: 'weekdays' as const, label: isZh ? '工作日' : 'Weekdays' },
    { value: 'weekly' as const, label: isZh ? '每周' : 'Weekly' },
  ];

  const dayOptions = [
    { value: 1, label: isZh ? '周一' : 'Mon' },
    { value: 2, label: isZh ? '周二' : 'Tue' },
    { value: 3, label: isZh ? '周三' : 'Wed' },
    { value: 4, label: isZh ? '周四' : 'Thu' },
    { value: 5, label: isZh ? '周五' : 'Fri' },
    { value: 6, label: isZh ? '周六' : 'Sat' },
    { value: 0, label: isZh ? '周日' : 'Sun' },
  ];

  const hourOptions = Array.from({ length: 24 }, (_, i) => ({
    value: i,
    label: String(i).padStart(2, '0'),
  }));

  const minuteOptions = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => ({
    value: m,
    label: String(m).padStart(2, '0'),
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Row 1: frequency + day */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Select
          size="small"
          value={freq}
          onChange={(v) => setFreq(v)}
          options={freqOptions}
          style={{ width: isZh ? 80 : 100 }}
          popupMatchSelectWidth={false}
        />
        {freq === 'weekly' && (
          <Select
            size="small"
            value={day}
            onChange={setDay}
            options={dayOptions}
            style={{ width: isZh ? 72 : 72 }}
            popupMatchSelectWidth={false}
          />
        )}
      </div>
      {/* Row 2: time + confirm/cancel */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Select size="small" value={hour} onChange={setHour} options={hourOptions} style={{ width: 58 }} popupMatchSelectWidth={false} />
        <span style={{ fontSize: 13, fontWeight: 500 }}>:</span>
        <Select size="small" value={minute} onChange={setMinute} options={minuteOptions} style={{ width: 58 }} popupMatchSelectWidth={false} />
        <Button size="small" type="primary" icon={<CheckOutlined />} loading={saving} onClick={() => onSave(buildCron())} style={{ marginLeft: 4 }} />
        <Button size="small" icon={<CloseOutlined />} onClick={onCancel} />
      </div>
    </div>
  );
}

// ── CronPresetCard sub-component ─────────────────────────────────────────────

function CronPresetCard({
  preset,
  tokens,
  expanded,
  onToggleExpand,
}: {
  preset: CronPreset;
  tokens: ReturnType<typeof getThemeTokens>;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const activatePreset = useCronStore((s) => s.activatePreset);
  const deactivatePreset = useCronStore((s) => s.deactivatePreset);
  const deletePreset = useCronStore((s) => s.deletePreset);
  const updatePresetSchedule = useCronStore((s) => s.updatePresetSchedule);
  const send = useChatStore((s) => s.send);
  const [toggling, setToggling] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);

  const locale = i18n.language || 'en';
  const meta = PRESET_META[preset.id];

  const handleToggle = useCallback(async (checked: boolean, e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    setToggling(true);
    try {
      if (checked) {
        await activatePreset(preset.id);
      } else {
        await deactivatePreset(preset.id);
      }
    } finally {
      setToggling(false);
    }
  }, [preset.id, activatePreset, deactivatePreset]);

  const handleDelete = useCallback(() => {
    Modal.confirm({
      title: t('radar.cron.deleteConfirmTitle'),
      content: t('radar.cron.deleteConfirmContent', { name: preset.name }),
      okText: t('radar.cron.delete'),
      okType: 'danger',
      onOk: async () => {
        await deletePreset(preset.id);
      },
    });
  }, [preset.id, preset.name, deletePreset, t]);

  const handleAskAgent = useCallback(() => {
    const prompt = t('radar.cron.askAgentPrompt', { name: preset.name });
    send(prompt);
  }, [preset.name, send, t]);

  const handleScheduleSave = useCallback(async (cron: string) => {
    if (cron === preset.schedule) {
      setEditingSchedule(false);
      return;
    }
    setSavingSchedule(true);
    try {
      await updatePresetSchedule(preset.id, cron);
      setEditingSchedule(false);
      message.success(t('radar.cron.scheduleUpdated', { defaultValue: 'Schedule updated' }));
    } catch {
      message.error(t('radar.cron.scheduleUpdateFailed', { defaultValue: 'Failed to update schedule' }));
    } finally {
      setSavingSchedule(false);
    }
  }, [preset.schedule, preset.id, updatePresetSchedule, message, t]);

  const humanSchedule = cronToHuman(preset.schedule, locale);
  const lastRunText = relativeTime(preset.last_run_at, locale);

  return (
    <div
      style={{
        border: `1px solid ${tokens.border.default}`,
        borderRadius: 6,
        marginBottom: 8,
        background: expanded ? tokens.bg.surface : 'transparent',
        overflow: 'hidden',
      }}
    >
      {/* Collapsed state — always visible */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggleExpand}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggleExpand(); }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          cursor: 'pointer',
        }}
      >
        {/* Status dot */}
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: preset.enabled ? '#52c41a' : tokens.text.muted,
            flexShrink: 0,
          }}
        />

        {/* Name + schedule line */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontSize: 13, fontWeight: 500, display: 'block' }}>{preset.name}</Text>
          <Text style={{ fontSize: 11, color: tokens.text.muted }}>
            <ClockCircleOutlined style={{ marginRight: 3 }} />
            {humanSchedule}
            <span style={{ margin: '0 6px' }}>&middot;</span>
            {t('radar.cron.lastRun')}: {lastRunText}
          </Text>
        </div>

        {/* Toggle switch */}
        <Switch
          size="small"
          checked={preset.enabled}
          loading={toggling}
          onChange={handleToggle}
          onClick={(_, e) => e.stopPropagation()}
        />
      </div>

      {/* Expanded state — detail fields + actions */}
      {expanded && (
        <div style={{ borderTop: `1px solid ${tokens.border.default}`, padding: '12px 12px 8px' }}>
          {/* Description */}
          {meta && (
            <Text style={{ fontSize: 12, display: 'block', marginBottom: 12, color: tokens.text.secondary }}>
              {t(meta.descKey)}
            </Text>
          )}

          {/* Detail fields */}
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 12, marginBottom: 12 }}>
            <Text style={{ color: tokens.text.muted }}>{t('radar.cron.schedule')}</Text>
            {editingSchedule ? (
              <ScheduleEditor
                schedule={preset.schedule}
                onSave={handleScheduleSave}
                onCancel={() => setEditingSchedule(false)}
                saving={savingSchedule}
                locale={locale}
              />
            ) : (
              <span>
                {humanSchedule}
                <Button
                  size="small"
                  type="text"
                  icon={<EditOutlined />}
                  onClick={() => setEditingSchedule(true)}
                  style={{ padding: '0 4px', marginLeft: 4, fontSize: 11 }}
                />
              </span>
            )}

            <Text style={{ color: tokens.text.muted }}>{t('radar.cron.lastRun')}</Text>
            <Text>{preset.last_run_at ? relativeTime(preset.last_run_at, locale) : t('radar.cron.neverRun')}</Text>

            <Text style={{ color: tokens.text.muted }}>{t('radar.cron.nextRun')}</Text>
            <Text>{preset.next_run_at ? relativeTime(preset.next_run_at, locale) : t('radar.cron.neverRun')}</Text>

            {meta && (
              <>
                <Text style={{ color: tokens.text.muted }}>{t('radar.cron.relatedConfig')}</Text>
                <Text>{t(meta.relatedKey)}</Text>
              </>
            )}

            {/* Extra field for deadline_reminders_daily */}
            {preset.id === 'deadline_reminders_daily' && (
              <>
                <Text style={{ color: tokens.text.muted }}>{t('radar.cron.reminderWindow')}</Text>
                <Text>
                  {locale.startsWith('zh')
                    ? `截止前 ${(preset.config as Record<string, unknown>).reminder_window_hours ?? 48} 小时`
                    : `${(preset.config as Record<string, unknown>).reminder_window_hours ?? 48}h before deadline`}
                </Text>
              </>
            )}
          </div>

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button
              size="small"
              icon={<RobotOutlined />}
              onClick={handleAskAgent}
            >
              {t('radar.cron.askAgent')}
            </Button>
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={handleDelete}
            >
              {t('radar.cron.delete')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Section Header sub-component ─────────────────────────────────────────────

function SectionHeader({
  title,
  tokens,
  extra,
}: {
  title: string;
  tokens: ReturnType<typeof getThemeTokens>;
  extra?: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      borderBottom: `1px solid ${tokens.border.default}`,
      paddingBottom: 6,
      marginBottom: 10,
    }}>
      <Text strong style={{
        fontSize: 12,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        color: tokens.text.muted,
      }}>
        {title}
      </Text>
      {extra}
    </div>
  );
}

// ── Main Panel ───────────────────────────────────────────────────────────────

export default function RadarPanel() {
  const { t, i18n } = useTranslation();
  const configTheme = useConfigStore((s) => s.theme);
  const tokens = useMemo(() => getThemeTokens(configTheme), [configTheme]);
  const send = useChatStore((s) => s.send);
  const messages = useChatStore((s) => s.messages);
  const client = useGatewayStore((s) => s.client);
  const connState = useGatewayStore((s) => s.state);
  const tracking = useRadarStore((s) => s.config);
  const configLoaded = useRadarStore((s) => s.configLoaded);
  const loadConfig = useRadarStore((s) => s.loadConfig);
  const presets = useCronStore((s) => s.presets);
  const presetsLoaded = useCronStore((s) => s.presetsLoaded);
  const loadPresets = useCronStore((s) => s.loadPresets);

  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState<ScanResultItem[] | null>(null);
  const [lastScanAt, setLastScanAt] = useState<string | null>(null);
  const [expandedPresetId, setExpandedPresetId] = useState<string | null>(null);

  // Load radar config + cron presets + cached scan results when gateway connects
  useEffect(() => {
    if (connState === 'connected') {
      loadConfig();
      loadPresets();
      // Load cached scan results so panel isn't empty on open
      client?.request<{ results: ScanResultItem[] | null; scanned_at: string | null }>('rc.radar.lastScan', {})
        .then((cached) => {
          if (cached?.results && cached.results.length > 0 && !scanResults) {
            setScanResults(cached.results);
            setLastScanAt(cached.scanned_at);
          }
        })
        .catch(() => { /* non-fatal */ });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connState]);

  // Extract radar_digest cards from chat messages
  const radarDigests = useMemo(() => {
    const digests: Array<{ source: string; query: string; total_found: number; period: string }> = [];
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.text) {
        const regex = /```radar_digest\n([\s\S]*?)```/g;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(msg.text)) !== null) {
          try {
            const data = JSON.parse(match[1]);
            digests.push(data);
          } catch {
            /* skip malformed */
          }
        }
      }
    }
    return digests;
  }, [messages]);

  const hasKeywords = tracking.keywords.length > 0;
  const hasAuthors = tracking.authors.length > 0;
  const hasJournals = tracking.journals.length > 0;
  const hasSources = (tracking.sources?.length ?? 0) > 0;
  const hasTrackingItems = hasKeywords || hasAuthors || hasJournals;

  const activeCount = presets.filter((p) => p.enabled).length;
  const totalCount = presets.length;

  const handleRefresh = useCallback(async () => {
    if (!client?.isConnected) return;
    setScanning(true);
    setScanResults(null);
    try {
      const result = await client.request<{ results: ScanResultItem[] }>('rc.radar.scan', {});
      setScanResults(result.results);
      setLastScanAt(new Date().toISOString());
    } catch (err) {
      console.error('[RadarPanel] scan failed:', err);
    } finally {
      setScanning(false);
    }
  }, [client]);

  const handleEditViaChat = () => {
    send('Configure my research radar. I want to track:');
  };

  // Not connected yet — show loading state
  if (!configLoaded && connState !== 'connected') {
    return (
      <div style={{ padding: 24, textAlign: 'center', paddingTop: 60 }}>
        <RadarChartOutlined style={{ fontSize: 48, color: tokens.text.muted, opacity: 0.4 }} />
        <div style={{ marginTop: 16 }}>
          <Text type="secondary" style={{ fontSize: 13 }}>
            {t('radar.empty')}
          </Text>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto' }}>
      {/* ── Section 1: Tracking Profile ─────────────────────────────────── */}
      <div style={{ padding: '12px 16px 8px' }}>
        <SectionHeader
          title={t('radar.section.trackingProfile')}
          tokens={tokens}
        />

        {/* Sources */}
        {hasSources && (
          <TrackingSection
            label={t('radar.sources')}
            items={tracking.sources!}
            tokens={tokens}
            accentColor="blue"
          />
        )}

        {/* Tracking config */}
        {hasTrackingItems ? (
          <>
            <TrackingSection label={t('radar.keywords')} items={tracking.keywords} tokens={tokens} />
            <TrackingSection label={t('radar.authors')} items={tracking.authors} tokens={tokens} />
            <TrackingSection label={t('radar.journals')} items={tracking.journals} tokens={tokens} />
            <Link
              onClick={handleEditViaChat}
              style={{ fontSize: 12, color: tokens.accent.blue }}
            >
              {t('radar.editViaChat')}
            </Link>
          </>
        ) : (
          <div style={{ textAlign: 'center', padding: '8px 0' }}>
            <Text type="secondary" style={{ fontSize: 13 }}>
              {t('radar.noTracking')}
            </Text>
            <div style={{ marginTop: 8 }}>
              <Button size="small" icon={<PlusOutlined />} onClick={handleEditViaChat}>
                {t('radar.addTracking')}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* ── Section 2: Automated Tasks ──────────────────────────────────── */}
      {presetsLoaded && (
        <div style={{ padding: '8px 16px 12px' }}>
          <SectionHeader
            title={`${t('radar.section.automatedTasks')} (${activeCount} / ${totalCount})`}
            tokens={tokens}
          />

          {presets.length > 0 ? (
            <div>
              {presets.map((preset) => (
                <CronPresetCard
                  key={preset.id}
                  preset={preset}
                  tokens={tokens}
                  expanded={expandedPresetId === preset.id}
                  onToggleExpand={() =>
                    setExpandedPresetId((prev) => (prev === preset.id ? null : preset.id))
                  }
                />
              ))}
            </div>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('radar.noDiscoveries')}
            </Text>
          )}
        </div>
      )}

      {/* ── Section 3: Recent Discoveries ───────────────────────────────── */}
      <div style={{ padding: '8px 16px', flex: 1 }}>
        <SectionHeader
          title={
            lastScanAt
              ? `${t('radar.section.recentDiscoveries')} · ${relativeTime(lastScanAt, locale)}`
              : t('radar.section.recentDiscoveries')
          }
          tokens={tokens}
          extra={
            <Button
              type="text"
              size="small"
              icon={<ReloadOutlined spin={scanning} />}
              onClick={handleRefresh}
              disabled={scanning}
            >
              {scanning ? t('radar.scanning') : t('radar.refresh')}
            </Button>
          }
        />

        {/* Scanning indicator */}
        {scanning && (
          <div style={{ padding: 16, textAlign: 'center' }}>
            <Spin size="small" />
            <Text style={{ marginLeft: 8, fontSize: 12, color: tokens.text.muted }}>{t('radar.scanning')}</Text>
          </div>
        )}

        {/* Scan results from RPC */}
        {scanResults && scanResults.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {scanResults.map((result, idx) => (
              <div key={idx} style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <Tag style={{ fontSize: 10 }} color="blue">{result.source}</Tag>
                  <Text style={{ fontSize: 11, color: tokens.text.muted }}>
                    {result.papers.length} {t('radar.newPapers')}, {result.papers_skipped} {t('radar.skipped')}
                  </Text>
                </div>
                {result.errors.length > 0 && (
                  <Text type="danger" style={{ fontSize: 11 }}>{result.errors.join('; ')}</Text>
                )}
                {result.papers.slice(0, 5).map((paper, pIdx) => (
                  <div
                    key={pIdx}
                    style={{
                      padding: '6px 10px',
                      marginBottom: 4,
                      borderLeft: `2px solid ${tokens.accent.blue}`,
                      background: tokens.bg.surface,
                      borderRadius: 4,
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: 500, display: 'block' }}>{paper.title}</Text>
                    <Text style={{ fontSize: 10, color: tokens.text.muted }}>
                      {paper.authors.slice(0, 3).join(', ')}{paper.year ? ` (${paper.year})` : ''}
                    </Text>
                  </div>
                ))}
                {result.papers.length > 5 && (
                  <Text style={{ fontSize: 11, color: tokens.text.muted, fontStyle: 'italic' }}>
                    ...{result.papers.length - 5} more
                  </Text>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Radar digests from chat */}
        {radarDigests.length > 0 && !scanResults && (
          <div style={{ marginTop: 8 }}>
            {radarDigests.map((digest, idx) => (
              <div
                key={idx}
                style={{
                  padding: '8px 12px',
                  marginBottom: 8,
                  borderLeft: `3px solid ${tokens.accent.blue}`,
                  background: tokens.bg.surface,
                  borderRadius: 4,
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: 500 }}>
                  {digest.total_found} papers &mdash; &quot;{digest.query}&quot;
                </Text>
                <div style={{ fontSize: 11, color: tokens.text.muted, marginTop: 2 }}>
                  <Tag style={{ fontSize: 10 }}>{digest.source}</Tag>
                  <span style={{ marginLeft: 4 }}>{digest.period}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* No findings yet hint — only show when tracking is configured */}
        {radarDigests.length === 0 && !scanResults && !scanning && hasTrackingItems && (
          <div style={{ padding: '16px 0', textAlign: 'center' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('radar.noFindings')}
            </Text>
          </div>
        )}
      </div>
    </div>
  );
}
