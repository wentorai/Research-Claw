import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { JobService, type JobStatus } from './service.js';
import { formatJobTitleFromMessage } from './title.js';
import {
  createJobOrchestrationPolicy,
  createSubagentSyncSteps,
  mergeJobSteps,
} from './protocol.js';

interface Logger {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
}

interface SessionIndexEntry {
  label?: string;
  status?: string;
  sessionId?: string;
  sessionFile?: string;
  spawnedBy?: string;
  subagentRole?: string;
  spawnDepth?: number;
  updatedAt?: number;
  startedAt?: number;
  sessionStartedAt?: number;
  lastInteractionAt?: number;
  model?: string;
  modelProvider?: string;
}

export interface OpenClawSessionJobSyncOptions {
  sessionsJsonPath?: string;
  maxAgeDays?: number;
  maxSessions?: number;
  staleAfterMs?: number;
  logger?: Logger;
}

export function defaultOpenClawSessionsJsonPath(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw');
  return path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json');
}

export function syncOpenClawSubagentJobs(
  service: JobService,
  options: OpenClawSessionJobSyncOptions = {},
): { synced: number; path: string } {
  const sessionsPath = options.sessionsJsonPath ?? defaultOpenClawSessionsJsonPath();
  const maxAgeMs = Math.max(1, options.maxAgeDays ?? 14) * 24 * 60 * 60 * 1000;
  const maxSessions = Math.max(1, Math.min(options.maxSessions ?? 100, 500));
  const staleAfterMs = Math.max(60_000, options.staleAfterMs ?? 30 * 60_000);
  let raw: string;
  try {
    raw = fs.readFileSync(sessionsPath, 'utf8');
  } catch {
    return { synced: 0, path: sessionsPath };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    options.logger?.warn?.(`[Jobs] Failed to parse OpenClaw sessions index: ${err instanceof Error ? err.message : String(err)}`);
    return { synced: 0, path: sessionsPath };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { synced: 0, path: sessionsPath };

  const now = Date.now();
  const seenFiles = new Set<string>();
  const entries = Object.entries(parsed as Record<string, SessionIndexEntry>)
    .filter(([key, session]) => isSubagentSession(key, session))
    .filter(([, session]) => typeof session.sessionId === 'string')
    .filter(([, session]) => {
      const ts = session.updatedAt ?? session.startedAt ?? session.sessionStartedAt ?? 0;
      return !ts || now - ts <= maxAgeMs;
    })
    .sort(([, a], [, b]) => (b.updatedAt ?? b.startedAt ?? 0) - (a.updatedAt ?? a.startedAt ?? 0))
    .slice(0, maxSessions);

  let synced = 0;
  // Entries are newest-first. A Gateway-restart recovery can leave an older
  // interrupted child and a newer replacement carrying the same durable Job
  // ID. Let the newest child claim that Job once per sweep so the older session
  // cannot overwrite the replacement later in this loop.
  const claimedJobIds = new Set<string>();
  for (const [sessionKey, session] of entries) {
    try {
      const sessionId = session.sessionId;
      if (!sessionId) continue;
      const transcript = inspectSessionTranscriptCached(session.sessionFile);
      if (session.sessionFile) seenFiles.add(session.sessionFile);
      // Resolve the target job id in priority order:
      //   1. Job ID echoed in the child transcript (exact, preferred).
      //   2. An active long-task already checkpoint-bound to this exact child.
      //   3. A still-pending long-task job spawned by this session's parent
      //      (heuristic rebind — avoids orphaning the tracked job when the model
      //      forgot to print the Job ID).
      //   4. A fresh openclaw:<sessionId> row.
      let jobId = transcript.jobId;
      let existingJob = jobId ? getExistingJob(service, jobId) : null;
      if (!jobId) {
        const bound = service.findActiveLongTaskForSession(sessionKey);
        if (bound) { jobId = bound.id; existingJob = bound; }
      }
      if (!jobId && session.spawnedBy) {
        const bound = service.findBindableLongTask(session.spawnedBy);
        if (bound) { jobId = bound.id; existingJob = bound; }
      }
      if (!jobId) jobId = `openclaw:${sessionId}`;
      if (claimedJobIds.has(jobId)) continue;
      claimedJobIds.add(jobId);
      const mappedStatus = mapOpenClawStatus(session.status, session.updatedAt, now, staleAfterMs);
      const preserveResumeRequest = shouldPreserveResumeRequest(existingJob, mappedStatus, session.updatedAt, now);
      const status = preserveResumeRequest ? 'running' : mappedStatus;
      const startedAt = formatDbDate(session.startedAt ?? session.sessionStartedAt);
      const updatedAt = formatDbDate(session.updatedAt ?? session.lastInteractionAt);
      const completedAt = isTerminal(status) ? updatedAt : null;
      const title = existingJob?.title
        ?? formatJobTitleFromMessage(transcript.title || session.label || `子任务 ${sessionId.slice(0, 8)}`, 'OpenClaw 子任务');
      const currentStep = preserveResumeRequest
        ? existingJob?.current_step ?? '已请求 OpenClaw 子会话继续'
        : currentStepFor(status, session.updatedAt, transcript.latestText);
      const message = transcript.title || existingJob?.input?.message;
      const references = Array.isArray(existingJob?.input?.references)
        ? existingJob.input.references.filter((item): item is string => typeof item === 'string')
        : [];
      const orchestration = existingJob?.input?.orchestration && typeof existingJob.input.orchestration === 'object'
        ? existingJob.input.orchestration
        : createJobOrchestrationPolicy({
          source: 'openclaw-subagent',
          message: typeof message === 'string' ? message : title,
          references,
        });
      const steps = mergeJobSteps(existingJob?.steps, createSubagentSyncSteps({
        status,
        latestText: transcript.latestText,
        error: transcript.error ?? currentStep,
        startedAt,
        completedAt,
      }));

      service.upsertExternal({
        id: jobId,
        type: 'openclaw-subagent',
        title,
        session_key: sessionKey,
        status,
        progress: progressFor(status),
        current_step: currentStep,
        input: {
          // Preserve the original submission payload (message / references /
          // detection from rc.longTask.submit) when binding a sync result back
          // onto a pre-created long-task job; only the linkage fields below are
          // refreshed. Without the spread, the queued job's input was clobbered.
          ...(existingJob?.input ?? {}),
          source: 'openclaw-subagent',
          linked_job_id: jobId,
          bound_via: transcript.jobId ? 'transcript' : (existingJob ? 'spawned_by' : 'session'),
          session_id: sessionId,
          session_key: sessionKey,
          spawned_by: session.spawnedBy,
          session_file: session.sessionFile,
          model: session.model,
          provider: session.modelProvider,
          orchestration,
        },
        checkpoint: {
          ...(existingJob?.checkpoint ?? {}),
          openclaw_status: session.status ?? 'unknown',
          updated_at: updatedAt,
          latest_text: transcript.latestText,
          protocol: (orchestration as { protocol?: unknown }).protocol ?? 'bootstrap-2026-06-21',
          resume_policy: (orchestration as { checkpoint_policy?: unknown }).checkpoint_policy ?? 'resume-from-latest',
          self_check_required: Boolean((orchestration as { self_check_required?: unknown }).self_check_required),
        },
        result: status === 'completed' ? { summary: transcript.latestText } : undefined,
        error: status === 'failed' || status === 'stalled' ? transcript.error ?? currentStep : null,
        heartbeat_at: status === 'running' ? formatDbDate(now) : updatedAt,
        started_at: startedAt,
        completed_at: completedAt,
        updated_at: updatedAt,
        steps,
      });
      service.removeProvisionalOpenClawMirror(sessionId, sessionKey, jobId);
      synced++;
    } catch (err) {
      options.logger?.warn?.(`[Jobs] Failed to sync OpenClaw subagent job: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  pruneTranscriptCache(seenFiles);
  return { synced, path: sessionsPath };
}

function getExistingJob(service: JobService, id: string): ReturnType<JobService['get']> | null {
  try {
    return service.get(id);
  } catch {
    return null;
  }
}

function shouldPreserveResumeRequest(
  job: ReturnType<JobService['get']> | null,
  incomingStatus: JobStatus,
  sessionUpdatedAt: number | undefined,
  now: number,
): boolean {
  if (!job || job.status !== 'running') return false;
  if (!['cancelled', 'failed', 'stalled'].includes(incomingStatus)) return false;
  const raw = job.checkpoint.resume_requested_at;
  if (typeof raw !== 'string') return false;
  const resumeMs = Date.parse(`${raw.replace(' ', 'T')}Z`);
  if (Number.isNaN(resumeMs) || now - resumeMs > 5 * 60_000) return false;
  return !sessionUpdatedAt || sessionUpdatedAt < resumeMs;
}

function isSubagentSession(key: string, session: SessionIndexEntry): boolean {
  return key.includes(':subagent:') || session.subagentRole === 'leaf' || typeof session.spawnedBy === 'string' || Number(session.spawnDepth ?? 0) > 0;
}

function mapOpenClawStatus(status: string | undefined, updatedAt: number | undefined, now: number, staleAfterMs: number): JobStatus {
  const normalized = (status ?? '').toLowerCase();
  if (['done', 'completed', 'success', 'succeeded'].includes(normalized)) return 'completed';
  if (['failed', 'error'].includes(normalized)) return 'failed';
  if (['cancelled', 'canceled', 'aborted'].includes(normalized)) return 'cancelled';
  if (normalized === 'queued') return 'queued';
  if (updatedAt && now - updatedAt > staleAfterMs) return 'stalled';
  return 'running';
}

function progressFor(status: JobStatus): number {
  switch (status) {
    case 'completed': return 100;
    case 'failed':
    case 'cancelled': return 100;
    case 'stalled': return 50;
    case 'queued': return 0;
    default: return 25;
  }
}

function currentStepFor(status: JobStatus, updatedAt: number | undefined, latestText: string | null): string {
  if (status === 'completed') return latestText ? `已完成：${latestText.slice(0, 80)}` : 'OpenClaw 子会话已完成';
  if (status === 'failed') return 'OpenClaw 子会话失败';
  if (status === 'cancelled') return 'OpenClaw 子会话已取消';
  if (status === 'stalled') return 'OpenClaw 子会话长时间未更新';
  if (status === 'queued') return 'OpenClaw 子会话等待启动';
  const suffix = updatedAt ? `，最后活动 ${formatDbDate(updatedAt)}` : '';
  return `OpenClaw 子会话运行中${suffix}`;
}

function isTerminal(status: JobStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'partial';
}

function formatDbDate(value: number | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

interface TranscriptInfo { title: string | null; latestText: string | null; error: string | null; jobId: string | null }

// Re-parsing every subagent transcript (up to ~1MB JSONL each, ×100 sessions) on
// every sync is the dominant cost of the OpenClaw sweep, and it runs synchronously
// on the gateway thread. Cache the parsed result per file, keyed by (mtime, size),
// so a steady-state sweep only re-reads transcripts that actually changed. Status
// and stale detection are derived from sessions.json + `now` and still recompute
// every sweep, so freshness is unaffected.
interface TranscriptCacheEntry { mtimeMs: number; size: number; value: TranscriptInfo }
const transcriptCache = new Map<string, TranscriptCacheEntry>();
const EMPTY_TRANSCRIPT: TranscriptInfo = { title: null, latestText: null, error: null, jobId: null };

function inspectSessionTranscriptCached(sessionFile: string | undefined): TranscriptInfo {
  if (!sessionFile) return EMPTY_TRANSCRIPT;
  let mtimeMs: number;
  let size: number;
  try {
    const stat = fs.statSync(sessionFile);
    mtimeMs = stat.mtimeMs;
    size = stat.size;
  } catch {
    transcriptCache.delete(sessionFile);
    return EMPTY_TRANSCRIPT;
  }
  const cached = transcriptCache.get(sessionFile);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.value;
  const value = inspectSessionTranscript(sessionFile);
  transcriptCache.set(sessionFile, { mtimeMs, size, value });
  return value;
}

// Drop cache entries for sessions no longer in the active window so the map stays
// bounded by the live session count rather than growing forever.
function pruneTranscriptCache(seen: Set<string>): void {
  for (const key of transcriptCache.keys()) {
    if (!seen.has(key)) transcriptCache.delete(key);
  }
}

function inspectSessionTranscript(sessionFile: string | undefined): TranscriptInfo {
  if (!sessionFile) return { title: null, latestText: null, error: null, jobId: null };
  let raw: string;
  try {
    const stat = fs.statSync(sessionFile);
    const maxBytes = 1_000_000;
    const fd = fs.openSync(sessionFile, 'r');
    try {
      const length = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
      raw = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { title: null, latestText: null, error: null, jobId: null };
  }

  let title: string | null = null;
  let latestText: string | null = null;
  let error: string | null = null;
  let jobId: string | null = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as { message?: Record<string, unknown> };
      const message = record.message;
      if (!message) continue;
      if (typeof message.errorMessage === 'string') error = message.errorMessage;
      const text = extractContentText(message.content);
      if (!text) continue;
      if (!jobId) jobId = extractResearchClawJobId(text);
      if (!title && message.role === 'user') title = extractTaskTitle(text);
      if (message.role === 'assistant') latestText = normalizeText(text);
    } catch {
      // Ignore partial/truncated JSONL lines.
    }
  }
  return { title, latestText, error, jobId };
}

function extractContentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
      parts.push(item.text);
    }
  }
  return parts.length ? parts.join('\n') : null;
}

function extractTaskTitle(text: string): string | null {
  const linePatterns = [
    /##\s*任务[:：]\s*([^\r\n#]+)/,
    /任务[:：]\s*([^\r\n。]{4,80})/,
    /\[Subagent Task\]\s*#+\s*([^\r\n#]+)/,
  ];
  for (const pattern of linePatterns) {
    const match = text.match(pattern);
    const title = match?.[1] ? normalizeText(match[1]) : '';
    if (title) return title.slice(0, 120);
  }

  const normalized = normalizeText(text);
  const inlineMatch = normalized.match(/任务[:：]\s*([^。]{4,80})/);
  if (inlineMatch?.[1]) {
    const title = inlineMatch[1].replace(/\s+Begin\.?$/i, '').trim();
    if (title) return title.slice(0, 120);
  }
  return null;
}

function extractResearchClawJobId(text: string): string | null {
  const match = text.match(/Research-Claw\s+Job\s+ID\s*[:：]\s*([A-Za-z0-9:_-]+)/i)
    ?? text.match(/\bjob_id\s*[:：]\s*([A-Za-z0-9:_-]+)/i);
  const id = match?.[1]?.trim();
  if (!id) return null;
  return /^(?:longtask|openclaw):[A-Za-z0-9:_-]+$/.test(id) ? id : null;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
