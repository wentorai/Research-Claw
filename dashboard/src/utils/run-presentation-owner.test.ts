import { describe, expect, it } from 'vitest';
import { resolveRunPresentationOwners } from './run-presentation-owner';

describe('canonical Run presentation owner', () => {
  it('owns a no-final run on the projected user idempotency key', () => {
    expect(resolveRunPresentationOwners([
      { role: 'user', text: 'start', idempotencyKey: 'run-timeout:user' },
      { role: 'toolResult', text: 'hidden' },
    ])).toEqual([{ index: 0, runId: 'run-timeout', noFinal: true }]);
  });

  it('atomically migrates live ownership to the final reply without duplication', () => {
    expect(resolveRunPresentationOwners([
      { role: 'user', text: 'start', idempotencyKey: 'run-a:user' },
      { role: 'assistant', text: 'done', executionRunId: 'run-a' },
    ])).toEqual([{ index: 1, runId: 'run-a', noFinal: false }]);
  });

  it('does not guess from malformed or ordinary idempotency keys', () => {
    expect(resolveRunPresentationOwners([
      { role: 'user', idempotencyKey: ':user' },
      { role: 'user', idempotencyKey: 'run-a' },
    ])).toEqual([]);
  });
});
