import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGatewayStore } from './gateway';
import { useExecutionTraceStore } from './execution-trace';

describe('execution trace store', () => {
  const request = vi.fn();

  beforeEach(() => {
    request.mockReset();
    useGatewayStore.setState({
      client: { isConnected: true, request } as never,
      state: 'connected',
    });
    useExecutionTraceStore.setState({ summaries: {}, details: {} });
  });

  it('deduplicates run IDs and loads summary counts in one RPC', async () => {
    request.mockResolvedValueOnce({
      summaries: {
        runA: { toolCount: 2, errorCount: 1, skillCount: 1 },
      },
    });

    await useExecutionTraceStore.getState().loadSummaries(['runA', 'runA', '']);

    expect(request).toHaveBeenCalledWith('rc.execution.summary', { runIds: ['runA'] });
    expect(useExecutionTraceStore.getState().summaries.runA).toEqual({
      toolCount: 2,
      errorCount: 1,
      skillCount: 1,
    });
  });

  it('merges exact-run tools, Skills, and trusted reviews into one detail', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'rc.execution.detail') {
        return {
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
            skill_source: '/plugins/wentor-network/SKILL.md',
          }],
          skillEvents: [{
            id: 'se1',
            skill_key: 'rp:wentor-network',
            skill_name: 'wentor-network',
            skill_source: 'research-plugins',
            lifecycle: 'candidate',
            activation: null,
            tool_call_id: 'call-search',
            observed_at: 10,
          }],
        };
      }
      return {
        reviews: [{
          reviewId: 'r1',
          state: 'completed',
          verdict: 'pass',
          findings: [],
        }],
      };
    });

    await useExecutionTraceStore.getState().loadDetail('runA');

    expect(request).toHaveBeenCalledWith('rc.execution.detail', { runId: 'runA' });
    expect(request).toHaveBeenCalledWith('rc.supervisor.reviews.list', {
      runId: 'runA',
      limit: 20,
    });
    expect(useExecutionTraceStore.getState().details.runA).toMatchObject({
      runId: 'runA',
      tools: [{ tool_name: 'read' }],
      skills: [{ skill_name: 'wentor-network' }],
      skillEvents: [{ skill_name: 'wentor-network', lifecycle: 'candidate' }],
      reviews: [{ reviewId: 'r1' }],
    });
  });
});
