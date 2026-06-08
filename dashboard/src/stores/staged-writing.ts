import { create } from 'zustand';
import i18n from '../i18n';
import { useConfigStore } from './config';
import { useGatewayStore } from './gateway';
import { useUiStore } from './ui';
import {
  STAGED_WRITING_STAGES,
  buildInitialStageStates,
  buildStagedWritingPrompt,
  resolveOutputDir,
} from '../utils/staged-writing-stages';
import { readWorkspaceFileIfReady } from '../utils/workspace-file-poll';
import {
  type StagedWritingJob,
  type StagedWritingStageState,
  WRITING_POLL_MS,
  countCompletedStages,
  formatWritingFailureReason,
  stagePollDeadlineMs,
  uniqueWritingSlug,
} from '../utils/staged-writing-run';

const STORAGE_JOB = 'rc-staged-writing-job';
const WRITING_CRON_EXPR = '0 0 1 1 *';

let pollTimer: ReturnType<typeof setInterval> | null = null;
let orchestrationToken = 0;

function stopPollTimer(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function persistJob(job: StagedWritingJob | null): void {
  try {
    if (job) localStorage.setItem(STORAGE_JOB, JSON.stringify(job));
    else localStorage.removeItem(STORAGE_JOB);
  } catch { /* non-fatal */ }
}

function loadPersistedJob(): StagedWritingJob | null {
  try {
    const raw = localStorage.getItem(STORAGE_JOB);
    if (!raw) return null;
    return JSON.parse(raw) as StagedWritingJob;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface StagedWritingState {
  job: StagedWritingJob | null;
  restored: boolean;

  restoreJob: () => Promise<void>;
  syncStageFiles: () => Promise<void>;
  startJobFromChat: (params: {
    sessionKey: string;
    topic: string;
    slug?: string;
    sourcePaths?: string[];
    venue?: string;
    contextText?: string;
  }) => Promise<boolean>;
  resumeJob: () => Promise<boolean>;
  cancelJob: () => void;
  retryStage: (stageIndex: number) => Promise<boolean>;
  clearJob: () => void;
  openStageFile: (path: string) => void;
}

export const useStagedWritingStore = create<StagedWritingState>((set, get) => {
  const request = (method: string, params?: Record<string, unknown>) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) throw new Error('Gateway not connected');
    return client.request(method, params);
  };

  const updateJob = (patch: Partial<StagedWritingJob> | ((job: StagedWritingJob) => StagedWritingJob)) => {
    set((state) => {
      if (!state.job) return state;
      const next = typeof patch === 'function' ? patch(state.job) : { ...state.job, ...patch };
      persistJob(next);
      return { job: next };
    });
  };

  const dispatchStageCron = async (params: {
    prompt: string;
    jobId: string;
    stageId: string;
    label: string;
    timeoutSeconds: number;
  }): Promise<void> => {
    let cronJobId: string | null = null;
    try {
      const cronResult = await request('cron.add', {
        name: `[rc-writing] ${params.label} (${params.stageId})`,
        description: `Staged writing ${params.jobId} ${params.stageId}`,
        schedule: { kind: 'cron' as const, expr: WRITING_CRON_EXPR },
        sessionTarget: 'isolated',
        sessionKey: `cron:rc-writing:${params.jobId}:${params.stageId}`,
        delivery: { mode: 'none' as const },
        payload: {
          kind: 'agentTurn',
          message: params.prompt,
          timeoutSeconds: params.timeoutSeconds,
        },
      }) as { id: string };
      cronJobId = cronResult?.id ?? null;
      if (!cronJobId) throw new Error('Failed to register writing job');
      await request('cron.run', { id: cronJobId, mode: 'force' });
    } finally {
      if (cronJobId) {
        try {
          await request('cron.remove', { id: cronJobId });
        } catch { /* non-fatal */ }
      }
    }
  };

  const stageFileReady = async (path: string, minChars: number): Promise<boolean> => {
    const content = await readWorkspaceFileIfReady(
      (method, params) => request(method, params),
      path,
      minChars,
    );
    return content != null;
  };

  const markStageDone = (stageIndex: number, stages: StagedWritingStageState[]): StagedWritingStageState[] =>
    stages.map((s, i) =>
      i === stageIndex
        ? { ...s, status: 'done' as const, completedAtMs: Date.now(), error: undefined }
        : s,
    );

  const runOrchestration = async (startIndex: number, token: number): Promise<void> => {
    if (token !== orchestrationToken) return;

    for (let i = startIndex; i < STAGED_WRITING_STAGES.length; i++) {
      if (token !== orchestrationToken) return;
      const job = get().job;
      if (!job) return;

      const stageDef = STAGED_WRITING_STAGES[i];
      const stageState = job.stages[i];
      if (!stageState) break;

      if (stageState.status === 'done') continue;

      if (await stageFileReady(stageState.outputPath, stageDef.minChars)) {
        updateJob((j) => ({
          ...j,
          stages: markStageDone(i, j.stages),
          currentStageIndex: i + 1,
        }));
        continue;
      }

      updateJob((j) => ({
        ...j,
        status: 'running',
        currentStageIndex: i,
        lastError: null,
        stages: j.stages.map((s, idx) =>
          idx === i ? { ...s, status: 'running', error: undefined } : s,
        ),
      }));

      const current = get().job!;
      const priorPaths = current.stages
        .slice(0, i)
        .filter((s) => s.status === 'done')
        .map((s) => s.outputPath);

      const prompt = buildStagedWritingPrompt({
        jobId: current.id,
        locale: current.locale,
        topic: current.topic,
        contextText: current.contextText,
        venue: current.venue,
        sourcePaths: current.sourcePaths,
        stage: stageDef,
        stageIndex: i,
        stageTotal: STAGED_WRITING_STAGES.length,
        outputPath: stageState.outputPath,
        priorOutputPaths: priorPaths,
      });

      const stageStartedAt = Date.now();
      const timeoutSeconds = stageDef.timeoutSeconds ?? 300;
      try {
        await dispatchStageCron({
          prompt,
          jobId: current.id,
          stageId: stageDef.id,
          label: current.slug || 'writing',
          timeoutSeconds,
        });
      } catch (err) {
        const message = formatWritingFailureReason(err instanceof Error ? err.message : String(err));
        updateJob((j) => ({
          ...j,
          status: countCompletedStages(j.stages) > 0 ? 'partial' : 'failed',
          lastError: message,
          stages: j.stages.map((s, idx) =>
            idx === i ? { ...s, status: 'failed', error: message } : s,
          ),
        }));
        useUiStore.getState().addNotification({
          type: 'system',
          title: i18n.t('stagedWriting.notifyFailedTitle'),
          body: message,
          dedupKey: `staged-writing:failed:${current.id}:${stageDef.id}`,
        });
        return;
      }

      const deadline = stagePollDeadlineMs(stageStartedAt, timeoutSeconds);
      let ready = false;
      while (Date.now() < deadline) {
        if (token !== orchestrationToken) return;
        if (await stageFileReady(stageState.outputPath, stageDef.minChars)) {
          ready = true;
          break;
        }
        await sleep(WRITING_POLL_MS);
      }

      if (!ready && await stageFileReady(stageState.outputPath, stageDef.minChars)) {
        ready = true;
      }

      if (ready) {
        updateJob((j) => ({
          ...j,
          stages: markStageDone(i, j.stages),
          currentStageIndex: i + 1,
        }));
        useUiStore.getState().triggerWorkspaceRefresh();
        continue;
      }

      const failMsg = i18n.t('stagedWriting.errors.stageTimeout', {
        stage: i + 1,
        path: stageState.outputPath,
      });
      updateJob((j) => ({
        ...j,
        status: countCompletedStages(j.stages) > 0 ? 'partial' : 'failed',
        lastError: failMsg,
        stages: j.stages.map((s, idx) =>
          idx === i ? { ...s, status: 'failed', error: failMsg } : s,
        ),
      }));
      useUiStore.getState().addNotification({
        type: 'system',
        title: i18n.t('stagedWriting.notifyPartialTitle', {
          done: countCompletedStages(get().job?.stages ?? []),
          total: STAGED_WRITING_STAGES.length,
        }),
        body: failMsg,
        dedupKey: `staged-writing:partial:${current.id}:${stageDef.id}`,
      });
      return;
    }

    updateJob({
      status: 'completed',
      lastError: null,
      currentStageIndex: STAGED_WRITING_STAGES.length,
    });
    useUiStore.getState().addNotification({
      type: 'system',
      title: i18n.t('stagedWriting.notifyCompleteTitle'),
      body: i18n.t('stagedWriting.notifyCompleteBody', {
        path: get().job?.stages[STAGED_WRITING_STAGES.length - 1]?.outputPath ?? '',
      }),
      dedupKey: `staged-writing:complete:${get().job?.id}`,
    });
    useUiStore.getState().triggerWorkspaceRefresh();
  };

  const beginOrchestration = async (startIndex: number): Promise<boolean> => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) {
      set({ job: get().job ? { ...get().job!, lastError: i18n.t('chat.notConnected') } : null });
      return false;
    }
    orchestrationToken += 1;
    const token = orchestrationToken;
    updateJob({ status: 'running', lastError: null });
    void runOrchestration(startIndex, token);
    return true;
  };

  return {
    job: null,
    restored: false,

    restoreJob: async () => {
      if (get().restored) return;
      set({ restored: true });
      const saved = loadPersistedJob();
      if (!saved) return;
      set({ job: saved });
      await get().syncStageFiles();
      const synced = get().job;
      if (saved.status === 'running' && synced) {
        const resumeIndex = synced.stages.findIndex((s) => s.status !== 'done');
        const idx = resumeIndex >= 0 ? resumeIndex : synced.currentStageIndex;
        await beginOrchestration(idx);
      }
    },

    syncStageFiles: async () => {
      const job = get().job;
      if (!job) return;
      const client = useGatewayStore.getState().client;
      if (!client?.isConnected) return;

      let changed = false;
      const stages = [...job.stages];
      for (let i = 0; i < STAGED_WRITING_STAGES.length; i++) {
        const def = STAGED_WRITING_STAGES[i];
        if (stages[i]?.status === 'done') continue;
        if (await stageFileReady(stages[i].outputPath, def.minChars)) {
          stages[i] = { ...stages[i], status: 'done', completedAtMs: Date.now(), error: undefined };
          changed = true;
        }
      }
      if (!changed) {
        return;
      }

      const doneCount = countCompletedStages(stages);
      const allDone = doneCount === STAGED_WRITING_STAGES.length;
      updateJob({
        stages,
        currentStageIndex: doneCount,
        status: allDone ? 'completed' : job.status === 'running' ? 'running' : doneCount > 0 ? 'partial' : job.status,
        lastError: allDone ? null : job.lastError,
      });
    },

    startJobFromChat: async (params) => {
      const topic = params.topic.trim();
      if (!topic) return false;

      const existing = get().job;
      if (existing?.status === 'running') return false;

      const requestedSlug = params.slug?.trim() ?? '';
      const sourcePaths = params.sourcePaths?.length
        ? params.sourcePaths
        : [];
      const locale = useConfigStore.getState().locale;
      const id = crypto.randomUUID();
      const slug = requestedSlug || uniqueWritingSlug(topic, id);
      const outputDir = resolveOutputDir(slug);

      const job: StagedWritingJob = {
        id,
        sessionKey: params.sessionKey,
        slug,
        topic,
        contextText: params.contextText?.trim() ?? '',
        sourcePaths,
        venue: params.venue?.trim() ?? '',
        locale,
        outputDir,
        startedAtMs: Date.now(),
        status: 'running',
        currentStageIndex: 0,
        stages: buildInitialStageStates(outputDir),
        lastError: null,
      };

      persistJob(job);
      set({ job });
      await get().syncStageFiles();
      const synced = get().job!;
      const firstPending = synced.stages.findIndex((s) => s.status !== 'done');
      return beginOrchestration(firstPending >= 0 ? firstPending : 0);
    },

    resumeJob: async () => {
      const job = get().job;
      if (!job) return false;
      const idx = job.stages.findIndex((s) => s.status !== 'done');
      if (idx < 0) {
        updateJob({ status: 'completed', lastError: null });
        return true;
      }
      return beginOrchestration(idx);
    },

    cancelJob: () => {
      orchestrationToken += 1;
      stopPollTimer();
      updateJob({ status: 'cancelled', lastError: null });
    },

    retryStage: async (stageIndex: number) => {
      const job = get().job;
      if (!job || stageIndex < 0 || stageIndex >= job.stages.length) return false;
      updateJob((j) => ({
        ...j,
        status: 'running',
        lastError: null,
        stages: j.stages.map((s, idx) =>
          idx === stageIndex ? { ...s, status: 'pending', error: undefined } : s,
        ),
      }));
      return beginOrchestration(stageIndex);
    },

    clearJob: () => {
      orchestrationToken += 1;
      stopPollTimer();
      persistJob(null);
      set({ job: null });
    },

    openStageFile: (path) => {
      useUiStore.getState().requestWorkspacePreview(path);
    },
  };
});

export { STAGED_WRITING_STAGES };
