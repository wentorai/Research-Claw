/** Dashboard-orchestrated IMRaD writing — one cron run per stage, file-based completion. */

import { normalizeSessionKey } from './session-key';

export const WRITING_STAGE_TIMEOUT_SECONDS = 300;

/** Extra buffer after stage timeout — file may land just after embedded abort. */
export const WRITING_POLL_GRACE_MS = 45_000;

export const WRITING_POLL_MS = 3000;

export type StagedWritingStageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export type StagedWritingJobStatus =
  | 'idle'
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled';

export interface StagedWritingStageState {
  id: string;
  outputPath: string;
  status: StagedWritingStageStatus;
  completedAtMs?: number;
  error?: string;
}

export interface StagedWritingJob {
  id: string;
  /** Dashboard session that owns this job — panel only shows here. */
  sessionKey?: string;
  slug: string;
  topic: string;
  /** Recent owning-session context copied into isolated stage runs. */
  contextText?: string;
  sourcePaths: string[];
  venue: string;
  locale: string;
  outputDir: string;
  startedAtMs: number;
  status: StagedWritingJobStatus;
  currentStageIndex: number;
  stages: StagedWritingStageState[];
  lastError: string | null;
}

export function slugifyWritingTopic(topic: string): string {
  const base = topic.trim().toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '');
  return (base || 'paper').slice(0, 48);
}

/** Each chat-triggered run gets a short unique directory without leaking the full prompt into paths. */
export function uniqueWritingSlug(_topic: string, jobId: string): string {
  const suffix = jobId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase() || 'run';
  return `paper-${suffix}`;
}

export function writingOutputDir(slug: string): string {
  const trimmed = slug.trim();
  return trimmed ? `outputs/drafts/${trimmed}` : 'outputs/drafts';
}

export function stagePollDeadlineMs(
  startedAtMs: number,
  timeoutSeconds = WRITING_STAGE_TIMEOUT_SECONDS,
): number {
  return startedAtMs + timeoutSeconds * 1000 + WRITING_POLL_GRACE_MS;
}

export function countCompletedStages(stages: StagedWritingStageState[]): number {
  return stages.filter((s) => s.status === 'done').length;
}

/** Legacy jobs without sessionKey are treated as `main`. */
export function resolveStagedWritingJobSessionKey(job: StagedWritingJob): string {
  return normalizeSessionKey(job.sessionKey) || 'main';
}

export function isStagedWritingJobForSession(
  job: StagedWritingJob | null | undefined,
  sessionKey: string,
): boolean {
  if (!job || job.status === 'cancelled') return false;
  return resolveStagedWritingJobSessionKey(job) === normalizeSessionKey(sessionKey);
}

export function formatWritingFailureReason(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return 'Writing step failed';
  if (/timed out|timeout/i.test(trimmed)) {
    return 'Step timed out while the model was generating. Completed sections are saved in the workspace.';
  }
  return trimmed;
}

export function isStagedWritingCronName(name: string | undefined): boolean {
  return Boolean(name && /\[rc-writing\]/i.test(name));
}

export interface StagedWritingCronSessionRow {
  key: string;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
}

function stagedWritingCronSessionLabel(session: StagedWritingCronSessionRow): string {
  return [session.label, session.displayName, session.derivedTitle, session.key]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(' ');
}

/** Sidebar: hide ephemeral staged-writing cron sessions. */
export function isStagedWritingCronSessionRow(session: StagedWritingCronSessionRow): boolean {
  if (/\[rc-writing\]/i.test(stagedWritingCronSessionLabel(session))) return true;
  return normalizeSessionKey(session.key).toLowerCase().startsWith('cron:rc-writing:');
}
