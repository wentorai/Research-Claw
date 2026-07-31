import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCEPTANCE_JOB_STOP_ACTIVE_TASKS,
  ACCEPTANCE_JOB_STOP_WRAPPER_TASK_ID,
} from '../__fixtures__/gateway-payloads/long-run-incidents';
import type { GatewayClient } from '../gateway/client';
import { useGatewayStore } from './gateway';
import { chooseLiveSessionKey, collapseMirroredOpenClawJobs, useJobsStore, type Job } from './jobs';

const activeJob: Job = {
  id: 'job-cancel',
  type: 'openclaw-subagent',
  title: 'Active child',
  session_key: 'agent:main:subagent:child',
  status: 'running',
  progress: 25,
  current_step: 'Running',
  error: null,
  heartbeat_at: null,
  created_at: '2026-08-01 00:00:00',
  updated_at: '2026-08-01 00:00:00',
  completed_at: null,
};

const cancelledJob: Job = {
  ...activeJob,
  status: 'cancelled',
  error: 'Cancelled from Research-Claw Jobs panel',
};

describe('chooseLiveSessionKey', () => {
  it('returns null when there are no linked session candidates', () => {
    expect(chooseLiveSessionKey([], new Set(['agent:main']))).toBeNull();
  });

  it('stays optimistic (first candidate) when existence cannot be determined', () => {
    // knownKeys === null models a gateway without sessions.list — must not block resume.
    expect(chooseLiveSessionKey(['agent:main:subagent:abc', 'agent:main'], null)).toBe('agent:main:subagent:abc');
  });

  it('picks the first candidate that the gateway still knows about', () => {
    const known = new Set(['agent:main', 'agent:main:subagent:live']);
    expect(chooseLiveSessionKey(['agent:main:subagent:dead', 'agent:main:subagent:live'], known)).toBe('agent:main:subagent:live');
  });

  it('returns null when every linked session is gone, so the caller can fail loudly', () => {
    const known = new Set(['agent:main', 'unrelated:session']);
    expect(chooseLiveSessionKey(['agent:main:subagent:dead'], known)).toBeNull();
  });
});

describe('background Job projection', () => {
  it('shows one user job when an orphan OpenClaw mirror points to the same child session', () => {
    const userJob: Job = {
      ...activeJob,
      id: 'longtask:tracked',
      title: '批量整理论文',
    };
    const mirrorJob: Job = {
      ...activeJob,
      id: 'openclaw:child-session-id',
      title: 'OpenClaw 子任务: 子任务 child-se',
    };

    expect(collapseMirroredOpenClawJobs([mirrorJob, userJob])).toEqual([userJob]);
  });
});

describe('cancelJob outcome truthfulness', () => {
  const request = vi.fn();

  beforeEach(() => {
    request.mockReset();
    useJobsStore.setState({
      jobs: [activeJob],
      loading: false,
      lastLoadedAt: null,
      actionById: {},
    });
    useGatewayStore.setState({
      client: { isConnected: true, request } as unknown as GatewayClient,
      state: 'connected',
    });
  });

  afterEach(() => {
    useGatewayStore.setState({ client: null, state: 'disconnected' });
  });

  it('distinguishes durable Job cancellation from finding no active backing run', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'rc.job.cancel') return cancelledJob;
      if (method === 'tasks.list') return { tasks: [] };
      if (method === 'chat.abort') return { aborted: false };
      if (method === 'rc.job.list') return [cancelledJob];
      throw new Error(`unexpected RPC: ${method}`);
    });

    await expect(useJobsStore.getState().cancelJob(activeJob.id)).resolves.toEqual({
      jobCancelled: true,
      backingStop: 'not-active',
    });
    expect(useJobsStore.getState().jobs[0]?.status).toBe('cancelled');
  });

  it('reports backing-run uncertainty without undoing durable Job cancellation', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'rc.job.cancel') return cancelledJob;
      if (method === 'tasks.list') throw new Error('connection changed');
      if (method === 'chat.abort') throw new Error('connection changed');
      if (method === 'rc.job.list') return [cancelledJob];
      throw new Error(`unexpected RPC: ${method}`);
    });

    await expect(useJobsStore.getState().cancelJob(activeJob.id)).resolves.toEqual({
      jobCancelled: true,
      backingStop: 'unconfirmed',
    });
    expect(useJobsStore.getState().jobs[0]?.status).toBe('cancelled');
  });

  it('prioritizes the subagent wrapper over its active CLI mirror before reporting stopped', async () => {
    request.mockImplementation(async (method: string, params?: { taskId?: string }) => {
      if (method === 'rc.job.cancel') return cancelledJob;
      if (method === 'tasks.list') {
        return ACCEPTANCE_JOB_STOP_ACTIVE_TASKS;
      }
      if (method === 'tasks.cancel') {
        return { found: true, cancelled: true, task: { taskId: params?.taskId, status: 'cancelled' } };
      }
      if (method === 'rc.job.list') return [cancelledJob];
      throw new Error(`unexpected RPC: ${method}`);
    });

    await expect(useJobsStore.getState().cancelJob(activeJob.id)).resolves.toEqual({
      jobCancelled: true,
      backingStop: 'stopped',
    });
    expect(request.mock.calls.filter(([method]) => method === 'tasks.cancel')).toEqual([
      ['tasks.cancel', {
        taskId: ACCEPTANCE_JOB_STOP_WRAPPER_TASK_ID,
        reason: 'Cancelled from Research-Claw Jobs panel',
      }],
    ]);
  });

  it('does not treat found=true cancelled=false as proof that the backing run stopped', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'rc.job.cancel') return cancelledJob;
      if (method === 'tasks.list') {
        return {
          tasks: [{ taskId: 'subagent-task', runtime: 'subagent', status: 'running' }],
        };
      }
      if (method === 'tasks.cancel') {
        return { found: true, cancelled: false, reason: 'Subagent was not running.' };
      }
      if (method === 'chat.abort') return { aborted: false };
      if (method === 'rc.job.list') return [cancelledJob];
      throw new Error(`unexpected RPC: ${method}`);
    });

    await expect(useJobsStore.getState().cancelJob(activeJob.id)).resolves.toEqual({
      jobCancelled: true,
      backingStop: 'unconfirmed',
    });
  });
});
