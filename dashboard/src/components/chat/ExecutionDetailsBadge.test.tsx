import React from 'react';
import { App as AntdApp } from 'antd';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ExecutionDetailsBadge from './ExecutionDetailsBadge';
import { useExecutionTraceStore } from '../../stores/execution-trace';

describe('ExecutionDetailsBadge', () => {
  const loadDetail = vi.fn();

  beforeEach(() => {
    loadDetail.mockReset();
    useExecutionTraceStore.setState({
      summaries: {
        runA: { toolCount: 2, errorCount: 0, skillCount: 1 },
      },
      details: {},
      loadDetail,
    });
  });

  it('shows compact numeric counts and requests exact-run detail on click', async () => {
    loadDetail.mockResolvedValue(undefined);
    render(
      <AntdApp>
        <ExecutionDetailsBadge runId="runA" />
      </AntdApp>,
    );

    const button = screen.getByRole('button', {
      name: '调用 2 个工具，检测到 1 个 Skill',
    });
    expect(button).toHaveTextContent('2');
    expect(button).toHaveTextContent('S 1');

    fireEvent.click(button);
    await waitFor(() => expect(loadDetail).toHaveBeenCalledWith('runA'));
  });

  it('renders the persisted tool, Skill, and review detail', async () => {
    useExecutionTraceStore.setState({
      details: {
        runA: {
          runId: 'runA',
          tools: [{
            id: 't1',
            tool_name: 'read',
            status: 'completed',
            duration_ms: 18,
            error: null,
          }],
          skills: [{
            id: 's1',
            skill_name: 'wentor-network',
            activation: 'read',
            skill_source: 'workspace',
          }],
          reviews: [{
            reviewId: 'r1',
            state: 'completed',
            verdict: 'pass',
            findings: [],
          }],
        },
      },
    });
    render(
      <AntdApp>
        <ExecutionDetailsBadge runId="runA" />
      </AntdApp>,
    );

    fireEvent.click(screen.getByRole('button', {
      name: '调用 2 个工具，检测到 1 个 Skill',
    }));
    expect(await screen.findByText('read')).toBeInTheDocument();
    expect(screen.getByText('wentor-network')).toBeInTheDocument();
    expect(screen.getByText(/读取启用/)).toBeInTheDocument();
    expect(screen.getByText(/工作区/)).toBeInTheDocument();
    expect(screen.getByText('pass')).toBeInTheDocument();
  });
});
