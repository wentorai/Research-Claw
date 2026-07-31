import { describe, expect, it } from 'vitest';

import { ACCEPTANCE_FOREGROUND_POLL_REQUEST } from '../__fixtures__/long-run-incidents.js';
import {
  isToolDedupEligible,
  processPollIntervention,
} from '../tasks/process-poll-policy.js';

describe('foreground process.poll policy', () => {
  it('does not force an OC-managed long poll into a detached background Job', () => {
    expect(processPollIntervention(
      ACCEPTANCE_FOREGROUND_POLL_REQUEST.toolName,
      ACCEPTANCE_FOREGROUND_POLL_REQUEST.params,
    )).toBeNull();
  });

  it('leaves unrelated tool calls untouched', () => {
    expect(processPollIntervention('exec', {
      command: 'sleep 420',
      timeout: 480,
    })).toBeNull();
  });

  it('does not mistake repeated OC-bounded process polls for a tool-call loop', () => {
    expect(isToolDedupEligible(
      ACCEPTANCE_FOREGROUND_POLL_REQUEST.toolName,
      ACCEPTANCE_FOREGROUND_POLL_REQUEST.params,
    )).toBe(false);
  });

  it('keeps the duplicate-call guard for non-poll tools', () => {
    expect(isToolDedupEligible('exec', {
      command: 'sleep 420',
      timeout: 480,
    })).toBe(true);
    expect(isToolDedupEligible('process', {
      action: 'kill',
      sessionId: 'foreground-420',
    })).toBe(true);
  });
});
