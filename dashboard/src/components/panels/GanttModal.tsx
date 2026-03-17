import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Typography } from 'antd';
import { CloseOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useConfigStore } from '../../stores/config';
import { getThemeTokens } from '../../styles/theme';
import type { Task } from '../../stores/tasks';
import { PRIORITY_COLORS } from '../../utils/task-constants';

const { Text } = Typography;

type ViewMode = 'Day' | 'Week' | 'Month';

interface GanttBar {
  id: string;
  name: string;
  start: string;
  end: string;
  progress: number;
  dependencies: string;
  custom_class: string;
}

interface GanttModalProps {
  open: boolean;
  tasks: Task[];
  onClose: () => void;
  onTaskClick: (taskId: string) => void;
}

const STATUS_PROGRESS: Record<string, number> = {
  todo: 0,
  in_progress: 50,
  blocked: 25,
  done: 100,
  cancelled: 100,
};

function toDateStr(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getDarkThemeCSS(): string {
  return `
    .gantt .grid-background { fill: #0A0A0B; }
    .gantt .grid-header { fill: #141415; }
    .gantt .grid-row { fill: #0A0A0B; }
    .gantt .grid-row:nth-child(even) { fill: #111112; }
    .gantt .row-line { stroke: rgba(255,255,255,0.06); }
    .gantt .tick { stroke: rgba(255,255,255,0.08); }
    .gantt .today-highlight { fill: rgba(59,130,246,0.08); }
    .gantt .bar { rx: 4; ry: 4; }
    .gantt .bar-label { fill: #E4E4E7; }
    .gantt .bar-label.big { fill: #E4E4E7; }
    .gantt .lower-text, .gantt .upper-text { fill: #A1A1AA; }
    .gantt .header-border { stroke: rgba(255,255,255,0.1); }
    .gantt .arrow { stroke: rgba(255,255,255,0.3); }
    .priority-urgent .bar-wrapper .bar { fill: ${PRIORITY_COLORS.urgent} !important; }
    .priority-high .bar-wrapper .bar { fill: ${PRIORITY_COLORS.high} !important; }
    .priority-medium .bar-wrapper .bar { fill: ${PRIORITY_COLORS.medium} !important; }
    .priority-low .bar-wrapper .bar { fill: ${PRIORITY_COLORS.low} !important; }
    .priority-urgent .bar-wrapper .bar-progress { fill: rgba(239,68,68,0.6) !important; }
    .priority-high .bar-wrapper .bar-progress { fill: rgba(245,158,11,0.6) !important; }
    .priority-medium .bar-wrapper .bar-progress { fill: rgba(59,130,246,0.6) !important; }
    .priority-low .bar-wrapper .bar-progress { fill: rgba(107,114,128,0.6) !important; }
  `;
}

function getLightThemeCSS(): string {
  return `
    .priority-urgent .bar-wrapper .bar { fill: ${PRIORITY_COLORS.urgent} !important; }
    .priority-high .bar-wrapper .bar { fill: ${PRIORITY_COLORS.high} !important; }
    .priority-medium .bar-wrapper .bar { fill: ${PRIORITY_COLORS.medium} !important; }
    .priority-low .bar-wrapper .bar { fill: ${PRIORITY_COLORS.low} !important; }
    .priority-urgent .bar-wrapper .bar-progress { fill: rgba(239,68,68,0.6) !important; }
    .priority-high .bar-wrapper .bar-progress { fill: rgba(245,158,11,0.6) !important; }
    .priority-medium .bar-wrapper .bar-progress { fill: rgba(59,130,246,0.6) !important; }
    .priority-low .bar-wrapper .bar-progress { fill: rgba(107,114,128,0.6) !important; }
    .gantt .bar { rx: 4; ry: 4; }
  `;
}

export default function GanttModal({ open, tasks, onClose, onTaskClick }: GanttModalProps) {
  const { t } = useTranslation();
  const theme = useConfigStore((s) => s.theme);
  const tokens = useMemo(() => getThemeTokens(theme), [theme]);
  const isDark = theme === 'dark';

  const containerRef = useRef<HTMLDivElement>(null);
  const ganttRef = useRef<import('frappe-gantt').default | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('Week');

  // Convert tasks to Gantt bars — only tasks with deadlines that aren't done/cancelled
  const bars = useMemo(() => {
    const taskMap = new Set(tasks.filter((t) => t.deadline && t.status !== 'done' && t.status !== 'cancelled').map((t) => t.id));

    return tasks
      .filter((t) => t.deadline && t.status !== 'done' && t.status !== 'cancelled')
      .map((task): GanttBar => ({
        id: task.id,
        name: task.title.length > 40 ? task.title.slice(0, 37) + '...' : task.title,
        start: toDateStr(task.created_at),
        end: toDateStr(task.deadline!),
        progress: STATUS_PROGRESS[task.status] ?? 0,
        dependencies: task.parent_task_id && taskMap.has(task.parent_task_id) ? task.parent_task_id : '',
        custom_class: `priority-${task.priority}`,
      }));
  }, [tasks]);

  const handleTaskClick = useCallback(
    (bar: { id: string }) => {
      onTaskClick(bar.id);
    },
    [onTaskClick],
  );

  // Build / rebuild Gantt instance when modal opens or task data changes
  useEffect(() => {
    if (!open || bars.length === 0 || !containerRef.current) return;

    let cancelled = false;

    import('frappe-gantt').then(({ default: Gantt }) => {
      if (cancelled || !containerRef.current) return;
      containerRef.current.innerHTML = '';
      ganttRef.current = new Gantt(containerRef.current, bars, {
        view_mode: viewMode,
        on_click: handleTaskClick,
        custom_popup_html: () => '',
      });
    }).catch((err) => {
      console.warn('[GanttModal] Failed to load frappe-gantt:', err);
    });

    return () => {
      cancelled = true;
      ganttRef.current = null;
      if (containerRef.current) containerRef.current.innerHTML = '';
    };
  // viewMode is excluded — handled by the lighter effect below
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bars, handleTaskClick]);

  // Switch view mode on existing instance (no rebuild)
  useEffect(() => {
    if (ganttRef.current) {
      ganttRef.current.change_view_mode(viewMode);
    }
  }, [viewMode]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const viewModes: { key: ViewMode; label: string }[] = [
    { key: 'Day', label: t('tasks.gantt.viewDay') },
    { key: 'Week', label: t('tasks.gantt.viewWeek') },
    { key: 'Month', label: t('tasks.gantt.viewMonth') },
  ];

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.55)',
          zIndex: 1050,
        }}
      />
      {/* Modal */}
      <div
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(1000px, 95vw)',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          background: tokens.bg.primary,
          border: `1px solid ${tokens.border.default}`,
          borderRadius: 8,
          zIndex: 1051,
          overflow: 'hidden',
        }}
      >
        {/* Scoped theme CSS */}
        <style>{isDark ? getDarkThemeCSS() : getLightThemeCSS()}</style>

        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '12px 16px',
            borderBottom: `1px solid ${tokens.border.default}`,
            gap: 12,
          }}
        >
          <Text strong style={{ fontSize: 14, flex: 1 }}>
            {t('tasks.gantt.title')}
          </Text>
          <div style={{ display: 'flex', gap: 4 }}>
            {viewModes.map((vm) => (
              <Button
                key={vm.key}
                type={viewMode === vm.key ? 'primary' : 'text'}
                size="small"
                onClick={() => setViewMode(vm.key)}
                style={{ fontSize: 12 }}
              >
                {vm.label}
              </Button>
            ))}
          </div>
          <Button
            type="text"
            size="small"
            icon={<CloseOutlined />}
            onClick={onClose}
          />
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: 'auto', padding: 16, minHeight: 200 }}>
          {bars.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0' }}>
              <Text type="secondary">{t('tasks.gantt.noTasks')}</Text>
            </div>
          ) : (
            <div ref={containerRef} />
          )}
        </div>

        {/* Footer */}
        {bars.length > 0 && (
          <div
            style={{
              padding: '8px 16px',
              borderTop: `1px solid ${tokens.border.default}`,
              textAlign: 'right',
            }}
          >
            <Text type="secondary" style={{ fontSize: 11 }}>
              {t('tasks.gantt.taskCount', { count: bars.length })}
            </Text>
          </div>
        )}
      </div>
    </>
  );
}
