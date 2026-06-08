import { describe, expect, it } from 'vitest';

import {
  advanceInferredOnStreamText,
  advanceInferredOnToolStart,
  applyExplicitStageReport,
  createInferredTaskFlow,
  parseTaskFlowStageReport,
} from './task-flow';

describe('task-flow', () => {
  it('starts with understand stage active', () => {
    const flow = createInferredTaskFlow('run-1', 'main', 1000);
    expect(flow.stages[0].status).toBe('active');
    expect(flow.stages[1].status).toBe('pending');
  });

  it('advances inferred flow on tool start', () => {
    const base = createInferredTaskFlow('run-1', 'main', 1000);
    const next = advanceInferredOnToolStart(base, 'rc.lit.search', 2000);
    expect(next.stages[0].status).toBe('done');
    expect(next.stages[1].status).toBe('active');
    expect(next.stages[1].detail).toBe('rc.lit.search');
  });

  it('advances inferred flow when streaming begins', () => {
    let flow = createInferredTaskFlow('run-1', 'main', 1000);
    flow = advanceInferredOnToolStart(flow, 'workspace_read', 2000);
    flow = advanceInferredOnStreamText(flow, 3000);
    expect(flow.stages[2].status).toBe('active');
    expect(flow.stages[0].status).toBe('done');
    expect(flow.stages[1].status).toBe('done');
  });

  it('switches to explicit stages from agent report', () => {
    const base = createInferredTaskFlow('run-1', 'main', 1000);
    const next = applyExplicitStageReport(base, {
      label: 'Search literature',
      status: 'start',
      step: 1,
      total: 3,
      detail: 'arXiv query',
    }, 2000);
    expect(next.mode).toBe('explicit');
    expect(next.stages).toHaveLength(3);
    expect(next.stages[0].label).toBe('Search literature');
    expect(next.stages[0].status).toBe('active');
    expect(next.stages[0].detail).toBe('arXiv query');
  });

  it('parses stage report payloads', () => {
    expect(parseTaskFlowStageReport({ label: 'Draft outline', status: 'done' })?.status).toBe('done');
    expect(parseTaskFlowStageReport({ label: '', status: 'start' })).toBeNull();
  });
});
