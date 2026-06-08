import { create } from 'zustand';
import i18n from '../i18n';
import { useConfigStore } from './config';
import { useGatewayStore } from './gateway';
import { useUiStore } from './ui';
import type {
  PaperReview,
  PaperReviewCandidatesResponse,
  PaperReviewGetResponse,
  PaperReviewListResponse,
  PaperReviewStatus,
  PaperReviewWriteResponse,
  WorkspacePaperCandidate,
} from '../gateway/paper-review-types';
import {
  DEFAULT_REVIEW_DISCIPLINE,
  type ReviewDisciplineId,
  buildPaperReviewRubric,
  isReviewDisciplineId,
} from '../utils/paper-review-discipline';
import { buildPaperReviewBrief, legacyReviewOutputPath, reportBelongsToReview, reviewOutputPath } from '../utils/paper-review-brief';
import { buildTopVenuePaperReviewPrompt } from '../utils/paper-review-prompt';
import { readWorkspaceFileIfReady } from '../utils/workspace-file-poll';
import {
  type PendingPaperReviewRun,
  type PaperReviewStageProgress,
  REVIEW_RUN_TIMEOUT_SECONDS,
  formatReviewFailureReason,
  isPaperReviewCronSessionKey,
  isStaleInProgressReview,
  reviewPollDeadlineMs,
} from '../utils/paper-review-run';
import { cleanupPaperReviewCronSessions } from '../utils/paper-review-cron-sessions';
import { useSessionsStore } from './sessions';
import type { ChatStreamEvent } from '../gateway/types';

export type PaperReviewPatch = {
  title?: string;
  paper_id?: string | null;
  status?: PaperReviewStatus;
  overall_score?: number | null;
  summary?: string | null;
  strengths?: string | null;
  weaknesses?: string | null;
  suggestions?: string | null;
  report_markdown?: string | null;
  rubric?: string | null;
  failure_reason?: string | null;
};

const POLL_MS = 3000;
const MIN_REPORT_CHARS = 200;
const REVIEW_CRON_EXPR = '0 0 1 1 *';

const STORAGE_PATH = 'rc-paper-review-path';
const STORAGE_REVIEW_ID = 'rc-paper-review-id';
const STORAGE_DISCIPLINE = 'rc-paper-review-discipline';

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pendingRun: PendingPaperReviewRun | null = null;

function stopPollTimer(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function loadStoredPath(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_PATH);
    return raw?.trim() || null;
  } catch {
    return null;
  }
}

function loadStoredReviewId(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_REVIEW_ID);
    return raw?.trim() || null;
  } catch {
    return null;
  }
}

function loadStoredDiscipline(): ReviewDisciplineId {
  try {
    const raw = localStorage.getItem(STORAGE_DISCIPLINE);
    if (raw && isReviewDisciplineId(raw)) return raw;
  } catch { /* ignore */ }
  return DEFAULT_REVIEW_DISCIPLINE;
}

function persistSelection(path: string | null, reviewId: string | null): void {
  try {
    if (path) localStorage.setItem(STORAGE_PATH, path);
    else localStorage.removeItem(STORAGE_PATH);
    if (reviewId) localStorage.setItem(STORAGE_REVIEW_ID, reviewId);
    else localStorage.removeItem(STORAGE_REVIEW_ID);
  } catch { /* non-fatal */ }
}

function persistDiscipline(discipline: ReviewDisciplineId): void {
  try {
    localStorage.setItem(STORAGE_DISCIPLINE, discipline);
  } catch { /* non-fatal */ }
}

interface PaperReviewState {
  candidates: WorkspacePaperCandidate[];
  reviews: PaperReview[];
  activeReview: PaperReview | null;
  selectedPath: string | null;
  selectedDiscipline: ReviewDisciplineId;
  stageProgress: PaperReviewStageProgress | null;
  loading: boolean;
  saving: boolean;
  running: boolean;
  error: string | null;
  restored: boolean;

  loadCandidates: () => Promise<void>;
  restoreSession: () => Promise<void>;
  loadReviews: (filePath: string) => Promise<void>;
  selectPath: (path: string | null) => void;
  setDiscipline: (discipline: ReviewDisciplineId) => void;
  createReview: (filePath: string) => Promise<PaperReview | null>;
  loadReview: (id: string) => Promise<void>;
  saveReview: (id: string, patch: PaperReviewPatch) => Promise<boolean>;
  deleteReview: (id: string) => Promise<boolean>;
  runReview: (filePath: string) => Promise<boolean>;
  cancelReview: (reviewId: string) => Promise<boolean>;
  stopPolling: () => void;
  handleAgentEvent: (payload: unknown) => void;
  handleChatEvent: (payload: unknown) => void;
  clearError: () => void;
}

export const usePaperReviewStore = create<PaperReviewState>((set, get) => {
  const failReview = async (
    reviewId: string,
    reason: string,
    options?: { notify?: boolean; fileName?: string; filePath?: string },
  ): Promise<void> => {
    const run = pendingRun?.reviewId === reviewId ? pendingRun : null;
    pendingRun = null;
    get().stopPolling();

    const message = formatReviewFailureReason(reason);
    await get().saveReview(reviewId, {
      status: 'failed',
      failure_reason: message,
    });

    const filePath = options?.filePath ?? get().selectedPath ?? run?.filePath;
    const fileName = options?.fileName ?? run?.fileName ?? reviewId.slice(0, 8);
    const client = useGatewayStore.getState().client;
    if (client?.isConnected) {
      await cleanupPaperReviewCronSessions(
        (method, params) => client.request(method, params),
        reviewId,
        fileName,
      );
      void useSessionsStore.getState().loadSessions();
    }
    if (filePath) await get().loadReviews(filePath);

    set({ error: message, stageProgress: null });
    if (options?.notify !== false) {
      useUiStore.getState().addNotification({
        type: 'system',
        title: i18n.t('paperReview.notifyFailedTitle', { file: fileName }),
        body: message,
        dedupKey: `paper-review:failed:${reviewId}`,
      });
      void useUiStore.getState().checkNotifications();
    }
  };

  const hydrateReviewReport = async (review: PaperReview, filePath: string): Promise<PaperReview> => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return review;

    const existing = review.report_markdown?.trim() ?? '';
    if (existing.length >= MIN_REPORT_CHARS && reportBelongsToReview(existing, review.id)) {
      return review;
    }

    const paths = [
      reviewOutputPath(filePath, review.id),
      legacyReviewOutputPath(filePath),
    ];

    for (const path of paths) {
      const legacyFallback = path === legacyReviewOutputPath(filePath);
      try {
        const fileReport = await readWorkspaceFileIfReady(
          (method, params) => client.request(method, params),
          path,
          MIN_REPORT_CHARS,
        );
        if (!fileReport) continue;
        if (!reportBelongsToReview(fileReport, review.id, { legacyFallback })) continue;

        await get().saveReview(review.id, {
          report_markdown: fileReport,
          status: review.status === 'in_progress' ? 'completed' : review.status,
        });
        return get().activeReview ?? review;
      } catch {
        // Try next path.
      }
    }
    return review;
  };

  const startPolling = (filePath: string, reviewId: string, fileName: string) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    get().stopPolling();
    pendingRun = {
      reviewId,
      filePath,
      fileName,
      startedAtMs: Date.now(),
    };
    set({ running: true, error: null, stageProgress: null });
    pollTimer = setInterval(() => {
      void (async () => {
        const current = get().activeReview;
        const run = pendingRun;
        if (!current || !run || current.id !== reviewId) return;

        const deadline = reviewPollDeadlineMs(run.startedAtMs);
        if (Date.now() > deadline) {
          await failReview(
            reviewId,
            i18n.t('paperReview.errors.pollTimeout'),
            { fileName },
          );
          return;
        }

        await get().loadReview(current.id);
        let updated = get().activeReview;
        if (!updated) return;

        updated = await hydrateReviewReport(updated, filePath);
        let report = updated.report_markdown?.trim() ?? '';

        if (report.length >= MIN_REPORT_CHARS) {
          if (updated.status !== 'completed') {
            pendingRun = null;
            await get().saveReview(updated.id, { status: 'completed', failure_reason: null });
            updated = get().activeReview ?? updated;
          }
          const brief = buildPaperReviewBrief(updated);
          const scoreLabel = brief.score != null ? `${brief.score}/10` : '—';
          const verdictLabel = brief.verdict?.split('\n')[0]?.trim() ?? '—';
          useUiStore.getState().addNotification({
            type: 'system',
            title: i18n.t('paperReview.notifyCompleteTitle', { file: fileName }),
            body: i18n.t('paperReview.notifyCompleteBody', {
              file: fileName,
              score: scoreLabel,
              verdict: verdictLabel,
            }),
            dedupKey: `paper-review:${reviewId}`,
          });
          void useUiStore.getState().checkNotifications();
          await get().loadReviews(filePath);
          const client = useGatewayStore.getState().client;
          if (client?.isConnected) {
            await cleanupPaperReviewCronSessions(
              (method, params) => client.request(method, params),
              reviewId,
              fileName,
            );
            void useSessionsStore.getState().loadSessions();
          }
          get().stopPolling();
        }
      })();
    }, POLL_MS);
  };

  const dispatchReviewCron = async (params: {
    prompt: string;
    reviewId: string;
    fileName: string;
    jobSuffix: string;
    timeoutSeconds: number;
  }): Promise<void> => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) throw new Error('Gateway not connected');

    let cronJobId: string | null = null;
    try {
      const cronResult = await client.request<{ id: string }>('cron.add', {
        name: `[rc-review] ${params.fileName} (${params.jobSuffix})`,
        description: `Paper review ${params.reviewId} ${params.jobSuffix}`,
        schedule: { kind: 'cron' as const, expr: REVIEW_CRON_EXPR },
        sessionTarget: 'isolated',
        sessionKey: `cron:rc-review:${params.reviewId}:${params.jobSuffix}`,
        delivery: { mode: 'none' as const },
        payload: {
          kind: 'agentTurn',
          message: params.prompt,
          timeoutSeconds: params.timeoutSeconds,
        },
      });
      cronJobId = cronResult?.id ?? null;
      if (!cronJobId) throw new Error('Failed to register review job');
      await client.request('cron.run', { id: cronJobId, mode: 'force' });
    } finally {
      if (cronJobId) {
        try {
          await client.request('cron.remove', { id: cronJobId });
        } catch {
          // Non-fatal
        }
      }
    }
  };

  const runSingleReviewOrchestration = async (
    filePath: string,
    review: PaperReview,
    discipline: ReviewDisciplineId,
    locale: string,
    fileName: string,
  ): Promise<void> => {
    const outputPath = reviewOutputPath(filePath, review.id);
    const prompt = buildTopVenuePaperReviewPrompt(
      filePath,
      review.id,
      outputPath,
      discipline,
      locale,
    );

    pendingRun = {
      reviewId: review.id,
      filePath,
      fileName,
      startedAtMs: Date.now(),
    };
    set({ running: true, error: null, stageProgress: null });

    try {
      await dispatchReviewCron({
        prompt,
        reviewId: review.id,
        fileName,
        jobSuffix: 'full',
        timeoutSeconds: REVIEW_RUN_TIMEOUT_SECONDS,
      });
    } catch (err) {
      await failReview(review.id, err instanceof Error ? err.message : String(err), { fileName, filePath });
      return;
    }

    startPolling(filePath, review.id, fileName);
  };

  return {
    candidates: [],
    reviews: [],
    activeReview: null,
    selectedPath: null,
    selectedDiscipline: loadStoredDiscipline(),
    stageProgress: null,
    loading: false,
    saving: false,
    running: false,
    error: null,
    restored: false,

    loadCandidates: async () => {
      const client = useGatewayStore.getState().client;
      if (!client?.isConnected) return;
      set({ loading: true, error: null });
      try {
        const res = await client.request<PaperReviewCandidatesResponse>('rc.review.candidates', {});
        set({ candidates: res.candidates, loading: false });
        if (!get().restored) {
          await get().restoreSession();
        }
      } catch (err) {
        set({
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    restoreSession: async () => {
      if (get().restored) return;
      const path = loadStoredPath();
      const reviewId = loadStoredReviewId();
      set({ restored: true, selectedDiscipline: loadStoredDiscipline() });
      if (!path) return;

      await get().loadReviews(path);
      if (reviewId) {
        const inList = get().reviews.find((r) => r.id === reviewId);
        if (inList) {
          set({ activeReview: inList });
        } else {
          await get().loadReview(reviewId);
        }
      }

      const active = get().activeReview;
      if (active) {
        if (active.status === 'in_progress' && isStaleInProgressReview(active.updated_at, Date.now())) {
          const fileName = path.split('/').pop() ?? path;
          await failReview(
            active.id,
            i18n.t('paperReview.errors.staleRun'),
            { fileName, filePath: path, notify: false },
          );
        } else {
          await hydrateReviewReport(active, path);
          if (active.status === 'in_progress') {
            const fileName = path.split('/').pop() ?? path;
            startPolling(path, active.id, fileName);
          }
        }
      }
    },

    loadReviews: async (filePath: string) => {
      const client = useGatewayStore.getState().client;
      if (!client?.isConnected) return;
      const storedReviewId = loadStoredReviewId();
      set({ loading: true, error: null, selectedPath: filePath });
      persistSelection(filePath, storedReviewId);
      try {
        const res = await client.request<PaperReviewListResponse>('rc.review.list', {
          file_path: filePath,
          limit: 50,
        });
        const preferred = storedReviewId
          ? res.reviews.find((r) => r.id === storedReviewId)
          : undefined;
        const activeReview = preferred ?? res.reviews[0] ?? null;
        set({
          reviews: res.reviews,
          activeReview,
          loading: false,
        });
        persistSelection(filePath, activeReview?.id ?? null);
        if (activeReview) {
          await hydrateReviewReport(activeReview, filePath);
        }
      } catch (err) {
        set({
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    selectPath: (path) => {
      get().stopPolling();
      persistSelection(path, null);
      set({ selectedPath: path, reviews: [], activeReview: null, running: false });
      if (path) void get().loadReviews(path);
    },

    setDiscipline: (discipline) => {
      persistDiscipline(discipline);
      set({ selectedDiscipline: discipline });
    },

    createReview: async (filePath: string) => {
      const client = useGatewayStore.getState().client;
      if (!client?.isConnected) return null;
      const locale = useConfigStore.getState().locale;
      const rubric = buildPaperReviewRubric(get().selectedDiscipline, locale);
      set({ saving: true, error: null });
      try {
        const res = await client.request<PaperReviewWriteResponse>('rc.review.create', {
          file_path: filePath,
          status: 'draft',
          rubric,
        });
        await get().loadCandidates();
        await get().loadReviews(filePath);
        set({ saving: false, activeReview: res.review });
        persistSelection(filePath, res.review.id);
        return res.review;
      } catch (err) {
        set({
          saving: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },

    loadReview: async (id: string) => {
      const client = useGatewayStore.getState().client;
      if (!client?.isConnected) return;
      try {
        const res = await client.request<PaperReviewGetResponse>('rc.review.get', { id });
        const filePath = get().selectedPath ?? res.review.file_path;
        set((state) => ({
          activeReview: res.review,
          reviews: state.reviews.map((item) => (item.id === id ? res.review : item)),
          loading: false,
        }));
        persistSelection(filePath, id);
        if (filePath) {
          await hydrateReviewReport(res.review, filePath);
        }
      } catch (err) {
        set({
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    saveReview: async (id, patch) => {
      const client = useGatewayStore.getState().client;
      if (!client?.isConnected) return false;
      set({ saving: true, error: null });
      try {
        const payload: Record<string, unknown> = { id };
        for (const [key, value] of Object.entries(patch)) {
          if (value !== undefined) payload[key] = value;
        }
        const res = await client.request<PaperReviewWriteResponse>('rc.review.update', payload);
        const filePath = get().selectedPath;
        if (filePath) {
          const list = await client.request<PaperReviewListResponse>('rc.review.list', {
            file_path: filePath,
            limit: 50,
          });
          set({
            reviews: list.reviews,
            activeReview: res.review,
            saving: false,
          });
          persistSelection(filePath, res.review.id);
        } else {
          set({ activeReview: res.review, saving: false });
        }
        await get().loadCandidates();
        return true;
      } catch (err) {
        set({
          saving: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    },

    deleteReview: async (id) => {
      const client = useGatewayStore.getState().client;
      if (!client?.isConnected) return false;
      get().stopPolling();
      set({ saving: true, error: null });
      try {
        await client.request('rc.review.delete', { id });
        const filePath = get().selectedPath;
        if (filePath) await get().loadReviews(filePath);
        else {
          set({ activeReview: null, reviews: [] });
          persistSelection(null, null);
        }
        await get().loadCandidates();
        set({ saving: false, running: false });
        return true;
      } catch (err) {
        set({
          saving: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    },

    runReview: async (filePath: string) => {
      const client = useGatewayStore.getState().client;
      if (!client?.isConnected) {
        set({ error: 'Gateway not connected' });
        return false;
      }

      const review = await get().createReview(filePath);
      if (!review) return false;

      const discipline = get().selectedDiscipline;
      const locale = useConfigStore.getState().locale;
      const rubric = buildPaperReviewRubric(discipline, locale);
      await get().saveReview(review.id, {
        status: 'in_progress',
        rubric,
        report_markdown: null,
        failure_reason: null,
      });

      const fileName = filePath.trim().split('/').pop() ?? filePath.trim();
      void runSingleReviewOrchestration(filePath, review, discipline, locale, fileName);
      return true;
    },

    cancelReview: async (reviewId) => {
      const review = get().reviews.find((r) => r.id === reviewId) ?? get().activeReview;
      if (!review || review.status !== 'in_progress') {
        get().stopPolling();
        return true;
      }
      const filePath = get().selectedPath ?? pendingRun?.filePath;
      const fileName = filePath?.split('/').pop() ?? review.title;
      await failReview(reviewId, i18n.t('paperReview.errors.userCancelled'), {
        notify: false,
        fileName,
        filePath: filePath ?? undefined,
      });
      return true;
    },

    stopPolling: () => {
      stopPollTimer();
      pendingRun = null;
      set({ running: false, stageProgress: null });
    },

    handleAgentEvent: (payload: unknown) => {
      const run = pendingRun;
      if (!run || !get().running) return;

      const evt = payload as {
        sessionKey?: string;
        stream?: string;
        data?: { phase?: string; error?: string; reason?: string };
      };
      if (!isPaperReviewCronSessionKey(evt.sessionKey)) return;

      let reason: string | null = null;
      if (evt.stream === 'lifecycle' && evt.data?.phase === 'error' && evt.data.error) {
        reason = evt.data.error;
      } else if (evt.stream === 'error' && evt.data?.reason) {
        reason = String(evt.data.reason);
      }
      if (!reason) return;

      void failReview(run.reviewId, reason, { fileName: run.fileName });
    },

    handleChatEvent: (payload: unknown) => {
      const run = pendingRun;
      if (!run || !get().running) return;

      const evt = payload as ChatStreamEvent;
      if (evt.state !== 'error') return;
      if (!isPaperReviewCronSessionKey(evt.sessionKey)) return;

      const reason = evt.errorMessage?.trim()
        || evt.message?.text?.trim()
        || 'Review run failed';
      void failReview(run.reviewId, reason, { fileName: run.fileName });
    },

    clearError: () => set({ error: null }),
  };
});
