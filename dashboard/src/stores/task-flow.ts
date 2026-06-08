import { create } from 'zustand';

import { normalizeSessionKey } from '../utils/session-key';
import {
  TASK_FLOW_STAGE_TOOL,
  advanceInferredOnStreamText,
  advanceInferredOnToolStart,
  applyExplicitStageReport,
  createInferredTaskFlow,
  finishTaskFlow,
  parseTaskFlowStageFromToolData,
  updateInferredExecuteDetail,
  type TaskFlowSnapshot,
} from '../utils/task-flow';

interface TaskFlowState {
  flow: TaskFlowSnapshot | null;
  tickMs: number;

  startRun: (
    runId: string,
    sessionKey: string,
    anchor?: { userTimestamp?: number; userText?: string; idempotencyKey?: string },
  ) => void;
  endRun: (runId: string | null | undefined, outcome: 'done' | 'error' | 'clear') => void;
  handleToolEvent: (payload: {
    runId?: string;
    sessionKey?: string;
    stream?: string;
    data?: Record<string, unknown>;
  }, activeSessionKey: string, chatRunId: string | null) => void;
  handleStreamText: (runId: string | null | undefined, hasText: boolean) => void;
  handleCompaction: (active: boolean) => void;
  tick: () => void;
  clear: () => void;
}

export const useTaskFlowStore = create<TaskFlowState>()((set, get) => ({
  flow: null,
  tickMs: Date.now(),

  startRun: (runId, sessionKey, anchor) => {
    set({
      flow: createInferredTaskFlow(runId, normalizeSessionKey(sessionKey), Date.now(), anchor),
      tickMs: Date.now(),
    });
  },

  endRun: (runId, outcome) => {
    const flow = get().flow;
    if (!flow) return;
    if (runId && flow.runId !== runId) return;
    if (outcome === 'clear') {
      set({ flow: null });
      return;
    }
    set({ flow: finishTaskFlow(flow, outcome) });
    window.setTimeout(() => {
      if (get().flow?.runId === flow.runId) {
        set({ flow: null });
      }
    }, outcome === 'error' ? 12_000 : 4_000);
  },

  handleToolEvent: (payload, activeSessionKey, chatRunId) => {
    if (!payload.runId || payload.stream !== 'tool' || !payload.data?.phase) return;
    const flow = get().flow;
    if (!flow || flow.runId !== payload.runId) return;

    const eventSession = normalizeSessionKey(payload.sessionKey ?? flow.sessionKey);
    if (eventSession !== normalizeSessionKey(activeSessionKey)) return;
    if (chatRunId && payload.runId !== chatRunId) return;

    const phase = payload.data.phase;
    const toolName = String(payload.data.name ?? payload.data.toolName ?? 'unknown');

    if (toolName === TASK_FLOW_STAGE_TOOL && (phase === 'start' || phase === 'running')) {
      const report = parseTaskFlowStageFromToolData(payload.data);
      if (report) {
        set({ flow: applyExplicitStageReport(flow, report), tickMs: Date.now() });
      }
      return;
    }

    if (phase === 'start' || phase === 'running') {
      let next = advanceInferredOnToolStart(flow, toolName);
      if (next.activeIndex === 1) {
        next = updateInferredExecuteDetail(next, toolName);
      }
      set({ flow: next, tickMs: Date.now() });
    }
  },

  handleStreamText: (runId, hasText) => {
    if (!hasText) return;
    const flow = get().flow;
    if (!flow || (runId && flow.runId !== runId)) return;
    set({ flow: advanceInferredOnStreamText(flow), tickMs: Date.now() });
  },

  handleCompaction: (active) => {
    const flow = get().flow;
    if (!flow) return;
    const stages = flow.stages.map((s, i) =>
      i === flow.activeIndex && s.status === 'active'
        ? { ...s, detail: active ? '__compacting__' : s.detail === '__compacting__' ? null : s.detail }
        : s,
    );
    set({ flow: { ...flow, stages, lastUpdateMs: Date.now() }, tickMs: Date.now() });
  },

  tick: () => set({ tickMs: Date.now() }),

  clear: () => set({ flow: null }),
}));
