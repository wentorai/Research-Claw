/**
 * Generic staged task flow — inferred coarse steps plus agent-reported stages via task_flow_stage.
 */

export const TASK_FLOW_STAGE_TOOL = 'task_flow_stage';

export const INFERRED_STAGE_IDS = ['understand', 'execute', 'respond'] as const;
export type InferredStageId = typeof INFERRED_STAGE_IDS[number];

export type TaskFlowStageStatus = 'pending' | 'active' | 'done' | 'error';

export interface TaskFlowStage {
  id: string;
  label: string;
  status: TaskFlowStageStatus;
  detail: string | null;
}

export type TaskFlowMode = 'inferred' | 'explicit';

export interface TaskFlowSnapshot {
  runId: string;
  sessionKey: string;
  anchorUserTimestamp?: number;
  anchorUserText?: string;
  anchorIdempotencyKey?: string;
  mode: TaskFlowMode;
  stages: TaskFlowStage[];
  activeIndex: number;
  startedAtMs: number;
  lastUpdateMs: number;
  currentTool: string | null;
}

export interface TaskFlowStageReport {
  label: string;
  status: 'start' | 'progress' | 'done' | 'error';
  step?: number;
  total?: number;
  detail?: string;
}

function slugId(label: string, index: number): string {
  const base = label.trim().toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '');
  return base ? `${base}-${index}` : `stage-${index + 1}`;
}

export function createInferredTaskFlow(
  runId: string,
  sessionKey: string,
  now = Date.now(),
  anchor?: {
    userTimestamp?: number;
    userText?: string;
    idempotencyKey?: string;
  },
): TaskFlowSnapshot {
  return {
    runId,
    sessionKey,
    anchorUserTimestamp: anchor?.userTimestamp,
    anchorUserText: anchor?.userText,
    anchorIdempotencyKey: anchor?.idempotencyKey,
    mode: 'inferred',
    stages: INFERRED_STAGE_IDS.map((id, index) => ({
      id,
      label: id,
      status: index === 0 ? 'active' : 'pending',
      detail: null,
    })),
    activeIndex: 0,
    startedAtMs: now,
    lastUpdateMs: now,
    currentTool: null,
  };
}

function markStageDone(stage: TaskFlowStage): TaskFlowStage {
  return stage.status === 'error' ? stage : { ...stage, status: 'done', detail: null };
}

function activateStage(stage: TaskFlowStage, detail?: string | null): TaskFlowStage {
  return {
    ...stage,
    status: 'active',
    detail: detail ?? stage.detail,
  };
}

export function advanceInferredOnToolStart(
  flow: TaskFlowSnapshot,
  toolName: string,
  now = Date.now(),
): TaskFlowSnapshot {
  if (flow.mode !== 'inferred' || toolName === TASK_FLOW_STAGE_TOOL) return flow;

  const stages = flow.stages.map((s, i) => {
    if (i < 1) return markStageDone(s);
    if (i === 1) return activateStage(s, toolName);
    return s;
  });

  return {
    ...flow,
    stages,
    activeIndex: 1,
    currentTool: toolName,
    lastUpdateMs: now,
  };
}

export function advanceInferredOnStreamText(flow: TaskFlowSnapshot, now = Date.now()): TaskFlowSnapshot {
  if (flow.mode !== 'inferred') return flow;

  const stages = flow.stages.map((s, i) => {
    if (i < 2) return markStageDone(s);
    if (i === 2) return activateStage(s);
    return s;
  });

  return {
    ...flow,
    stages,
    activeIndex: 2,
    currentTool: null,
    lastUpdateMs: now,
  };
}

export function updateInferredExecuteDetail(
  flow: TaskFlowSnapshot,
  toolName: string,
  now = Date.now(),
): TaskFlowSnapshot {
  if (flow.mode !== 'inferred' || flow.activeIndex !== 1) return flow;
  const stages = flow.stages.map((s, i) =>
    i === 1 ? { ...s, detail: toolName } : s,
  );
  return { ...flow, stages, currentTool: toolName, lastUpdateMs: now };
}

function ensureExplicitStages(
  stages: TaskFlowStage[],
  step: number | undefined,
  total: number | undefined,
  label: string,
): TaskFlowStage[] {
  const targetTotal = total ?? Math.max(stages.length, step ?? stages.length + 1);
  const next = [...stages];
  while (next.length < targetTotal) {
    next.push({
      id: slugId(`step-${next.length + 1}`, next.length),
      label: `step-${next.length + 1}`,
      status: 'pending',
      detail: null,
    });
  }
  const index = step != null ? step - 1 : Math.max(0, next.length - 1);
  if (index >= 0 && index < next.length) {
    next[index] = {
      ...next[index],
      id: slugId(label, index),
      label,
    };
  }
  return next;
}

export function applyExplicitStageReport(
  flow: TaskFlowSnapshot,
  report: TaskFlowStageReport,
  now = Date.now(),
): TaskFlowSnapshot {
  let stages = flow.mode === 'inferred' ? [] as TaskFlowStage[] : [...flow.stages];
  stages = ensureExplicitStages(stages, report.step, report.total, report.label);

  const index = report.step != null
    ? report.step - 1
    : stages.findIndex((s) => s.label === report.label);
  const resolvedIndex = index >= 0 ? index : stages.length - 1;

  if (report.status === 'start') {
    stages = stages.map((s, i) => {
      if (i < resolvedIndex) return markStageDone(s);
      if (i === resolvedIndex) return activateStage({ ...s, label: report.label }, report.detail ?? null);
      return { ...s, status: 'pending', detail: null };
    });
  } else if (report.status === 'progress') {
    stages = stages.map((s, i) =>
      i === resolvedIndex
        ? { ...s, label: report.label, status: 'active', detail: report.detail ?? s.detail }
        : s,
    );
  } else if (report.status === 'done') {
    stages = stages.map((s, i) => {
      if (i === resolvedIndex) return { ...s, label: report.label, status: 'done', detail: null };
      return s;
    });
  } else if (report.status === 'error') {
    stages = stages.map((s, i) =>
      i === resolvedIndex
        ? { ...s, label: report.label, status: 'error', detail: report.detail ?? s.detail }
        : s,
    );
  }

  const activeIndex = stages.findIndex((s) => s.status === 'active' || s.status === 'error');
  return {
    ...flow,
    mode: 'explicit',
    stages,
    activeIndex: activeIndex >= 0 ? activeIndex : resolvedIndex,
    currentTool: null,
    lastUpdateMs: now,
  };
}

export function finishTaskFlow(
  flow: TaskFlowSnapshot,
  outcome: 'done' | 'error',
  now = Date.now(),
): TaskFlowSnapshot {
  const stages = flow.stages.map((s) => {
    if (s.status === 'done' || s.status === 'error') return s;
    if (outcome === 'error' && s.status === 'active') return { ...s, status: 'error' as const };
    if (outcome === 'done') return markStageDone(s);
    return s;
  });
  return {
    ...flow,
    stages,
    activeIndex: -1,
    currentTool: null,
    lastUpdateMs: now,
  };
}

export function parseTaskFlowStageReport(value: unknown): TaskFlowStageReport | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.label !== 'string' || !obj.label.trim()) return null;
  const status = obj.status;
  if (status !== 'start' && status !== 'progress' && status !== 'done' && status !== 'error') return null;
  const step = typeof obj.step === 'number' && Number.isFinite(obj.step)
    ? Math.max(1, Math.floor(obj.step))
    : undefined;
  const total = typeof obj.total === 'number' && Number.isFinite(obj.total)
    ? Math.max(1, Math.floor(obj.total))
    : undefined;
  const detail = typeof obj.detail === 'string' && obj.detail.trim() ? obj.detail.trim() : undefined;
  return { label: obj.label.trim(), status, step, total, detail };
}

export function parseTaskFlowStageFromToolData(
  data: Record<string, unknown> | undefined,
): TaskFlowStageReport | null {
  if (!data) return null;
  const raw = data.args ?? data.input ?? data.parameters ?? data.params ?? data;
  if (typeof raw === 'string') {
    try {
      return parseTaskFlowStageReport(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  return parseTaskFlowStageReport(raw);
}

export function isTaskFlowVisible(flow: TaskFlowSnapshot | null): boolean {
  return Boolean(flow && flow.stages.length > 0);
}
