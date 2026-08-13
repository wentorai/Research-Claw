import { describe, expect, it } from 'vitest';
import {
  classifyCoreMethodFailure,
  isCoreMethod,
  isCoreRecoveryProbe,
} from '../utils/core-capability';

describe('Core runtime capability failure', () => {
  it('turns unknown Core RPC methods into one global failure state', () => {
    expect(classifyCoreMethodFailure('rc.review.candidates', {
      code: 'INVALID_REQUEST',
      message: 'unknown method: rc.review.candidates',
    }, 123)).toEqual({
      method: 'rc.review.candidates',
      message: 'unknown method: rc.review.candidates',
      detectedAt: 123,
    });
  });

  it('covers every product surface affected by the incident', () => {
    for (const method of [
      'rc.lit.list', 'rc.ws.tree', 'rc.task.list', 'rc.monitor.list',
      'rc.review.candidates', 'rc.periph.devices.list', 'rc.job.list',
      'rc.execution.summary',
    ]) expect(isCoreMethod(method), method).toBe(true);
  });

  it('does not misclassify domain failures or optional plugin methods', () => {
    expect(classifyCoreMethodFailure('rc.lit.list', {
      code: 'SERVICE_ERROR', message: 'database busy',
    })).toBeNull();
    expect(classifyCoreMethodFailure('rc.supervisor.review', {
      code: 'INVALID_REQUEST', message: 'unknown method: rc.supervisor.review',
    })).toBeNull();
  });

  it('clears only after the Core sentinel RPC succeeds', () => {
    expect(isCoreRecoveryProbe('rc.onboarding.status')).toBe(true);
    expect(isCoreRecoveryProbe('sessions.list')).toBe(false);
  });
});
