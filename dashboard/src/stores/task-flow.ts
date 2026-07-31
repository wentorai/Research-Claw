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
  flows: Record<string, TaskFlowSnapshot>;
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
  handleCompaction: (active: boolean, sessionKey?: string) => void;
  tick: () => void;
  clear: (sessionKey?: string) => void;
}

export function selectTaskFlow(
  state: Pick<TaskFlowState, 'flows'>,
  sessionKey: string,
): TaskFlowSnapshot | null {
  return state.flows[normalizeSessionKey(sessionKey)] ?? null;
}

function findFlowEntry(
  flows: Record<string, TaskFlowSnapshot>,
  runId: string | null | undefined,
): [string, TaskFlowSnapshot] | null {
  if (!runId) return null;
  return Object.entries(flows).find(([, flow]) => flow.runId === runId) ?? null;
}

export const useTaskFlowStore = create<TaskFlowState>()((set, get) => ({
  flows: {},
  tickMs: Date.now(),

  startRun: (runId, sessionKey, anchor) => {
    const key = normalizeSessionKey(sessionKey);
    set((state) => ({
      flows: {
        ...state.flows,
        [key]: createInferredTaskFlow(runId, key, Date.now(), anchor),
      },
      tickMs: Date.now(),
    }));
  },

  endRun: (runId, outcome) => {
    const entry = findFlowEntry(get().flows, runId);
    if (!entry) return;
    const [sessionKey, flow] = entry;
    if (outcome === 'clear') {
      set((state) => {
        const flows = { ...state.flows };
        delete flows[sessionKey];
        return { flows };
      });
      return;
    }
    set((state) => ({
      flows: {
        ...state.flows,
        [sessionKey]: finishTaskFlow(flow, outcome),
      },
    }));
    window.setTimeout(() => {
      if (get().flows[sessionKey]?.runId === flow.runId) {
        set((state) => {
          const flows = { ...state.flows };
          delete flows[sessionKey];
          return { flows };
        });
      }
    }, outcome === 'error' ? 12_000 : 4_000);
  },

  handleToolEvent: (payload, activeSessionKey, chatRunId) => {
    if (!payload.runId || payload.stream !== 'tool' || !payload.data?.phase) return;
    const eventSession = normalizeSessionKey(payload.sessionKey ?? activeSessionKey);
    const flow = get().flows[eventSession];
    if (!flow || flow.runId !== payload.runId) return;

    if (
      eventSession === normalizeSessionKey(activeSessionKey)
      && chatRunId
      && payload.runId !== chatRunId
    ) return;

    const phase = payload.data.phase;
    const toolName = String(payload.data.name ?? payload.data.toolName ?? 'unknown');

    if (toolName === TASK_FLOW_STAGE_TOOL && (phase === 'start' || phase === 'running')) {
      const report = parseTaskFlowStageFromToolData(payload.data);
      if (report) {
        set((state) => ({
          flows: {
            ...state.flows,
            [eventSession]: applyExplicitStageReport(flow, report),
          },
          tickMs: Date.now(),
        }));
      }
      return;
    }

    if (phase === 'start' || phase === 'running') {
      let next = advanceInferredOnToolStart(flow, toolName);
      if (next.activeIndex === 1) {
        next = updateInferredExecuteDetail(next, toolName);
      }
      set((state) => ({
        flows: { ...state.flows, [eventSession]: next },
        tickMs: Date.now(),
      }));
    }
  },

  handleStreamText: (runId, hasText) => {
    if (!hasText) return;
    const entry = findFlowEntry(get().flows, runId);
    if (!entry) return;
    const [sessionKey, flow] = entry;
    set((state) => ({
      flows: {
        ...state.flows,
        [sessionKey]: advanceInferredOnStreamText(flow),
      },
      tickMs: Date.now(),
    }));
  },

  handleCompaction: (active, rawSessionKey) => {
    if (!rawSessionKey) return;
    const sessionKey = normalizeSessionKey(rawSessionKey);
    const flow = get().flows[sessionKey];
    if (!flow) return;
    const stages = flow.stages.map((s, i) =>
      i === flow.activeIndex && s.status === 'active'
        ? { ...s, detail: active ? '__compacting__' : s.detail === '__compacting__' ? null : s.detail }
        : s,
    );
    set((state) => ({
      flows: {
        ...state.flows,
        [sessionKey]: { ...flow, stages, lastUpdateMs: Date.now() },
      },
      tickMs: Date.now(),
    }));
  },

  tick: () => set({ tickMs: Date.now() }),

  clear: (rawSessionKey) => {
    if (!rawSessionKey) {
      set({ flows: {} });
      return;
    }
    const sessionKey = normalizeSessionKey(rawSessionKey);
    set((state) => {
      const flows = { ...state.flows };
      delete flows[sessionKey];
      return { flows };
    });
  },
}));
