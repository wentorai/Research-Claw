import { create } from 'zustand';
import { useGatewayStore } from './gateway';

export interface ExecutionSummary {
  toolCount: number;
  errorCount: number;
  skillCount: number;
}

export interface ExecutionDetail {
  runId: string;
  tools: Array<{
    id: string;
    tool_name: string;
    status: 'invoked' | 'completed' | 'error';
    duration_ms: number | null;
    error: string | null;
  }>;
  skills: Array<{
    id: string;
    skill_key?: string;
    skill_name: string;
    activation: 'read' | 'command';
    skill_source: string;
  }>;
  skillEvents?: Array<{
    id: string;
    skill_key: string;
    skill_name: string;
    skill_source: string;
    lifecycle: 'candidate' | 'selected' | 'loaded' | 'executed';
    activation: 'read' | 'command' | null;
    tool_call_id: string | null;
    observed_at: number;
  }>;
  reviews?: Array<{
    reviewId: string;
    state: string;
    verdict: string;
    findings: unknown[];
  }>;
}

interface ExecutionTraceState {
  summaries: Record<string, ExecutionSummary>;
  details: Record<string, ExecutionDetail>;
  loadSummaries: (runIds: string[]) => Promise<void>;
  loadDetail: (runId: string) => Promise<void>;
}

export const useExecutionTraceStore = create<ExecutionTraceState>()((set) => ({
  summaries: {},
  details: {},

  loadSummaries: async (runIds) => {
    const unique = [...new Set(runIds.filter(Boolean))].slice(0, 100);
    if (unique.length === 0) return;
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    const result = await client.request<{ summaries: Record<string, ExecutionSummary> }>(
      'rc.execution.summary',
      { runIds: unique },
    );
    set((state) => ({ summaries: { ...state.summaries, ...result.summaries } }));
  },

  loadDetail: async (runId) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    const [execution, reviewResult] = await Promise.all([
      client.request<Omit<ExecutionDetail, 'reviews'>>('rc.execution.detail', { runId }),
      client.request<{ reviews: ExecutionDetail['reviews'] }>(
        'rc.supervisor.reviews.list',
        { runId, limit: 20 },
      ).catch(() => ({ reviews: [] })),
    ]);
    set((state) => ({
      details: {
        ...state.details,
        [runId]: { ...execution, reviews: reviewResult.reviews ?? [] },
      },
    }));
  },
}));
