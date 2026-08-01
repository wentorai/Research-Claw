import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGatewayStore } from './gateway';
import {
  executionKey,
  resetPresentationRetryCoordinatorForTests,
  useExecutionTraceStore,
} from './execution-trace';

describe('shared execution-details coordinator', () => {
  const request = vi.fn();

  beforeEach(() => {
    request.mockReset();
    useGatewayStore.setState({
      client: { isConnected: true, request } as never,
      state: 'connected',
    });
    useExecutionTraceStore.setState({
      activeSessionKey: null,
      generation: 0,
      summaries: {},
      details: {},
      presentations: {},
      availability: {},
    });
  });

  afterEach(() => {
    resetPresentationRetryCoordinatorForTests();
    vi.useRealTimers();
  });

  it('loads summary and presentation under one session-scoped Run identity', async () => {
    request.mockImplementation(async (method: string) => method === 'rc.execution.summary'
      ? { summaries: { runA: { toolCount: 2, errorCount: 1, skillCount: 1 } } }
      : { presentations: { runA: { runId: 'runA', recordsRevision: 1, files: [], paperBatches: [] } } });

    await useExecutionTraceStore.getState().loadRuns('session-a', ['runA', 'runA', '']);

    expect(request).toHaveBeenCalledWith('rc.execution.summary', {
      sessionKey: 'agent:main:session-a', runIds: ['runA'],
    });
    expect(request).toHaveBeenCalledWith('rc.execution.presentations', {
      sessionKey: 'agent:main:session-a', runIds: ['runA'],
    });
    const key = executionKey('session-a', 'runA');
    expect(useExecutionTraceStore.getState().summaries[key]?.toolCount).toBe(2);
    expect(useExecutionTraceStore.getState().presentations[key]?.recordsRevision).toBe(1);
  });

  it('batches all 101 visible Runs instead of slicing away the last one', async () => {
    request.mockImplementation(async (method: string, params: { runIds: string[] }) => (
      method === 'rc.execution.summary'
        ? { summaries: Object.fromEntries(params.runIds.map((runId) => [runId, { toolCount: 1, errorCount: 0, skillCount: 0 }])) }
        : { presentations: Object.fromEntries(params.runIds.map((runId) => [runId, { runId, recordsRevision: 1, files: [], paperBatches: [] }])) }
    ));
    const runIds = Array.from({ length: 101 }, (_, index) => `run-${index + 1}`);
    await useExecutionTraceStore.getState().loadRuns('session-a', runIds);
    const summaryCalls = request.mock.calls.filter(([method]) => method === 'rc.execution.summary');
    expect(summaryCalls.map((call) => call[1].runIds.length)).toEqual([100, 1]);
    expect(useExecutionTraceStore.getState().summaries[executionKey('session-a', 'run-101')]).toBeTruthy();
  });

  it('preserves one side when summary or cards fail independently', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'rc.execution.summary') throw new Error('summary unavailable');
      return { presentations: { runA: { runId: 'runA', recordsRevision: 2, files: [], paperBatches: [] } } };
    });
    await useExecutionTraceStore.getState().loadRuns('session-a', ['runA']);
    expect(useExecutionTraceStore.getState().summaries[executionKey('session-a', 'runA')]).toBeUndefined();
    expect(useExecutionTraceStore.getState().presentations[executionKey('session-a', 'runA')]?.recordsRevision).toBe(2);
  });

  it('never retries session-scoped execution RPCs without their sessionKey', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'rc.supervisor.reviews.list') return { reviews: [] };
      throw new Error('scoped request unavailable');
    });

    await useExecutionTraceStore.getState().loadRuns('session-a', ['runA']);
    await expect(useExecutionTraceStore.getState().loadDetail('session-a', 'runA'))
      .rejects.toThrow('scoped request unavailable');

    expect(request.mock.calls.filter(([method]) => method === 'rc.execution.summary'))
      .toEqual([['rc.execution.summary', {
        sessionKey: 'agent:main:session-a', runIds: ['runA'],
      }]]);
    expect(request.mock.calls.filter(([method]) => method === 'rc.execution.detail'))
      .toEqual([['rc.execution.detail', {
        sessionKey: 'agent:main:session-a', runId: 'runA',
      }]]);
  });

  it('drops a late session-A response after a rapid switch to session B', async () => {
    const resolveA: Array<{ method: string; resolve: (value: unknown) => void }> = [];
    request.mockImplementation((method: string, params: { sessionKey: string }) => {
      if (params.sessionKey === 'agent:main:session-a') return new Promise((resolve) => { resolveA.push({ method, resolve }); });
      return Promise.resolve(method === 'rc.execution.summary' ? { summaries: {} } : { presentations: {} });
    });
    const lateA = useExecutionTraceStore.getState().loadRuns('session-a', ['run-a']);
    await useExecutionTraceStore.getState().loadRuns('session-b', ['run-b']);
    for (const pending of resolveA) {
      pending.resolve(pending.method === 'rc.execution.summary'
        ? { summaries: { 'run-a': { toolCount: 9, errorCount: 0, skillCount: 0 } } }
        : { presentations: { 'run-a': { runId: 'run-a', recordsRevision: 9, files: [], paperBatches: [] } } });
    }
    await lateA;
    expect(useExecutionTraceStore.getState().summaries[executionKey('session-a', 'run-a')]).toBeUndefined();
  });

  it('merges exact-run tools, Skills, and trusted reviews into one detail', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'rc.execution.detail') {
        return {
          runId: 'runA',
          tools: [{ id: 't1', tool_name: 'read', status: 'completed', duration_ms: 18, error: null }],
          skills: [{ id: 's1', skill_name: 'wentor-network', activation: 'read', skill_source: 'research-plugins' }],
          skillEvents: [],
        };
      }
      return { reviews: [{ reviewId: 'r1', state: 'completed', verdict: 'pass', findings: [] }] };
    });

    await useExecutionTraceStore.getState().loadDetail('session-a', 'runA');

    expect(request).toHaveBeenCalledWith('rc.execution.detail', {
      sessionKey: 'agent:main:session-a', runId: 'runA',
    });
    expect(useExecutionTraceStore.getState().details[executionKey('session-a', 'runA')]).toMatchObject({
      tools: [{ tool_name: 'read' }], skills: [{ skill_name: 'wentor-network' }], reviews: [{ reviewId: 'r1' }],
    });
  });

  it('rechecks a terminal session.tool event until the delayed after-hook record appears', async () => {
    vi.useFakeTimers();
    let presentationCalls = 0;
    request.mockImplementation(async (method: string) => {
      if (method !== 'rc.execution.presentations') return { summaries: {} };
      presentationCalls += 1;
      return presentationCalls === 1
        ? { presentations: {} }
        : { presentations: { runA: { runId: 'runA', recordsRevision: 1, files: [], paperBatches: [] } } };
    });
    useExecutionTraceStore.setState({ activeSessionKey: 'session-a', generation: 1 });

    const coordinator = useExecutionTraceStore.getState();
    coordinator.schedulePresentationRefresh('session-a', 'runA', 'toolA');
    coordinator.schedulePresentationRefresh('session-a', 'runA', 'toolA');

    await vi.advanceTimersByTimeAsync(100);
    expect(presentationCalls).toBe(1);
    expect(useExecutionTraceStore.getState().presentations[executionKey('session-a', 'runA')]).toBeUndefined();

    await vi.advanceTimersByTimeAsync(400);
    expect(presentationCalls).toBe(2);
    expect(useExecutionTraceStore.getState().presentations[executionKey('session-a', 'runA')]?.recordsRevision).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(presentationCalls).toBe(2);
  });

  it('bounds terminal rechecks and cancels them after a session switch', async () => {
    vi.useFakeTimers();
    request.mockResolvedValue({ presentations: {} });
    useExecutionTraceStore.setState({ activeSessionKey: 'session-a', generation: 1 });

    useExecutionTraceStore.getState().schedulePresentationRefresh('session-a', 'runA', 'toolA');
    await vi.advanceTimersByTimeAsync(100);
    expect(request).toHaveBeenCalledTimes(1);

    useExecutionTraceStore.getState().activateSession('session-b');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(useExecutionTraceStore.getState().presentations[executionKey('session-a', 'runA')]).toBeUndefined();
  });
});
