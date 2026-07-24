/**
 * DeviceMonitors — scheduled check panel for a registered peripheral device.
 *
 * Embedded in CameraDetail at data-testid="periph-camera-monitors" (T16).
 *
 * Responsibilities:
 *   - List: monitors.filter(m => m.source_type === 'device' && m.target === deviceId)
 *   - Per-row: name, schedule badge, enable/disable Switch, run-now button, delete
 *   - Create form: name + schedule chips + check_prompt textarea + "Let agent configure" chip
 *
 * Note: ObservationTimeline is NO LONGER rendered here. It is rendered by CameraDetail
 * directly at the periph-camera-timeline mount point (Fix 3, T16 review).
 *
 * Protocol boundary (T8 authority):
 *   device monitors use the dedicated vision protocol stored in agent_prompt.
 *   The dashboard supplies agent_prompt='' on create so the plugin calls
 *   defaultAgentPrompt('device', filters), which injects the full template.
 *   filters.check_prompt is stored for dashboard-side substitution at cron-send time.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  App,
  Button,
  Divider,
  Form,
  Input,
  Popconfirm,
  Switch,
  Tag,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  PlusOutlined,
  RocketOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useMonitorStore } from '../../stores/monitor';
import { useUiStore } from '../../stores/ui';

const { Text } = Typography;

// ── Schedule preset chips ─────────────────────────────────────────────────────

interface ScheduleChip {
  labelKey: string;
  fallback: string;
  expr: string;
}

const SCHEDULE_CHIPS: ScheduleChip[] = [
  { labelKey: 'periph.monitors.scheduleEvery5',  fallback: 'Every 5 min',  expr: '*/5 * * * *' },
  { labelKey: 'periph.monitors.scheduleEvery30', fallback: 'Every 30 min', expr: '*/30 * * * *' },
  { labelKey: 'periph.monitors.scheduleHourly',  fallback: 'Hourly',        expr: '0 * * * *' },
];

const DEFAULT_SCHEDULE = '*/30 * * * *';

// ── Simple cron validation (5 fields) ────────────────────────────────────────

function isValidCron(expr: string): boolean {
  return /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(expr.trim());
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface DeviceMonitorsProps {
  deviceId: string;
  checkPrompt: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DeviceMonitors({ deviceId, checkPrompt }: DeviceMonitorsProps) {
  const { t } = useTranslation();
  const { message } = App.useApp();

  const monitors = useMonitorStore((s) => s.monitors);
  const createMonitor = useMonitorStore((s) => s.createMonitor);
  const toggleMonitor = useMonitorStore((s) => s.toggleMonitor);
  const deleteMonitor = useMonitorStore((s) => s.deleteMonitor);
  const runMonitor = useMonitorStore((s) => s.runMonitor);
  const setChatInputPrefill = useUiStore((s) => s.setChatInputPrefill);

  // Filter to device monitors for this device
  const deviceMonitors = useMemo(
    () => monitors.filter((m) => m.source_type === 'device' && m.target === deviceId),
    [monitors, deviceId],
  );

  // Create form state
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState(DEFAULT_SCHEDULE);
  const [customCron, setCustomCron] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [promptText, setPromptText] = useState(checkPrompt);
  const [creating, setCreating] = useState(false);

  const effectiveSchedule = useCustom ? customCron : schedule;

  const resetForm = useCallback(() => {
    setName('');
    setSchedule(DEFAULT_SCHEDULE);
    setCustomCron('');
    setUseCustom(false);
    setPromptText(checkPrompt);
    setShowForm(false);
  }, [checkPrompt]);

  const handleCreate = useCallback(async () => {
    if (!name.trim()) {
      message.warning(t('periph.monitors.nameRequired', 'Name is required'));
      return;
    }
    if (!isValidCron(effectiveSchedule)) {
      message.warning(t('periph.monitors.cronInvalid', 'Invalid cron expression (5 fields required)'));
      return;
    }

    setCreating(true);
    try {
      const result = await createMonitor({
        name: name.trim(),
        source_type: 'device',
        target: deviceId,
        schedule: effectiveSchedule,
        filters: promptText.trim() ? { check_prompt: promptText.trim() } : {},
        // Leave agent_prompt empty → plugin calls defaultAgentPrompt('device', filters)
        agent_prompt: '',
        enabled: false,
      });
      if (result) {
        message.success(t('periph.monitors.create', 'New Check') + ' — ' + result.name);
        resetForm();
      }
    } finally {
      setCreating(false);
    }
  }, [name, effectiveSchedule, deviceId, promptText, createMonitor, message, t, resetForm]);

  const handleAskAgent = useCallback(() => {
    const prefill = t('periph.monitors.askAgentPrefill', {
      deviceId,
      hint: promptText.trim() || '判断画面是否存在异常',
      defaultValue: `帮我为设备 ${deviceId} 创建一个定时查证监控，需要检查：${promptText.trim() || '判断画面是否存在异常'}`,
    });
    setChatInputPrefill(prefill as string);
  }, [deviceId, promptText, setChatInputPrefill, t]);

  return (
    <div data-testid="periph-device-monitors">
      {/* Section title */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <Text style={{ fontWeight: 600, fontSize: 13 }}>
          {t('periph.monitors.title', 'Scheduled Checks')}
        </Text>
        {!showForm && (
          <Button
            data-testid="periph-monitors-create-btn"
            size="small"
            icon={<PlusOutlined />}
            onClick={() => setShowForm(true)}
          >
            {t('periph.monitors.create', 'New Check')}
          </Button>
        )}
      </div>

      {/* Monitor list */}
      {deviceMonitors.length === 0 && !showForm && (
        <div
          data-testid="periph-monitors-empty"
          style={{ padding: '8px 0', color: '#6B7280', fontSize: 13 }}
        >
          {t('periph.monitors.empty', 'No scheduled checks yet.')}
        </div>
      )}

      {deviceMonitors.map((monitor) => (
        <div
          key={monitor.id}
          data-testid={`periph-monitor-row-${monitor.id}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 0',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          {/* Enable switch */}
          <Switch
            data-testid={`periph-monitor-toggle-${monitor.id}`}
            size="small"
            checked={monitor.enabled}
            onChange={(v) => { void toggleMonitor(monitor.id, v); }}
          />

          {/* Name + schedule */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 13, display: 'block' }} ellipsis>
              {monitor.name}
            </Text>
            <Tag style={{ fontSize: 11, marginTop: 2 }}>{monitor.schedule}</Tag>
            {!monitor.enabled && (
              <Tag color="default" style={{ fontSize: 10 }}>
                {t('periph.monitors.disabledBadge', 'disabled')}
              </Tag>
            )}
          </div>

          {/* Run now */}
          <Button
            data-testid={`periph-monitor-run-${monitor.id}`}
            size="small"
            icon={<ThunderboltOutlined />}
            disabled={!monitor.enabled}
            title={monitor.enabled ? t('periph.monitors.runNow', 'Run now') : t('periph.monitors.enableFirst', 'Enable this check to run it')}
            onClick={() => { void runMonitor(monitor.id); }}
          />

          {/* Delete */}
          <Popconfirm
            title={t('periph.monitors.deleteConfirm', 'Delete this scheduled check?')}
            onConfirm={() => { void deleteMonitor(monitor.id); }}
            okType="danger"
          >
            <Button
              data-testid={`periph-monitor-delete-${monitor.id}`}
              size="small"
              danger
              icon={<DeleteOutlined />}
            />
          </Popconfirm>
        </div>
      ))}

      {/* Create form */}
      {showForm && (
        <div
          data-testid="periph-monitors-form"
          style={{
            marginTop: 12,
            padding: '12px',
            background: 'rgba(255,255,255,0.04)',
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <Form layout="vertical" size="small">
            {/* Name */}
            <Form.Item
              label={<Text style={{ fontSize: 12 }}>{t('periph.monitors.name', 'Name')}</Text>}
              style={{ marginBottom: 8 }}
            >
              <Input
                data-testid="periph-monitors-form-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('periph.monitors.namePlaceholder', 'e.g. Hourly lab check')}
              />
            </Form.Item>

            {/* Schedule chips */}
            <Form.Item
              label={<Text style={{ fontSize: 12 }}>{t('periph.monitors.schedule', 'Schedule')}</Text>}
              style={{ marginBottom: 8 }}
            >
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                {SCHEDULE_CHIPS.map((chip) => (
                  <Tag
                    key={chip.expr}
                    data-testid={`periph-monitors-chip-${chip.expr}`}
                    color={!useCustom && schedule === chip.expr ? 'blue' : 'default'}
                    style={{ cursor: 'pointer', userSelect: 'none' }}
                    onClick={() => { setSchedule(chip.expr); setUseCustom(false); }}
                  >
                    {t(chip.labelKey, chip.fallback)}
                  </Tag>
                ))}
                <Tag
                  data-testid="periph-monitors-chip-custom"
                  color={useCustom ? 'blue' : 'default'}
                  style={{ cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => setUseCustom(true)}
                >
                  {t('periph.monitors.scheduleCustom', 'Custom cron')}
                </Tag>
              </div>
              {useCustom && (
                <Input
                  data-testid="periph-monitors-custom-cron"
                  value={customCron}
                  onChange={(e) => setCustomCron(e.target.value)}
                  placeholder={t('periph.monitors.scheduleCustomPlaceholder', '*/15 * * * *')}
                  style={{ fontFamily: "'Fira Code', monospace", fontSize: 12 }}
                />
              )}
            </Form.Item>

            {/* Check prompt */}
            <Form.Item
              label={<Text style={{ fontSize: 12 }}>{t('periph.monitors.checkPrompt', 'Verification requirement')}</Text>}
              style={{ marginBottom: 8 }}
            >
              <Input.TextArea
                data-testid="periph-monitors-form-prompt"
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                rows={2}
                placeholder={t('periph.monitors.checkPromptPlaceholder', 'Describe what to look for (leave empty for default)')}
              />
            </Form.Item>

            {/* Ask agent chip */}
            <Tag
              data-testid="periph-monitors-ask-agent"
              color="blue"
              icon={<RocketOutlined />}
              style={{ cursor: 'pointer', marginBottom: 8 }}
              onClick={handleAskAgent}
            >
              {t('periph.monitors.askAgent', 'Let agent configure')}
            </Tag>

            {/* Submit / Cancel */}
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <Button
                data-testid="periph-monitors-form-submit"
                type="primary"
                size="small"
                loading={creating}
                onClick={() => { void handleCreate(); }}
              >
                {t('periph.monitors.submit', 'Create')}
              </Button>
              <Button
                data-testid="periph-monitors-form-cancel"
                size="small"
                onClick={resetForm}
              >
                {t('periph.monitors.cancel', 'Cancel')}
              </Button>
            </div>
          </Form>
        </div>
      )}

    </div>
  );
}
