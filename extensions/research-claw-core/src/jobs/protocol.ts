import type { JobStatus, JobStep, JobStepStatus } from './service.js';

export const JOB_ORCHESTRATION_PROTOCOL_VERSION = 'bootstrap-2026-06-21';

export interface JobOrchestrationPolicy {
  protocol: string;
  source: 'AGENTS.md' | 'auto-long-task' | 'openclaw-subagent' | 'job-tool';
  production_state_default: 'read-only';
  required_tool_routing: string[];
  allowed_writes: string[];
  prohibited_operations: string[];
  memory_write_boundary: string;
  checkpoint_policy: 'resume-from-latest';
  subagent_rules: string[];
  self_check_required: boolean;
}

export interface JobStepPatch {
  key: string;
  label: string;
  status?: JobStepStatus;
  progress?: number;
  checkpoint?: Record<string, unknown>;
  error?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

export function createJobOrchestrationPolicy(input: {
  source: JobOrchestrationPolicy['source'];
  message?: string;
  references?: string[];
}): JobOrchestrationPolicy {
  const allowedWrites = new Set([
    'job checkpoints',
    'task progress records',
    'outputs/',
    'reports/',
  ]);
  for (const reference of input.references ?? []) {
    const trimmed = reference.trim();
    if (trimmed) allowedWrites.add(trimmed);
  }

  return {
    protocol: JOB_ORCHESTRATION_PROTOCOL_VERSION,
    source: input.source,
    production_state_default: 'read-only',
    required_tool_routing: [
      'task_* / job_* for task state',
      'library_* / rc.lit.* for literature data',
      'workspace_* / rc.ws.* for workspace files',
      'config.patch / config.apply for provider config',
      'memory_* / memory_search for memory',
      'skill_search and Research-Plugins tools for research APIs',
    ],
    allowed_writes: [...allowedWrites],
    prohibited_operations: [
      'direct-production-db-mutation',
      'raw-config-or-secret-edit',
      'global-memory-update-without-explicit-request',
      'gateway-restart-without-approval',
      'git-add-commit-push-without-approval',
      'unrelated-job-creation',
      'bootstrap-or-onboarding-rerun',
      'irreversible-delete-or-bulk-move',
    ],
    memory_write_boundary: 'Only write inside MEMORY.md managed auto markers after explicit parent approval.',
    checkpoint_policy: 'resume-from-latest',
    subagent_rules: [
      'Use the assigned Research-Claw Job ID; do not create a replacement job.',
      'Treat production DBs, provider config, memory, and workspace roots as read-only unless explicitly allowed.',
      'Use product tools/RPC first; stop and report if the required tool is unavailable.',
      'Write only job checkpoints, requested outputs, reports, or explicitly scoped files.',
      'Do not restart gateways, install packages, update global memory, or run git operations.',
      'Run the Self-Check Agent before final output: verify scope, tool results, writes, checkpoint, and remaining risks.',
    ],
    self_check_required: true,
  };
}

export function createDefaultJobSteps(): JobStepPatch[] {
  return [
    { key: 'scope', label: '确认范围与边界', status: 'pending', progress: 0 },
    { key: 'execute', label: '执行任务', status: 'pending', progress: 0 },
    { key: 'review', label: '自检与回传', status: 'pending', progress: 0 },
  ];
}

export function createSubagentSyncSteps(input: {
  status: JobStatus;
  latestText?: string | null;
  error?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}): JobStepPatch[] {
  const executeStatus = stepStatusForJob(input.status);
  const executeProgress = executeProgressForJob(input.status);
  const reviewStatus = reviewStatusForJob(input.status);
  const reviewProgress = reviewStatus === 'completed' ? 100 : 0;
  return [
    {
      key: 'scope',
      label: '确认范围与边界',
      status: 'completed',
      progress: 100,
      checkpoint: { protocol: JOB_ORCHESTRATION_PROTOCOL_VERSION },
    },
    {
      key: 'execute',
      label: '科研智能体执行',
      status: executeStatus,
      progress: executeProgress,
      checkpoint: input.latestText ? { latest_text: input.latestText } : {},
      error: input.status === 'failed' || input.status === 'stalled' ? input.error ?? null : null,
      started_at: input.startedAt ?? null,
      completed_at: executeStatus === 'completed' || executeStatus === 'failed' ? input.completedAt ?? null : null,
    },
    {
      key: 'review',
      label: '自检与回传',
      status: reviewStatus,
      progress: reviewProgress,
      checkpoint: reviewStatus === 'completed'
        ? { self_check: ['scope', 'tool_results', 'writes', 'remaining_risks'] }
        : {},
      completed_at: reviewStatus === 'completed' ? input.completedAt ?? null : null,
    },
  ];
}

export function mergeJobSteps(existing: JobStep[] | undefined, next: JobStepPatch[]): JobStepPatch[] {
  const byKey = new Map<string, JobStepPatch>();
  for (const step of existing ?? []) {
    byKey.set(step.step_key, {
      key: step.step_key,
      label: step.label,
      status: step.status,
      progress: step.progress,
      checkpoint: step.checkpoint,
      error: step.error,
      started_at: step.started_at,
      completed_at: step.completed_at,
    });
  }
  for (const step of next) {
    const previous = byKey.get(step.key);
    byKey.set(step.key, {
      ...previous,
      ...step,
      checkpoint: { ...(previous?.checkpoint ?? {}), ...(step.checkpoint ?? {}) },
    });
  }
  return [...byKey.values()];
}

function stepStatusForJob(status: JobStatus): JobStepStatus {
  if (status === 'completed' || status === 'partial') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  if (status === 'queued') return 'pending';
  return 'running';
}

function executeProgressForJob(status: JobStatus): number {
  if (status === 'completed' || status === 'partial' || status === 'failed' || status === 'cancelled') return 100;
  if (status === 'stalled') return 50;
  if (status === 'queued') return 0;
  return 40;
}

function reviewStatusForJob(status: JobStatus): JobStepStatus {
  if (status === 'completed' || status === 'partial') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'skipped';
  return 'pending';
}
