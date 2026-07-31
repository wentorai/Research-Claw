import { create } from 'zustand';
import { useGatewayStore } from './gateway';
import { toGatewaySessionKey } from '../utils/session-key';

export interface ExecutionSummary {
  toolCount: number;
  errorCount: number;
  skillCount: number;
}

export interface PresentationFile {
  type: 'file';
  operation: 'workspace_save' | 'workspace_export' | 'workspace_append' | 'workspace_download';
  name: string;
  path: string;
  sizeBytes: number;
  mimeType: string;
  gitStatus: 'new' | 'committed';
}

export interface RunPresentation {
  runId: string;
  recordsRevision: number;
  files: PresentationFile[];
  paperBatches: unknown[];
  paperCandidates?: PaperCandidateGroup;
}

export interface PaperCandidate {
  candidateId: string;
  provider: string;
  providerId?: string;
  returnIndex: number;
  source: string;
  sourceId?: string;
  strongAliases: string[];
  actionable: boolean;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  doi?: string;
  arxivId?: string;
  url?: string;
  pdfUrl?: string;
  abstractPreview?: string;
  citationCount?: number;
  libraryId?: string;
  sources?: string[];
  sourcePositions?: Array<{ provider: string; returnIndex: number }>;
  conflictingFields?: string[];
}

export interface PaperCandidateGroup {
  semantic: 'retrieved';
  label: '检索结果·尚未筛选';
  queries: string[];
  queryUnavailable: boolean;
  hasAvailableResults: boolean;
  providers: string[];
  partialProviders: string[];
  unavailableProviders: string[];
  matchedTotal?: number;
  returned: number;
  eligible: number;
  stored: number;
  unique: number;
  shown: number;
  candidates: PaperCandidate[];
}

export type FileAvailability = 'present' | 'deleted' | 'missing' | 'blocked' | 'unknown';

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

export function executionKey(sessionKey: string, runId: string): string {
  return `${sessionKey}\0${runId}`;
}

function fileKey(sessionKey: string, filePath: string): string {
  return `${sessionKey}\0${filePath}`;
}

function chunksOf<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

const PRESENTATION_RETRY_DELAYS_MS = [100, 500, 1_500] as const;
const presentationRetryTimers = new Map<string, Array<ReturnType<typeof setTimeout>>>();

function presentationRetryKey(sessionKey: string, runId: string, toolCallId: string): string {
  return `${sessionKey}\0${runId}\0${toolCallId}`;
}

function clearPresentationRetry(key: string): void {
  const timers = presentationRetryTimers.get(key) ?? [];
  for (const timer of timers) clearTimeout(timer);
  presentationRetryTimers.delete(key);
}

export function resetPresentationRetryCoordinatorForTests(): void {
  for (const key of presentationRetryTimers.keys()) clearPresentationRetry(key);
}

interface ExecutionTraceState {
  activeSessionKey: string | null;
  generation: number;
  summaries: Record<string, ExecutionSummary>;
  details: Record<string, ExecutionDetail>;
  presentations: Record<string, RunPresentation>;
  availability: Record<string, FileAvailability>;
  activateSession: (sessionKey: string) => void;
  loadRuns: (sessionKey: string, runIds: string[]) => Promise<void>;
  refreshPresentations: (sessionKey: string, runIds: string[]) => Promise<void>;
  schedulePresentationRefresh: (sessionKey: string, runId: string, toolCallId: string) => void;
  loadAvailability: (sessionKey: string, files: PresentationFile[]) => Promise<void>;
  loadDetail: (sessionKey: string, runId: string) => Promise<void>;
}

function isCurrent(sessionKey: string, generation: number): boolean {
  const state = useExecutionTraceStore.getState();
  return state.activeSessionKey === sessionKey && state.generation === generation;
}

export const useExecutionTraceStore = create<ExecutionTraceState>()((set, get) => ({
  activeSessionKey: null,
  generation: 0,
  summaries: {},
  details: {},
  presentations: {},
  availability: {},

  activateSession: (sessionKey) => {
    if (get().activeSessionKey === sessionKey) return;
    set((state) => ({ activeSessionKey: sessionKey, generation: state.generation + 1 }));
  },

  loadRuns: async (sessionKey, runIds) => {
    get().activateSession(sessionKey);
    const generation = get().generation;
    const unique = [...new Set(runIds.filter(Boolean))];
    if (unique.length === 0) return;
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    const canonicalSessionKey = toGatewaySessionKey(sessionKey);
    await Promise.all(chunksOf(unique, 100).map(async (runIdBatch) => {
      const [summaryResult, presentationResult] = await Promise.allSettled([
        client.request<{ summaries: Record<string, ExecutionSummary> }>(
          'rc.execution.summary', { sessionKey: canonicalSessionKey, runIds: runIdBatch },
        ).catch(() => client.request<{ summaries: Record<string, ExecutionSummary> }>(
          'rc.execution.summary', { runIds: runIdBatch },
        )),
        client.request<{ presentations: Record<string, RunPresentation> }>(
          'rc.execution.presentations', { sessionKey: canonicalSessionKey, runIds: runIdBatch },
        ),
      ]);
      if (!isCurrent(sessionKey, generation)) return;
      set((state) => {
        const summaries = { ...state.summaries };
        const presentations = { ...state.presentations };
        if (summaryResult.status === 'fulfilled') {
          for (const [runId, summary] of Object.entries(summaryResult.value.summaries)) {
            summaries[executionKey(sessionKey, runId)] = summary;
          }
        }
        if (presentationResult.status === 'fulfilled') {
          for (const [runId, presentation] of Object.entries(presentationResult.value.presentations)) {
            presentations[executionKey(sessionKey, runId)] = presentation;
          }
        }
        return { summaries, presentations };
      });
    }));
  },

  refreshPresentations: async (sessionKey, runIds) => {
    get().activateSession(sessionKey);
    const generation = get().generation;
    const unique = [...new Set(runIds.filter(Boolean))];
    if (unique.length === 0) return;
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    const canonicalSessionKey = toGatewaySessionKey(sessionKey);
    await Promise.all(chunksOf(unique, 100).map(async (runIdBatch) => {
      try {
        const result = await client.request<{ presentations: Record<string, RunPresentation> }>(
          'rc.execution.presentations', { sessionKey: canonicalSessionKey, runIds: runIdBatch },
        );
        if (!isCurrent(sessionKey, generation)) return;
        set((state) => {
          const presentations = { ...state.presentations };
          for (const [runId, presentation] of Object.entries(result.presentations)) {
            presentations[executionKey(sessionKey, runId)] = presentation;
          }
          return { presentations };
        });
      } catch {
        // Summary/details remain usable when a pre-v23 gateway has no method.
      }
    }));
  },

  schedulePresentationRefresh: (sessionKey, runId, toolCallId) => {
    if (!sessionKey || !runId || !toolCallId || get().activeSessionKey !== sessionKey) return;
    const key = presentationRetryKey(sessionKey, runId, toolCallId);
    if (presentationRetryTimers.has(key)) return;
    const baselineRevision = get().presentations[executionKey(sessionKey, runId)]?.recordsRevision ?? 0;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    presentationRetryTimers.set(key, timers);

    for (const [index, delay] of PRESENTATION_RETRY_DELAYS_MS.entries()) {
      timers.push(setTimeout(() => {
        void (async () => {
          if (get().activeSessionKey !== sessionKey) {
            clearPresentationRetry(key);
            return;
          }
          await get().refreshPresentations(sessionKey, [runId]);
          const revision = get().presentations[executionKey(sessionKey, runId)]?.recordsRevision ?? 0;
          if (revision > baselineRevision || index === PRESENTATION_RETRY_DELAYS_MS.length - 1) {
            clearPresentationRetry(key);
          }
        })();
      }, delay));
    }
  },

  loadAvailability: async (sessionKey, files) => {
    if (files.length === 0) return;
    const generation = get().generation;
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    try {
      const result = await client.request<{
        files: Array<{ path: string; status: FileAvailability }>;
      }>('rc.ws.availability', {
        files: files.slice(0, 100).map((file) => ({ path: file.path, expected: true })),
      });
      if (!isCurrent(sessionKey, generation)) return;
      set((state) => ({
        availability: {
          ...state.availability,
          ...Object.fromEntries(result.files.map((file) => [fileKey(sessionKey, file.path), file.status])),
        },
      }));
    } catch {
      if (!isCurrent(sessionKey, generation)) return;
      set((state) => ({
        availability: {
          ...state.availability,
          ...Object.fromEntries(files.map((file) => [fileKey(sessionKey, file.path), 'unknown' as const])),
        },
      }));
    }
  },

  loadDetail: async (sessionKey, runId) => {
    get().activateSession(sessionKey);
    const generation = get().generation;
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    const [execution, reviewResult] = await Promise.all([
      client.request<Omit<ExecutionDetail, 'reviews'>>(
        'rc.execution.detail', { sessionKey: toGatewaySessionKey(sessionKey), runId },
      ).catch(() => client.request<Omit<ExecutionDetail, 'reviews'>>(
        'rc.execution.detail', { runId },
      )),
      client.request<{ reviews: ExecutionDetail['reviews'] }>(
        'rc.supervisor.reviews.list', { runId, limit: 20 },
      ).catch(() => ({ reviews: [] })),
    ]);
    if (!isCurrent(sessionKey, generation)) return;
    set((state) => ({
      details: {
        ...state.details,
        [executionKey(sessionKey, runId)]: { ...execution, reviews: reviewResult.reviews ?? [] },
      },
    }));
  },
}));

export function selectFileAvailability(
  state: Pick<ExecutionTraceState, 'availability'>,
  sessionKey: string,
  filePath: string,
): FileAvailability | undefined {
  return state.availability[fileKey(sessionKey, filePath)];
}
