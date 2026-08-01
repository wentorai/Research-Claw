import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';

type Database = BetterSqlite3.Database;

export type JobStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'stalled' | 'cancelled';
export type JobStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface Job {
  id: string;
  type: string;
  title: string;
  session_key: string | null;
  status: JobStatus;
  progress: number;
  current_step: string | null;
  input: Record<string, unknown>;
  result: unknown;
  checkpoint: Record<string, unknown>;
  error: string | null;
  heartbeat_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  steps?: JobStep[];
}

export interface JobStep {
  job_id: string;
  step_key: string;
  label: string;
  status: JobStepStatus;
  attempt: number;
  progress: number;
  checkpoint: Record<string, unknown>;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export interface JobStepInput {
  key: string;
  label: string;
  status?: JobStepStatus;
  progress?: number;
  checkpoint?: Record<string, unknown>;
  error?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

interface JobRow extends Omit<Job, 'input' | 'result' | 'checkpoint' | 'steps'> {
  input_json: string;
  result_json: string | null;
  checkpoint_json: string;
}

interface StepRow extends Omit<JobStep, 'checkpoint'> {
  checkpoint_json: string;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function clampProgress(value: number | undefined): number {
  return Math.max(0, Math.min(100, Math.round(value ?? 0)));
}

function formatDbDate(value: number): string {
  return new Date(value).toISOString().slice(0, 19).replace('T', ' ');
}

export class JobService {
  constructor(private readonly db: Database) {}

  create(input: {
    type: string;
    title: string;
    session_key?: string;
    input?: Record<string, unknown>;
    steps?: Array<{ key: string; label: string }>;
  }): Job {
    const id = randomUUID();
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO rc_jobs (id, type, title, session_key, input_json)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(id, input.type, input.title, input.session_key ?? null, JSON.stringify(input.input ?? {}));
      const insertStep = this.db.prepare(
        `INSERT INTO rc_job_steps (job_id, step_key, label) VALUES (?, ?, ?)`,
      );
      for (const step of input.steps ?? []) insertStep.run(id, step.key, step.label);
    });
    tx();
    return this.get(id);
  }

  upsertExternal(input: {
    id: string;
    type: string;
    title: string;
    session_key?: string | null;
    status: JobStatus;
    progress: number;
    current_step?: string | null;
    input?: Record<string, unknown>;
    checkpoint?: Record<string, unknown>;
    result?: unknown;
    error?: string | null;
    heartbeat_at?: string | null;
    started_at?: string | null;
    completed_at?: string | null;
    updated_at?: string | null;
    steps?: JobStepInput[];
  }): Job {
    const existing = this.db.prepare('SELECT status FROM rc_jobs WHERE id=?')
      .get(input.id) as { status?: JobStatus } | undefined;
    // A user cancellation is a durable terminal decision. External transcript
    // sweeps may observe worker frames that were already in flight, but those
    // frames cannot silently revive or complete the cancelled job. An explicit
    // resume/retry first moves the row back to running via resume().
    if (existing?.status === 'cancelled') return this.get(input.id);
    const progress = clampProgress(input.progress);
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO rc_jobs (
           id, type, title, session_key, status, progress, current_step,
           input_json, result_json, checkpoint_json, error, heartbeat_at, started_at, completed_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
         ON CONFLICT(id) DO UPDATE SET
           type=excluded.type,
           title=excluded.title,
           session_key=excluded.session_key,
           status=CASE
             WHEN rc_jobs.status='cancelled' AND excluded.status IN ('queued','running','stalled')
               THEN rc_jobs.status
             ELSE excluded.status
           END,
           progress=CASE
             WHEN rc_jobs.status='cancelled' AND excluded.status IN ('queued','running','stalled')
               THEN rc_jobs.progress
             ELSE excluded.progress
           END,
           current_step=CASE
             WHEN rc_jobs.status='cancelled' AND excluded.status IN ('queued','running','stalled')
               THEN rc_jobs.current_step
             ELSE excluded.current_step
           END,
           input_json=excluded.input_json,
           result_json=COALESCE(excluded.result_json, rc_jobs.result_json),
           checkpoint_json=excluded.checkpoint_json,
           error=CASE
             WHEN rc_jobs.status='cancelled' AND excluded.status IN ('queued','running','stalled')
               THEN rc_jobs.error
             ELSE excluded.error
           END,
           heartbeat_at=excluded.heartbeat_at,
           started_at=COALESCE(rc_jobs.started_at, excluded.started_at),
           completed_at=COALESCE(excluded.completed_at, rc_jobs.completed_at),
           updated_at=excluded.updated_at`,
      ).run(
        input.id,
        input.type,
        input.title,
        input.session_key ?? null,
        input.status,
        progress,
        input.current_step ?? null,
        JSON.stringify(input.input ?? {}),
        input.result === undefined ? null : JSON.stringify(input.result),
        JSON.stringify(input.checkpoint ?? {}),
        input.error ?? null,
        input.heartbeat_at ?? null,
        input.started_at ?? null,
        input.completed_at ?? null,
        input.updated_at ?? null,
      );
      if (input.steps?.length) this.upsertSteps(input.id, input.steps, input.updated_at ?? null);
    });
    tx();
    return this.get(input.id);
  }

  get(id: string): Job {
    const row = this.db.prepare('SELECT * FROM rc_jobs WHERE id = ?').get(id) as JobRow | undefined;
    if (!row) throw new Error(`Job not found: ${id}`);
    return { ...this.mapJob(row), steps: this.listSteps(id) };
  }

  list(params: { status?: JobStatus; session_key?: string; limit?: number } = {}): Job[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (params.status) { where.push('status = ?'); args.push(params.status); }
    if (params.session_key) { where.push('session_key = ?'); args.push(params.session_key); }
    args.push(Math.max(1, Math.min(params.limit ?? 50, 200)));
    const rows = this.db.prepare(
      `SELECT * FROM rc_jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY updated_at DESC LIMIT ?`,
    ).all(...args) as JobRow[];
    const jobs = rows.map((row) => this.mapJob(row));
    if (jobs.length === 0) return jobs;
    // Attach steps in one batched query so the panel can render sub-steps without
    // an extra round-trip per job. Jobs without steps just get an empty array.
    const stepsByJob = this.listStepsForJobs(jobs.map((job) => job.id));
    for (const job of jobs) job.steps = stepsByJob.get(job.id) ?? [];
    return jobs;
  }

  listSteps(id: string): JobStep[] {
    return (this.db.prepare(
      'SELECT * FROM rc_job_steps WHERE job_id = ? ORDER BY rowid',
    ).all(id) as StepRow[]).map((row) => ({
      ...row,
      checkpoint: parseJson(row.checkpoint_json, {}),
    }));
  }

  private listStepsForJobs(ids: string[]): Map<string, JobStep[]> {
    const map = new Map<string, JobStep[]>();
    if (ids.length === 0) return map;
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT * FROM rc_job_steps WHERE job_id IN (${placeholders}) ORDER BY rowid`,
    ).all(...ids) as StepRow[];
    for (const row of rows) {
      const step: JobStep = { ...row, checkpoint: parseJson(row.checkpoint_json, {}) };
      const list = map.get(row.job_id);
      if (list) list.push(step);
      else map.set(row.job_id, [step]);
    }
    return map;
  }

  private upsertSteps(jobId: string, steps: JobStepInput[], updatedAt: string | null): void {
    const stmt = this.db.prepare(
      `INSERT INTO rc_job_steps (
         job_id, step_key, label, status, progress, checkpoint_json, error, started_at, completed_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
       ON CONFLICT(job_id, step_key) DO UPDATE SET
         label=excluded.label,
         status=excluded.status,
         progress=excluded.progress,
         checkpoint_json=excluded.checkpoint_json,
         error=excluded.error,
         started_at=COALESCE(rc_job_steps.started_at, excluded.started_at),
         completed_at=COALESCE(excluded.completed_at, rc_job_steps.completed_at),
         updated_at=excluded.updated_at`,
    );
    for (const step of steps) {
      stmt.run(
        jobId,
        step.key,
        step.label,
        step.status ?? 'pending',
        clampProgress(step.progress),
        JSON.stringify(step.checkpoint ?? {}),
        step.error ?? null,
        step.started_at ?? null,
        step.completed_at ?? null,
        updatedAt,
      );
    }
  }

  start(id: string, currentStep?: string): Job {
    this.db.prepare(
      `UPDATE rc_jobs SET status='running', current_step=COALESCE(?, current_step),
       started_at=COALESCE(started_at, datetime('now')), heartbeat_at=datetime('now'),
       error=NULL, updated_at=datetime('now') WHERE id=?`,
    ).run(currentStep ?? null, id);
    return this.get(id);
  }

  checkpoint(id: string, patch: {
    progress?: number;
    current_step?: string | null;
    checkpoint?: Record<string, unknown>;
    step_key?: string;
    step_label?: string;
    step_status?: JobStepStatus;
    step_progress?: number;
    step_checkpoint?: Record<string, unknown>;
    error?: string | null;
  }): Job {
    const current = this.get(id);
    if (current.status === 'cancelled') return current;
    const checkpoint = { ...current.checkpoint, ...(patch.checkpoint ?? {}) };
    const status = current.status === 'queued' || current.status === 'stalled' ? 'running' : current.status;
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE rc_jobs SET status=?, progress=?, current_step=?, checkpoint_json=?, error=?,
         started_at=COALESCE(started_at, datetime('now')), heartbeat_at=datetime('now'), updated_at=datetime('now')
         WHERE id=?`,
      ).run(
        status,
        clampProgress(patch.progress ?? current.progress),
        patch.current_step === undefined ? current.current_step : patch.current_step,
        JSON.stringify(checkpoint),
        patch.error === undefined ? current.error : patch.error,
        id,
      );
      if (patch.step_key) {
        const existing = this.db.prepare(
          'SELECT * FROM rc_job_steps WHERE job_id=? AND step_key=?',
        ).get(id, patch.step_key) as StepRow | undefined;
        const stepCheckpoint = { ...parseJson(existing?.checkpoint_json ?? null, {}), ...(patch.step_checkpoint ?? {}) };
        this.db.prepare(
          `INSERT INTO rc_job_steps (job_id, step_key, label, status, attempt, progress, checkpoint_json, error, started_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ?='running' THEN datetime('now') END,
             CASE WHEN ? IN ('completed','failed','skipped') THEN datetime('now') END)
           ON CONFLICT(job_id, step_key) DO UPDATE SET label=excluded.label, status=excluded.status,
             attempt=CASE WHEN excluded.status='running' AND rc_job_steps.status!='running' THEN rc_job_steps.attempt+1 ELSE rc_job_steps.attempt END,
             progress=excluded.progress, checkpoint_json=excluded.checkpoint_json, error=excluded.error,
             started_at=COALESCE(rc_job_steps.started_at, excluded.started_at),
             completed_at=excluded.completed_at, updated_at=datetime('now')`,
        ).run(
          id, patch.step_key, patch.step_label ?? existing?.label ?? patch.step_key,
          patch.step_status ?? existing?.status ?? 'running', existing?.attempt ?? 0,
          clampProgress(patch.step_progress ?? existing?.progress ?? 0), JSON.stringify(stepCheckpoint),
          patch.error ?? null, patch.step_status ?? 'running', patch.step_status ?? 'running',
        );
      }
    });
    tx();
    return this.get(id);
  }

  finish(id: string, status: Extract<JobStatus, 'completed' | 'partial' | 'failed' | 'cancelled'>, result?: unknown, error?: string): Job {
    const current = this.get(id);
    if (current.status === 'cancelled') return current;
    this.db.prepare(
      `UPDATE rc_jobs SET status=?, progress=CASE WHEN ?='completed' THEN 100 ELSE progress END,
       result_json=?, error=?, completed_at=datetime('now'), heartbeat_at=datetime('now'), updated_at=datetime('now')
       WHERE id=?`,
    ).run(status, status, result === undefined ? null : JSON.stringify(result), error ?? null, id);
    return this.get(id);
  }

  resume(id: string, currentStep = 'Resumed by user'): Job {
    const job = this.get(id);
    const progress = job.status === 'completed' || job.status === 'cancelled' ? 0 : job.progress;
    const checkpoint = {
      ...job.checkpoint,
      resume_requested_at: formatDbDate(Date.now()),
      resume_requested_step: currentStep,
    };
    this.db.prepare(
      `UPDATE rc_jobs SET status='running', progress=?, current_step=?, error=NULL,
       checkpoint_json=?,
       completed_at=NULL, started_at=COALESCE(started_at, datetime('now')),
       heartbeat_at=datetime('now'), updated_at=datetime('now') WHERE id=?`,
    ).run(progress, currentStep, JSON.stringify(checkpoint), id);
    return this.get(id);
  }

  cancel(id: string, reason = 'Cancelled by user'): Job {
    return this.finish(id, 'cancelled', undefined, reason);
  }

  markStalled(staleSeconds = 90, queuedStaleSeconds = 600): number {
    const tx = this.db.transaction(() => {
      // Running jobs whose worker heartbeat expired.
      const running = this.db.prepare(
        `UPDATE rc_jobs SET status='stalled', error=COALESCE(error, 'Worker heartbeat expired'), updated_at=datetime('now')
         WHERE status='running' AND heartbeat_at IS NOT NULL
         AND heartbeat_at < datetime('now', '-' || ? || ' seconds')`,
      ).run(Math.max(30, staleSeconds)).changes;
      // Queued jobs (e.g. auto-tracked long tasks) where the OpenClaw subagent
      // never started. Without this they would sit in 'queued' forever, since the
      // heartbeat sweep above only touches 'running'. Surfacing them as 'stalled'
      // lets the panel offer resume/retry; a real spawn that arrives later still
      // wins via upsertExternal's status precedence.
      const queued = this.db.prepare(
        `UPDATE rc_jobs SET status='stalled', error=COALESCE(error, '后台子会话未能按时启动'), updated_at=datetime('now')
         WHERE status='queued'
         AND created_at < datetime('now', '-' || ? || ' seconds')`,
      ).run(Math.max(60, queuedStaleSeconds)).changes;
      return running + queued;
    });
    return tx();
  }

  /**
   * Find a pre-created auto long-task job still awaiting its OpenClaw subagent,
   * keyed by the parent session that issued sessions_spawn. Used to bind a synced
   * child session back onto the tracked job when the child transcript did not echo
   * the Research-Claw Job ID. Only 'queued'/'stalled' jobs whose session_key still
   * points at the parent are bindable — once bound, session_key becomes the child
   * key, so a job is never re-bound.
   */
  findBindableLongTask(parentSessionKey: string): Job | null {
    if (!parentSessionKey) return null;
    const row = this.db.prepare(
      `SELECT * FROM rc_jobs
       WHERE id LIKE 'longtask:%' AND session_key = ?
       AND status IN ('queued','stalled')
       ORDER BY created_at DESC LIMIT 1`,
    ).get(parentSessionKey) as JobRow | undefined;
    return row ? this.mapJob(row) : null;
  }

  /**
   * Recover the ordering where job_checkpoint binds the pre-created long task
   * to the child session before the OpenClaw session index is synchronized.
   * Without this exact-session lookup the sync layer creates a duplicate
   * openclaw:<sessionId> row for the same execution.
   */
  findActiveLongTaskForSession(sessionKey: string): Job | null {
    if (!sessionKey) return null;
    const row = this.db.prepare(
      `SELECT * FROM rc_jobs
       WHERE id LIKE 'longtask:%' AND session_key = ?
       AND status IN ('queued','running','stalled')
       ORDER BY created_at DESC LIMIT 1`,
    ).get(sessionKey) as JobRow | undefined;
    return row ? this.mapJob(row) : null;
  }

  /**
   * Delete only the deterministic mirror created before a child transcript had
   * enough bytes to reveal its durable Research-Claw Job ID. The exact id,
   * type, and child session must all match so unrelated/historical jobs are
   * never pruned by this recovery path.
   */
  removeProvisionalOpenClawMirror(
    sessionId: string,
    sessionKey: string,
    targetJobId: string,
  ): boolean {
    const provisionalId = `openclaw:${sessionId}`;
    if (!sessionId || !sessionKey || provisionalId === targetJobId) return false;
    return this.db.prepare(
      `DELETE FROM rc_jobs
       WHERE id = ? AND type = 'openclaw-subagent' AND session_key = ?`,
    ).run(provisionalId, sessionKey).changes > 0;
  }

  /** Delete terminal jobs older than maxAgeDays (steps cascade). Returns rows removed. */
  pruneOld(maxAgeDays = 30): number {
    const days = Math.max(1, Math.round(maxAgeDays));
    const result = this.db.prepare(
      `DELETE FROM rc_jobs
       WHERE status IN ('completed','partial','failed','cancelled')
       AND updated_at < datetime('now', '-' || ? || ' days')`,
    ).run(days);
    return result.changes;
  }

  private mapJob(row: JobRow): Job {
    const { input_json, result_json, checkpoint_json, ...rest } = row;
    return {
      ...rest,
      input: parseJson(input_json, {}),
      result: parseJson(result_json, null),
      checkpoint: parseJson(checkpoint_json, {}),
    };
  }
}
