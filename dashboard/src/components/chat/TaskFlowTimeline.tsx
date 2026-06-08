import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  MinusCircleOutlined,
} from '@ant-design/icons';

import { useTaskFlowStore } from '../../stores/task-flow';
import {
  INFERRED_STAGE_IDS,
  isTaskFlowVisible,
  type InferredStageId,
  type TaskFlowStage,
} from '../../utils/task-flow';

function stageIcon(status: TaskFlowStage['status']) {
  switch (status) {
    case 'done':
      return <CheckCircleOutlined style={{ color: '#22c55e', fontSize: 13 }} />;
    case 'error':
      return <CloseCircleOutlined style={{ color: '#ef4444', fontSize: 13 }} />;
    case 'active':
      return <LoadingOutlined spin style={{ color: '#f59e0b', fontSize: 13 }} />;
    default:
      return <MinusCircleOutlined style={{ color: 'var(--text-tertiary)', fontSize: 13 }} />;
  }
}

function resolveStageLabel(
  stage: TaskFlowStage,
  mode: 'inferred' | 'explicit',
  t: (key: string) => string,
): string {
  if (mode === 'inferred' && INFERRED_STAGE_IDS.includes(stage.id as InferredStageId)) {
    return t(`taskFlow.stages.${stage.id}`);
  }
  return stage.label;
}

function resolveStageDetail(stage: TaskFlowStage, t: (key: string) => string): string | null {
  if (stage.detail === '__compacting__') return t('taskFlow.compactingDetail');
  return stage.detail;
}

export default function TaskFlowTimeline() {
  const { t } = useTranslation();
  const flow = useTaskFlowStore((s) => s.flow);
  const tickMs = useTaskFlowStore((s) => s.tickMs);
  const tick = useTaskFlowStore((s) => s.tick);

  useEffect(() => {
    if (!flow || flow.activeIndex < 0) return;
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [flow?.runId, flow?.activeIndex, tick]);

  if (!isTaskFlowVisible(flow)) return null;

  const elapsedSec = Math.max(0, Math.floor((tickMs - flow!.startedAtMs) / 1000));
  const activeStage = flow!.stages.find((s) => s.status === 'active' || s.status === 'error');

  return (
    <div className="task-flow-timeline" role="status" aria-live="polite">
      <div className="task-flow-header">
        <span className="task-flow-title">{t('taskFlow.title')}</span>
        <span className="task-flow-elapsed">{t('taskFlow.elapsed', { seconds: elapsedSec })}</span>
      </div>
      <ol className="task-flow-steps">
        {flow!.stages.map((stage, index) => {
          const label = resolveStageLabel(stage, flow!.mode, t);
          const detail = resolveStageDetail(stage, t);
          const isActive = stage.status === 'active' || stage.status === 'error';
          return (
            <li
              key={`${stage.id}-${index}`}
              className={`task-flow-step is-${stage.status}${isActive ? ' is-current' : ''}`}
            >
              <span className="task-flow-step-icon">{stageIcon(stage.status)}</span>
              <span className="task-flow-step-body">
                <span className="task-flow-step-label">{label}</span>
                {detail && isActive && (
                  <span className="task-flow-step-detail">{detail}</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {activeStage?.status === 'active' && elapsedSec >= 12 && !activeStage.detail && (
        <div className="task-flow-heartbeat">{t('taskFlow.stillWorking')}</div>
      )}
    </div>
  );
}
