import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import JobsPanel from './JobsPanel';
import { useJobsStore, type Job } from '../../stores/jobs';

const gatewayMock = vi.hoisted(() => ({
  state: 'disconnected' as string,
  request: vi.fn(),
}));

const messageMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('../../stores/gateway', () => {
  const useGatewayStore = (selector: (state: typeof gatewayMock) => unknown) => selector(gatewayMock);
  useGatewayStore.getState = () => ({
    client: { isConnected: true, request: gatewayMock.request },
    state: gatewayMock.state,
  });
  return { useGatewayStore };
});

vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  const MockApp = Object.assign(
    (props: Record<string, unknown>) => (actual.App as unknown as (p: unknown) => unknown)(props),
    {
      ...actual.App,
      useApp: () => ({
        message: messageMock,
        modal: {},
        notification: {},
      }),
    },
  );
  return { ...actual, App: MockApp };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, params?: { count?: number }) =>
      params?.count === undefined ? key : `${key}:${params.count}`,
    i18n: { language: 'zh-CN' },
  }),
}));

const stalledJob: Job = {
  id: 'longtask:incident',
  type: 'openclaw-subagent',
  title: '批量整理论文',
  session_key: 'agent:main:subagent:child',
  status: 'stalled',
  progress: 25,
  current_step: 'OpenClaw 子会话运行中',
  error: 'Worker heartbeat expired',
  heartbeat_at: '2026-08-01 00:00:00',
  created_at: '2026-08-01 00:00:00',
  updated_at: '2026-08-01 00:01:00',
  completed_at: null,
  steps: [],
};
const originalCancelJob = useJobsStore.getState().cancelJob;

describe('JobsPanel user-facing refresh and status contract', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    gatewayMock.state = 'disconnected';
    gatewayMock.request.mockResolvedValue([stalledJob]);
    useJobsStore.setState({
      jobs: [stalledJob],
      loading: false,
      lastLoadedAt: null,
      actionById: {},
      cancelJob: originalCancelJob,
    });
  });

  afterEach(() => cleanup());

  it('exposes one clear refresh scope instead of a panel button plus one per card', () => {
    const { container } = render(<JobsPanel />);
    expect(container.querySelectorAll('.anticon-reload')).toHaveLength(1);
  });

  it('does not expose internal job type or raw worker error jargon', () => {
    const { container } = render(<JobsPanel />);
    expect(container.textContent).not.toContain('openclaw-subagent');
    expect(container.textContent).not.toContain('Worker heartbeat expired');
  });

  it('normalizes legacy system-owned job copy without rewriting user content', () => {
    useJobsStore.setState({
      jobs: [{
        ...stalledJob,
        id: 'openclaw:legacy-child',
        title: 'OpenClaw 子任务 legacy-child',
        current_step: 'OpenClaw 子会话长时间未更新',
        steps: [{
          job_id: 'openclaw:legacy-child',
          step_key: 'execute',
          label: 'OpenClaw 子会话执行',
          status: 'running',
          progress: 25,
          error: null,
          attempt: 1,
          updated_at: '2026-08-01 00:01:00',
        }],
      }],
    });

    const { container } = render(<JobsPanel />);
    fireEvent.click(screen.getByText(/jobs\.steps/));
    expect(container.textContent).not.toMatch(/OpenClaw|\bOC\b/i);
  });

  it('preserves custom step labels for jobs that are not system-owned session mirrors', () => {
    useJobsStore.setState({
      jobs: [{
        ...stalledJob,
        id: 'writing:user-owned',
        type: 'staged-writing',
        title: '我的分阶段写作',
        steps: [{
          job_id: 'writing:user-owned',
          step_key: 'execute',
          label: '用户自定义执行阶段',
          status: 'running',
          progress: 25,
          error: null,
          attempt: 1,
          updated_at: '2026-08-01 00:01:00',
        }],
      }],
    });

    render(<JobsPanel />);
    fireEvent.click(screen.getByText(/jobs\.steps/));

    expect(screen.getByText('用户自定义执行阶段')).toBeInTheDocument();
  });

  it('does not present checkpoint bookkeeping as a percentage of real work', () => {
    const { container } = render(<JobsPanel />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(container.textContent).not.toContain('25%');
  });

  it('does not describe a user-cancelled job as a generic failure or still working', () => {
    useJobsStore.setState({
      jobs: [{
        ...stalledJob,
        status: 'cancelled',
        current_step: 'OpenClaw 子会话运行中',
        error: 'Cancelled from Research-Claw Jobs panel',
      }],
    });
    const { container } = render(<JobsPanel />);

    expect(container.textContent).toContain('jobs.step.cancelled');
    expect(container.textContent).not.toContain('jobs.error.generic');
    expect(container.textContent).not.toContain('jobs.step.agentRunning');
  });

  it('tells the user when the Job is cancelled but the backing OC stop is unconfirmed', async () => {
    useJobsStore.setState({
      cancelJob: vi.fn().mockResolvedValue({
        jobCancelled: true,
        backingStop: 'unconfirmed',
      }),
    });
    render(<JobsPanel />);

    fireEvent.click(screen.getByRole('button', { name: /jobs\.cancel/ }));

    await waitFor(() => {
      expect(messageMock.warning).toHaveBeenCalledWith('jobs.cancelledBackingUnconfirmed');
    });
    expect(messageMock.success).not.toHaveBeenCalled();
  });
});
