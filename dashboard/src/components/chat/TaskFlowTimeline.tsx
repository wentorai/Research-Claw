import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  MinusCircleOutlined,
} from '@ant-design/icons';

import { useTaskFlowStore } from '../../stores/task-flow';
import { useChatStore } from '../../stores/chat';
import { useGatewayStore } from '../../stores/gateway';
import { selectSessionRunView, useSessionRunsStore } from '../../stores/session-runs';
import {
  isTaskFlowVisible,
  type TaskFlowStage,
} from '../../utils/task-flow';
import {
  resolveRunStatusPresentation,
  type RunStatusPresentation,
} from '../../utils/run-status-presentation';

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

function runStatusIcon(presentation: RunStatusPresentation) {
  if (presentation.spins) {
    return <LoadingOutlined spin style={{ color: '#f59e0b', fontSize: 13 }} />;
  }
  if (presentation.kind === 'done') {
    return <CheckCircleOutlined style={{ color: '#22c55e', fontSize: 13 }} />;
  }
  if (presentation.kind === 'failed' || presentation.kind === 'timeout') {
    return <CloseCircleOutlined style={{ color: '#ef4444', fontSize: 13 }} />;
  }
  return <MinusCircleOutlined style={{ color: 'var(--text-tertiary)', fontSize: 13 }} />;
}

function resolveStageDetail(stage: TaskFlowStage, t: (key: string) => string): string | null {
  if (stage.detail === '__compacting__') return t('taskFlow.compactingDetail');
  return stage.detail;
}

export default function TaskFlowTimeline() {
  const { t } = useTranslation();
  const flow = useTaskFlowStore((s) => s.flow);
  const sessionKey = useChatStore((s) => s.sessionKey);
  const transport = useGatewayStore((s) => s.state);
  const sessionRun = useSessionRunsStore(useShallow((s) => selectSessionRunView(s, sessionKey)));
  const hasRunContext = isTaskFlowVisible(flow)
    || sessionRun.isBusy
    || sessionRun.needsResultConfirmation;
  const presentation = hasRunContext
    ? resolveRunStatusPresentation(sessionRun, transport)
    : null;
  const explicitFlowVisible = isTaskFlowVisible(flow) && flow?.mode === 'explicit';

  if (!presentation && !explicitFlowVisible) return null;
  const activityLabel = presentation?.activityLabel ?? t('taskFlow.runStatus.tool.fallback');

  return (
    <div className="task-flow-timeline" role="status" aria-live="polite">
      <div className="task-flow-header">
        <span className="task-flow-title">
          {presentation && <span className="task-flow-run-icon">{runStatusIcon(presentation)}</span>}
          {presentation
            ? t(`taskFlow.runStatus.${presentation.kind}.title`, { tool: activityLabel })
            : t('taskFlow.title')}
        </span>
      </div>
      {presentation && (
        <div className="task-flow-run-detail">
          {t(`taskFlow.runStatus.${presentation.kind}.detail`, { tool: activityLabel })}
        </div>
      )}
      {explicitFlowVisible && (
        <ol className="task-flow-steps">
          {flow!.stages.map((stage, index) => {
            const detail = resolveStageDetail(stage, t);
            const isActive = stage.status === 'active' || stage.status === 'error';
            return (
              <li
                key={`${stage.id}-${index}`}
                className={`task-flow-step is-${stage.status}${isActive ? ' is-current' : ''}`}
              >
                <span className="task-flow-step-icon">{stageIcon(stage.status)}</span>
                <span className="task-flow-step-body">
                  <span className="task-flow-step-label">{stage.label}</span>
                  {detail && isActive && (
                    <span className="task-flow-step-detail">{detail}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
