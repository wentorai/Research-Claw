import { create } from 'zustand';
import { useGatewayStore } from './gateway';

export type JobStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'stalled' | 'cancelled';
export type JobStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface JobStep {
  job_id: string;
  step_key: string;
  label: string;
  status: JobStepStatus;
  attempt: number;
  progress: number;
  error: string | null;
  updated_at: string;
}

export interface Job {
  id: string;
  type: string;
  title: string;
  session_key: string | null;
  status: JobStatus;
  progress: number;
  current_step: string | null;
  error: string | null;
  heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  input?: Record<string, unknown>;
  checkpoint?: Record<string, unknown>;
  result?: unknown;
  steps?: JobStep[];
}

type JobAction = 'cancel' | 'resume' | 'retry';

export interface JobCancelResult {
  jobCancelled: true;
  backingStop: 'stopped' | 'not-active' | 'unconfirmed' | 'not-applicable';
}

interface OpenClawTask {
  id?: string;
  taskId?: string;
  runtime?: 'subagent' | 'cli' | 'acp' | string;
  status?: 'queued' | 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled';
  childSessionKey?: string;
  sessionKey?: string;
  runId?: string;
}

interface JobsState {
  jobs: Job[];
  loading: boolean;
  lastLoadedAt: number | null;
  actionById: Record<string, JobAction | undefined>;
  loadJobs: () => Promise<boolean>;
  loadJob: (id: string) => Promise<Job | null>;
  cancelJob: (id: string) => Promise<JobCancelResult>;
  resumeJob: (id: string) => Promise<void>;
  retryJob: (id: string) => Promise<void>;
}

let jobsLoadGeneration = 0;
const jobLoadGenerationById = new Map<string, number>();

function invalidateJobReads(id: string): void {
  jobsLoadGeneration += 1;
  jobLoadGenerationById.set(id, (jobLoadGenerationById.get(id) ?? 0) + 1);
  useJobsStore.setState({ loading: false });
}

/**
 * Older sync ordering could leave both a user-facing longtask:* row and an
 * automatically mirrored openclaw:* row for the same child session. They are
 * one execution, not two jobs. Prefer the durable user-titled row while
 * retaining standalone OpenClaw jobs that have no matching long-task record.
 */
export function collapseMirroredOpenClawJobs(jobs: Job[]): Job[] {
  const trackedSessions = new Set(
    jobs
      .filter((job) =>
        job.type === 'openclaw-subagent'
        && !job.id.startsWith('openclaw:')
        && Boolean(job.session_key),
      )
      .map((job) => job.session_key as string),
  );
  return jobs.filter((job) => !(
    job.type === 'openclaw-subagent'
    && job.id.startsWith('openclaw:')
    && Boolean(job.session_key)
    && trackedSessions.has(job.session_key as string)
  ));
}

export const useJobsStore = create<JobsState>()((set, get) => ({
  jobs: [],
  loading: false,
  lastLoadedAt: null,
  actionById: {},
  loadJobs: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) {
      set({ loading: false });
      return false;
    }
    const generation = ++jobsLoadGeneration;
    set({ loading: true });
    try {
      const jobs = await client.request<Job[]>('rc.job.list', { limit: 100 });
      if (generation !== jobsLoadGeneration) return true;
      set({ jobs: collapseMirroredOpenClawJobs(jobs), loading: false, lastLoadedAt: Date.now() });
      return true;
    } catch {
      if (generation === jobsLoadGeneration) set({ loading: false });
      return false;
    }
  },
  loadJob: async (id) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return null;
    const generation = (jobLoadGenerationById.get(id) ?? 0) + 1;
    jobLoadGenerationById.set(id, generation);
    try {
      const job = await client.request<Job>('rc.job.get', { id });
      if (jobLoadGenerationById.get(id) !== generation) {
        return get().jobs.find((item) => item.id === id) ?? null;
      }
      set({ jobs: get().jobs.map((item) => item.id === id ? job : item) });
      return job;
    } catch {
      return null;
    }
  },
  cancelJob: async (id) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) {
      throw new Error('Gateway is not connected.');
    }
    const job = get().jobs.find((item) => item.id === id) ?? await get().loadJob(id);
    setAction(id, 'cancel');
    try {
      // Record the user's intent in the DB FIRST so the job is durably cancelled
      // even if tearing down the backing OpenClaw run fails or finds nothing. The
      // upsertExternal status-precedence guard keeps it cancelled against any
      // later sync that still observes the child session as running.
      const cancelled = await client.request<Job>('rc.job.cancel', {
        id,
        reason: job?.type === 'openclaw-subagent'
          ? 'Cancelled from Research-Claw Jobs panel'
          : 'Cancelled by user',
      });
      invalidateJobReads(id);
      replaceJob(cancelled);
      // Best-effort: stop the live OpenClaw subagent run. Never block (or fail)
      // the cancel on this — the job is already cancelled above, and "no active
      // run found" is an expected, non-fatal outcome here.
      let backingStop: JobCancelResult['backingStop'] = 'not-applicable';
      if (job?.type === 'openclaw-subagent') {
        try {
          backingStop = await cancelOpenClawBacking(client, job);
        } catch (err) {
          console.warn('[Jobs] Job cancelled; backing OpenClaw run not stopped:', err);
          backingStop = 'unconfirmed';
        }
      }
      await get().loadJobs();
      return { jobCancelled: true, backingStop };
    } finally {
      setAction(id, undefined);
    }
  },
  resumeJob: async (id) => {
    await continueOpenClawJob(id, 'resume');
  },
  retryJob: async (id) => {
    await continueOpenClawJob(id, 'retry');
  },
}));

function replaceJob(job: Job): void {
  useJobsStore.setState((state) => ({
    jobs: state.jobs.some((item) => item.id === job.id)
      ? state.jobs.map((item) => item.id === job.id ? job : item)
      : [job, ...state.jobs],
  }));
}

function setAction(id: string, action: JobAction | undefined): void {
  useJobsStore.setState((state) => ({
    actionById: { ...state.actionById, [id]: action },
  }));
}

function textField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function getOpenClawSessionKeys(job: Job): string[] {
  return unique([
    job.session_key,
    textField(job.input?.session_key),
    textField(job.input?.child_session_key),
    textField(job.input?.childSessionKey),
    textField(job.checkpoint?.session_key),
    textField(job.checkpoint?.child_session_key),
    textField(job.checkpoint?.childSessionKey),
  ]);
}

function getOpenClawTaskIds(job: Job): string[] {
  return unique([
    textField(job.input?.task_id),
    textField(job.input?.taskId),
    textField(job.checkpoint?.task_id),
    textField(job.checkpoint?.taskId),
  ]);
}

function isActiveOpenClawTask(task: OpenClawTask): boolean {
  return task.status === 'queued' || task.status === 'running';
}

async function listOpenClawTasks(client: NonNullable<ReturnType<typeof useGatewayStore.getState>['client']>, job: Job): Promise<OpenClawTask[]> {
  const tasks: OpenClawTask[] = [];
  for (const sessionKey of getOpenClawSessionKeys(job)) {
    try {
      const result = await client.request<{ tasks?: OpenClawTask[] }>('tasks.list', { sessionKey, limit: 50 });
      tasks.push(...(result.tasks ?? []));
    } catch {
      // Older OpenClaw builds or restricted clients may not expose tasks.*.
    }
  }
  return tasks;
}

async function cancelOpenClawBacking(
  client: NonNullable<ReturnType<typeof useGatewayStore.getState>['client']>,
  job: Job,
): Promise<JobCancelResult['backingStop']> {
  const tasks = await listOpenClawTasks(client, job);
  const activeTasks = tasks.filter(isActiveOpenClawTask);
  // OC registers both a subagent wrapper and, while the model is running, a CLI
  // task for the same run. Cancelling the CLI mirror does not kill the wrapper.
  // The subagent wrapper is the authoritative control task: OC only returns
  // cancelled=true after killSubagentRunAdmin reports killed=true.
  const wrapper = activeTasks.find((task) => task.runtime === 'subagent');
  if (wrapper) {
    const taskId = wrapper.taskId ?? wrapper.id;
    if (taskId) {
      const result = await client.request<{ cancelled?: boolean; found?: boolean }>('tasks.cancel', {
        taskId,
        reason: 'Cancelled from Research-Claw Jobs panel',
      });
      if (result.cancelled === true) return 'stopped';
      // found=true only proves that OC recognized the task. Its own contract
      // uses cancelled=false for terminal/not-running/failed-to-kill results.
      // Keep looking for an exact run abort, but never call this confirmed.
    }
  } else if (activeTasks.length > 0) {
    let allCancelled = true;
    for (const task of activeTasks) {
      const taskId = task.taskId ?? task.id;
      if (!taskId) {
        allCancelled = false;
        continue;
      }
      const result = await client.request<{ cancelled?: boolean }>('tasks.cancel', {
        taskId,
        reason: 'Cancelled from Research-Claw Jobs panel',
      });
      if (result.cancelled !== true) allCancelled = false;
    }
    if (allCancelled) return 'stopped';
  }

  const listedIds = new Set(tasks.flatMap((task) => {
    const taskId = task.taskId ?? task.id;
    return taskId ? [taskId] : [];
  }));
  for (const taskId of getOpenClawTaskIds(job)) {
    if (listedIds.has(taskId)) continue;
    const result = await client.request<{ cancelled?: boolean }>('tasks.cancel', {
      taskId,
      reason: 'Cancelled from Research-Claw Jobs panel',
    });
    if (result.cancelled === true) return 'stopped';
  }

  const sessionKey = getOpenClawSessionKeys(job)[0];
  if (!sessionKey) return activeTasks.length > 0 ? 'unconfirmed' : 'not-active';
  const aborted = await client.request<{ aborted?: boolean }>('chat.abort', { sessionKey });
  if (aborted.aborted === true) return 'stopped';
  return activeTasks.length > 0 ? 'unconfirmed' : 'not-active';
}

/**
 * Decide which linked session key to continue against, given the set of sessions
 * the gateway currently knows about. Pure so it can be unit-tested:
 *   - knownKeys === null  → existence couldn't be determined; stay optimistic and
 *     use the first candidate (preserves behaviour on builds without sessions.list).
 *   - a candidate is live → use it.
 *   - all candidates gone → null, so the caller can fail loudly instead of firing a
 *     chat.send into a dead session and flipping the job to a phantom "running".
 */
export function chooseLiveSessionKey(candidates: string[], knownKeys: Set<string> | null): string | null {
  if (candidates.length === 0) return null;
  if (!knownKeys) return candidates[0];
  return candidates.find((key) => knownKeys.has(key)) ?? null;
}

async function resolveLiveSessionKey(
  client: NonNullable<ReturnType<typeof useGatewayStore.getState>['client']>,
  candidates: string[],
): Promise<string | null> {
  let knownKeys: Set<string> | null = null;
  try {
    const result = await client.request<{ sessions?: Array<{ key?: string }> }>('sessions.list', { limit: 1000 });
    knownKeys = new Set((result.sessions ?? []).map((s) => s.key).filter((k): k is string => Boolean(k)));
  } catch {
    // Older/restricted gateways may not expose sessions.list — fall back to optimistic.
    knownKeys = null;
  }
  return chooseLiveSessionKey(candidates, knownKeys);
}

async function continueOpenClawJob(id: string, mode: 'resume' | 'retry'): Promise<void> {
  const client = useGatewayStore.getState().client;
  if (!client?.isConnected) return;
  const job = useJobsStore.getState().jobs.find((item) => item.id === id) ?? await useJobsStore.getState().loadJob(id);
  if (!job) return;
  const candidates = getOpenClawSessionKeys(job);
  if (candidates.length === 0) throw new Error('This job is not linked to an OpenClaw child session yet.');

  setAction(id, mode);
  try {
    // Verify the linked child session still exists before optimistically marking
    // the job running — otherwise a resume/retry silently no-ops and reverts.
    const sessionKey = await resolveLiveSessionKey(client, candidates);
    if (!sessionKey) {
      throw new Error('关联的 OpenClaw 子会话已不存在，无法继续或重试；请改为新建任务重新发起。');
    }
    await client.request('chat.send', {
      sessionKey,
      deliver: false,
      idempotencyKey: `rc-job-${mode}-${id}-${crypto.randomUUID()}`,
      message: buildContinuationPrompt(job, mode),
    });
    const updated = await client.request<Job>('rc.job.resume', {
      id,
      current_step: mode === 'retry'
        ? '已请求 OpenClaw 子会话重试'
        : '已请求 OpenClaw 子会话继续',
    });
    invalidateJobReads(id);
    replaceJob(updated);
    await useJobsStore.getState().loadJobs();
  } finally {
    setAction(id, undefined);
  }
}

function buildContinuationPrompt(job: Job, mode: 'resume' | 'retry'): string {
  const action = mode === 'retry' ? 'retry the failed/stalled work' : 'continue the unfinished work';
  return `[Research-Claw] Jobs Panel Control
Research-Claw Job ID: ${job.id}

Please ${action} for this background job.
- Do not create a new job_start record.
- Use job_checkpoint with Job ID "${job.id}" after each major step.
- Call job_finish with Job ID "${job.id}" when the task is done, partially done, failed, or cancelled.
- If previous artifacts already exist, inspect them first and continue from the safest checkpoint.`;
}
