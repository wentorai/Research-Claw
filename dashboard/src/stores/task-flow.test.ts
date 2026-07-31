import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { selectTaskFlow, useTaskFlowStore } from './task-flow';

describe('task flow session isolation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useTaskFlowStore.getState().clear();
  });

  afterEach(() => {
    useTaskFlowStore.getState().clear();
    vi.useRealTimers();
  });

  it('keeps concurrent A/B flows independent across terminal cleanup', () => {
    const store = useTaskFlowStore.getState();
    store.startRun('run-a', 'project-a');
    store.startRun('run-b', 'project-b');

    expect(selectTaskFlow(useTaskFlowStore.getState(), 'project-a')?.runId).toBe('run-a');
    expect(selectTaskFlow(useTaskFlowStore.getState(), 'project-b')?.runId).toBe('run-b');

    store.endRun('run-a', 'done');
    expect(selectTaskFlow(useTaskFlowStore.getState(), 'project-a')?.activeIndex).toBe(-1);
    expect(selectTaskFlow(useTaskFlowStore.getState(), 'project-b')?.activeIndex).toBe(0);

    vi.advanceTimersByTime(4_000);
    expect(selectTaskFlow(useTaskFlowStore.getState(), 'project-a')).toBeNull();
    expect(selectTaskFlow(useTaskFlowStore.getState(), 'project-b')?.runId).toBe('run-b');
  });

  it('clears only the requested session flow', () => {
    const store = useTaskFlowStore.getState();
    store.startRun('run-a', 'project-a');
    store.startRun('run-b', 'project-b');
    store.clear('project-a');

    expect(selectTaskFlow(useTaskFlowStore.getState(), 'project-a')).toBeNull();
    expect(selectTaskFlow(useTaskFlowStore.getState(), 'project-b')?.runId).toBe('run-b');
  });
});
