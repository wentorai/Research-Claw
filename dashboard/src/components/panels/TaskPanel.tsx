import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Collapse, Dropdown, Input, Segmented, Switch, Tooltip, Typography } from 'antd';
import { BarChartOutlined, CheckSquareOutlined, RobotOutlined, SearchOutlined, TeamOutlined, UserOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useTasksStore, type Task, type TaskPriority, type TaskType, type TaskWithDetails } from '../../stores/tasks';
import { useGatewayStore } from '../../stores/gateway';
import { useChatStore } from '../../stores/chat';
import { getThemeTokens } from '../../styles/theme';
import { useConfigStore } from '../../stores/config';
import { PRIORITY_COLORS } from '../../utils/task-constants';
import TaskDetailExpand from './TaskDetailExpand';

const GanttModal = React.lazy(() => import('./GanttModal'));

const { Text } = Typography;

const TASK_TYPE_ICONS: Record<TaskType, typeof UserOutlined> = {
  human: UserOutlined,
  agent: RobotOutlined,
  mixed: TeamOutlined,
};

function isOverdue(deadline: string | null): boolean {
  if (!deadline) return false;
  return new Date(deadline) < new Date();
}

function isWithinDays(deadline: string | null, days: number): boolean {
  if (!deadline) return false;
  const d = new Date(deadline);
  const now = new Date();
  const diff = d.getTime() - now.getTime();
  return diff > 0 && diff < days * 24 * 60 * 60 * 1000;
}

function formatDeadline(deadline: string | null, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!deadline) return t('tasks.noDeadline');
  const d = new Date(deadline);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

interface TaskRowProps {
  task: Task;
  tokens: ReturnType<typeof getThemeTokens>;
  perspective: 'all' | 'human' | 'agent';
  isExpanded: boolean;
  onToggleExpand: (id: string) => void;
}

function TaskRow({ task, tokens, perspective, isExpanded, onToggleExpand }: TaskRowProps) {
  const { t } = useTranslation();
  const completeTask = useTasksStore((s) => s.completeTask);
  const reopenTask = useTasksStore((s) => s.reopenTask);
  const updateTask = useTasksStore((s) => s.updateTask);
  const loadTasks = useTasksStore((s) => s.loadTasks);
  const priorityColor = PRIORITY_COLORS[task.priority];
  const overdue = isOverdue(task.deadline);
  const soonDue = isWithinDays(task.deadline, 3);
  const isDone = task.status === 'done' || task.status === 'cancelled';

  const priorityItems = useMemo(() => {
    const levels: TaskPriority[] = ['urgent', 'high', 'medium', 'low'];
    return levels.map((level) => ({
      key: level,
      label: (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: PRIORITY_COLORS[level], display: 'inline-block', flexShrink: 0 }} />
          {t(`tasks.priority.${level}`)}
        </span>
      ),
    }));
  }, [t]);

  const handlePriorityChange = useCallback(
    (e: { key: string }) => {
      const newPriority = e.key as TaskPriority;
      if (newPriority === task.priority) return;
      updateTask(task.id, { priority: newPriority }).then(() => loadTasks());
    },
    [task.id, task.priority, updateTask, loadTasks],
  );

  const handleCheck = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    if (isDone) {
      reopenTask(task.id);
    } else {
      completeTask(task.id);
    }
  };

  const handleClick = () => {
    onToggleExpand(task.id);
  };

  let deadlineColor = tokens.text.muted;
  if (overdue) deadlineColor = '#EF4444';
  else if (soonDue) deadlineColor = '#F59E0B';

  const TypeIcon = TASK_TYPE_ICONS[task.task_type];

  return (
    <div
      onClick={handleClick}
      data-testid={`task-row-${task.id}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 16px 6px 0',
        cursor: 'pointer',
        borderLeft: `3px solid ${priorityColor}`,
        marginLeft: 16,
        paddingLeft: 12,
        transition: 'background 0.15s ease',
        background: isExpanded ? tokens.bg.surfaceHover : 'transparent',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = tokens.bg.surfaceHover;
      }}
      onMouseLeave={(e) => {
        if (!isExpanded) {
          (e.currentTarget as HTMLElement).style.background = 'transparent';
        }
      }}
    >
      <Checkbox
        checked={isDone}
        onChange={handleCheck}
        onClick={(e) => e.stopPropagation()}
        style={{ flexShrink: 0 }}
      />
      <Dropdown
        menu={{ items: priorityItems, onClick: handlePriorityChange }}
        trigger={['click']}
      >
        <span
          onClick={(e) => e.stopPropagation()}
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: priorityColor,
            display: 'inline-block',
            flexShrink: 0,
            cursor: 'pointer',
            transition: 'transform 0.15s ease',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.transform = 'scale(1.3)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.transform = 'scale(1)'; }}
          title={t(`tasks.priority.${task.priority}`)}
        />
      </Dropdown>
      {/* GAP-7: Task type badge in All perspective */}
      {perspective === 'all' && (
        <Tooltip title={t(`tasks.taskType.${task.task_type}`)}>
          <TypeIcon
            data-testid={`task-type-icon-${task.task_type}`}
            style={{ fontSize: 12, color: tokens.text.muted, flexShrink: 0 }}
          />
        </Tooltip>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: isDone ? tokens.text.muted : tokens.text.primary,
            textDecoration: isDone ? 'line-through' : undefined,
          }}
          ellipsis
        >
          {task.title}
        </Text>
      </div>
      <Text style={{ fontSize: 11, color: deadlineColor, flexShrink: 0, fontFamily: "'Fira Code', monospace" }}>
        {formatDeadline(task.deadline, t)}
      </Text>
    </div>
  );
}

function SectionHeader({ title, count, color }: { title: string; count: number; color?: string }) {
  return (
    <div style={{ padding: '8px 16px 4px', display: 'flex', alignItems: 'center', gap: 6 }}>
      <Text strong style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, color }}>
        {title}
      </Text>
      <Text type="secondary" style={{ fontSize: 11 }}>
        ({count})
      </Text>
    </div>
  );
}

export default function TaskPanel() {
  const { t } = useTranslation();
  const theme = useConfigStore((s) => s.theme);
  const tokens = useMemo(() => getThemeTokens(theme), [theme]);

  const tasks = useTasksStore((s) => s.tasks);
  const loading = useTasksStore((s) => s.loading);
  const perspective = useTasksStore((s) => s.perspective);
  const setPerspective = useTasksStore((s) => s.setPerspective);
  const showCompleted = useTasksStore((s) => s.showCompleted);
  const toggleCompleted = useTasksStore((s) => s.toggleCompleted);
  const loadTasks = useTasksStore((s) => s.loadTasks);
  const loadTaskDetail = useTasksStore((s) => s.loadTaskDetail);
  const connState = useGatewayStore((s) => s.state);
  const send = useChatStore((s) => s.send);

  // Gantt modal state
  const [ganttOpen, setGanttOpen] = useState(false);

  // GAP-9: Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setSearchQuery(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        setDebouncedQuery(value);
      }, 300);
    },
    [],
  );

  // GAP-8: Expansion state
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<TaskWithDetails | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const handleToggleExpand = useCallback(
    async (taskId: string) => {
      if (expandedTaskId === taskId) {
        setExpandedTaskId(null);
        setTaskDetail(null);
        return;
      }
      setExpandedTaskId(taskId);
      setTaskDetail(null);
      setDetailLoading(true);
      try {
        const detail = await loadTaskDetail(taskId);
        setTaskDetail(detail);
      } catch {
        // fallback: show task without detail
      }
      setDetailLoading(false);
    },
    [expandedTaskId, loadTaskDetail],
  );

  // GAP-10: Ask Agent handler
  const handleAskAgent = useCallback(
    (detail: TaskWithDetails) => {
      const title = detail.title;
      let prompt: string;

      switch (detail.task_type) {
        case 'agent':
          prompt = t('tasks.askAgent.agentPrompt', { title });
          break;
        case 'human':
          prompt = t('tasks.askAgent.humanPrompt', { title });
          break;
        case 'mixed':
          prompt = t('tasks.askAgent.mixedPrompt', { title });
          break;
      }

      send(prompt);
      setExpandedTaskId(null);
      setTaskDetail(null);
    },
    [send, t],
  );

  // Load tasks when gateway connection is established (or re-established)
  useEffect(() => {
    if (connState === 'connected') {
      console.log('[TaskPanel] connected -> loading tasks');
      loadTasks();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connState]);

  useEffect(() => {
    loadTasks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perspective, showCompleted]);

  // GAP-9: Filter tasks by search query
  const filteredTasks = useMemo(() => {
    if (!debouncedQuery) return tasks;
    const q = debouncedQuery.toLowerCase();
    return tasks.filter(
      (task) =>
        task.title.toLowerCase().includes(q) ||
        (task.description && task.description.toLowerCase().includes(q)),
    );
  }, [tasks, debouncedQuery]);

  // Sort tasks into sections
  const sections = useMemo(() => {
    const now = new Date();
    const overdue: Task[] = [];
    const upcoming: Task[] = [];
    const noDeadline: Task[] = [];
    const completed: Task[] = [];

    for (const task of filteredTasks) {
      if (task.status === 'done' || task.status === 'cancelled') {
        completed.push(task);
      } else if (task.deadline && new Date(task.deadline) < now) {
        overdue.push(task);
      } else if (task.deadline) {
        upcoming.push(task);
      } else {
        noDeadline.push(task);
      }
    }

    // Sort overdue: most overdue first (earliest deadline first)
    overdue.sort((a, b) => new Date(a.deadline!).getTime() - new Date(b.deadline!).getTime());
    // Sort upcoming: soonest first
    upcoming.sort((a, b) => new Date(a.deadline!).getTime() - new Date(b.deadline!).getTime());
    // Sort no deadline: by priority
    const priorityWeight: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
    noDeadline.sort((a, b) => priorityWeight[a.priority] - priorityWeight[b.priority]);
    // Sort completed: most recent first
    completed.sort((a, b) => {
      const aTime = a.completed_at ? new Date(a.completed_at).getTime() : 0;
      const bTime = b.completed_at ? new Date(b.completed_at).getTime() : 0;
      return bTime - aTime;
    });

    return { overdue, upcoming, noDeadline, completed };
  }, [filteredTasks]);

  const activeCount = sections.overdue.length + sections.upcoming.length + sections.noDeadline.length;

  // Render a task row with its optional expanded detail
  const renderTaskWithDetail = (task: Task) => (
    <React.Fragment key={task.id}>
      <TaskRow
        task={task}
        tokens={tokens}
        perspective={perspective}
        isExpanded={expandedTaskId === task.id}
        onToggleExpand={handleToggleExpand}
      />
      {expandedTaskId === task.id && (
        <TaskDetailExpand
          detail={taskDetail}
          loading={detailLoading}
          tokens={tokens}
          onClose={() => {
            setExpandedTaskId(null);
            setTaskDetail(null);
          }}
          onAskAgent={handleAskAgent}
        />
      )}
    </React.Fragment>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Perspective toggle */}
      <div style={{ padding: '8px 16px' }}>
        <Segmented
          value={perspective}
          onChange={(v) => setPerspective(v as 'all' | 'human' | 'agent')}
          options={[
            { label: t('tasks.perspective.all'), value: 'all' },
            { label: t('tasks.perspective.human'), value: 'human' },
            { label: t('tasks.perspective.agent'), value: 'agent' },
          ]}
          block
          size="small"
        />
      </div>

      {/* GAP-9: Search input */}
      <div style={{ padding: '0 16px 8px' }}>
        <Input
          prefix={<SearchOutlined style={{ color: tokens.text.muted }} />}
          placeholder={t('tasks.search')}
          value={searchQuery}
          onChange={handleSearchChange}
          allowClear
          size="small"
          data-testid="task-search-input"
        />
      </div>

      {/* Gantt button + Show completed toggle */}
      <div style={{ padding: '0 16px 8px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
        <Tooltip title={t('tasks.gantt.open')}>
          <Button
            type="text"
            size="small"
            icon={<BarChartOutlined />}
            onClick={() => setGanttOpen(true)}
          />
        </Tooltip>
        <div style={{ flex: 1 }} />
        <Text style={{ fontSize: 12, color: tokens.text.muted }}>{t('tasks.showCompleted')}</Text>
        <Switch size="small" checked={showCompleted} onChange={() => toggleCompleted()} />
      </div>

      {/* Empty state — inside scrollable area so controls remain visible */}
      {!loading && tasks.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', paddingTop: 60 }}>
          <CheckSquareOutlined style={{ fontSize: 48, color: tokens.text.muted, opacity: 0.4 }} />
          <div style={{ marginTop: 16, whiteSpace: 'pre-line' }}>
            <Text type="secondary" style={{ fontSize: 13 }}>
              {t('tasks.empty')}
            </Text>
          </div>
        </div>
      ) : (

      /* Task sections */
      <div style={{ flex: 1, overflow: 'auto' }}>
        {/* Overdue */}
        {sections.overdue.length > 0 && (
          <div>
            <SectionHeader title={t('tasks.overdue')} count={sections.overdue.length} color="#EF4444" />
            {sections.overdue.map(renderTaskWithDetail)}
          </div>
        )}

        {/* Upcoming */}
        {sections.upcoming.length > 0 && (
          <div style={{ marginTop: sections.overdue.length > 0 ? 8 : 0 }}>
            <SectionHeader title={t('tasks.upcoming')} count={sections.upcoming.length} />
            {sections.upcoming.map(renderTaskWithDetail)}
          </div>
        )}

        {/* No Deadline */}
        {sections.noDeadline.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <SectionHeader title={t('tasks.noDeadline')} count={sections.noDeadline.length} />
            {sections.noDeadline.map(renderTaskWithDetail)}
          </div>
        )}

        {/* Completed (collapsible) */}
        {sections.completed.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <Collapse
              ghost
              items={[
                {
                  key: 'completed',
                  label: (
                    <Text type="secondary" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      {t('tasks.completedCount', { count: sections.completed.length })}
                    </Text>
                  ),
                  children: sections.completed.map(renderTaskWithDetail),
                },
              ]}
            />
          </div>
        )}

        {/* No search results */}
        {debouncedQuery && filteredTasks.length === 0 && (
          <div style={{ padding: '24px 16px', textAlign: 'center' }}>
            <Text type="secondary" style={{ fontSize: 13 }}>
              {t('tasks.noResults')}
            </Text>
          </div>
        )}

        {/* No active tasks info */}
        {activeCount === 0 && sections.completed.length > 0 && !debouncedQuery && (
          <div style={{ padding: '24px 16px', textAlign: 'center' }}>
            <Text type="secondary" style={{ fontSize: 13 }}>
              {t('tasks.allDone')}
            </Text>
          </div>
        )}
      </div>
      )}

      {/* Gantt Modal */}
      {ganttOpen && (
        <React.Suspense fallback={null}>
          <GanttModal
            open={ganttOpen}
            tasks={tasks}
            onClose={() => setGanttOpen(false)}
            onTaskClick={(taskId) => {
              setGanttOpen(false);
              handleToggleExpand(taskId);
            }}
          />
        </React.Suspense>
      )}
    </div>
  );
}
