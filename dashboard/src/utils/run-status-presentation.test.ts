import { describe, expect, it } from 'vitest';

import {
  resolveObservedRunActivity,
  resolveRunStatusPresentation,
} from './run-status-presentation';
import { ACCEPTANCE_FOREGROUND_ITEM_START_AFTER_TOOL } from '../__fixtures__/gateway-payloads/long-run-incidents';
import en from '../i18n/en.json';
import zh from '../i18n/zh-CN.json';

const base = {
  command: 'idle' as const,
  lifecycle: 'unknown' as const,
  serverActive: false,
  needsResultConfirmation: false,
  resultUnconfirmed: false,
  activity: null,
};

describe('truthful run status presentation', () => {
  it('maps the locked OC lifecycle fallback payload to factual fallback activity', () => {
    expect(resolveObservedRunActivity({
      stream: 'lifecycle',
      data: { phase: 'fallback' },
    })).toEqual({ kind: 'fallback', label: 'fallback' });
  });

  it('does not leave a completed tool shown as the current activity', () => {
    expect(resolveObservedRunActivity({
      stream: 'tool',
      data: { phase: 'end', name: 'search' },
    })).toEqual({ kind: 'processing', label: 'processing' });
  });

  it('does not let a lower-specificity item frame erase current tool activity', () => {
    expect(resolveObservedRunActivity(
      ACCEPTANCE_FOREGROUND_ITEM_START_AFTER_TOOL,
    )).toBeNull();
  });

  it('separates transport recovery from task failure', () => {
    expect(resolveRunStatusPresentation(base, 'reconnecting')).toMatchObject({
      kind: 'reconnecting',
      isTerminal: false,
    });
  });

  it('keeps an already-observed terminal result above contradictory transport/activity', () => {
    expect(resolveRunStatusPresentation({
      ...base,
      lifecycle: 'done',
      serverActive: true,
    }, 'reconnecting')).toMatchObject({
      kind: 'done',
      isTerminal: true,
    });
  });

  it('keeps an unclassified terminal interruption above result confirmation', () => {
    expect(resolveRunStatusPresentation({
      ...base,
      lifecycle: 'interrupted',
      needsResultConfirmation: true,
    }, 'connected')).toMatchObject({
      kind: 'interrupted',
      isTerminal: true,
    });
  });

  it('explains ACK uncertainty without claiming failure or a second send', () => {
    expect(resolveRunStatusPresentation({ ...base, command: 'ack_unknown' }, 'connected')).toMatchObject({
      kind: 'confirming-submit',
      isTerminal: false,
    });
  });

  it('shows generic processing when OC is active but no finer event exists', () => {
    expect(resolveRunStatusPresentation({ ...base, lifecycle: 'running', serverActive: true }, 'connected')).toMatchObject({
      kind: 'processing',
      isTerminal: false,
    });
  });

  it('uses only a sanitized tool label and never tool params or paths', () => {
    const presentation = resolveRunStatusPresentation({
      ...base,
      lifecycle: 'running',
      serverActive: true,
      activity: {
        sessionKey: 'main',
        kind: 'tool',
        label: 'mcp__wentor_network__search /Users/private/query.json',
        observedAt: 1,
        source: 'tool-event',
      },
    }, 'connected');

    expect(presentation).toMatchObject({ kind: 'tool', activityLabel: 'search' });
    expect(JSON.stringify(presentation)).not.toContain('/Users/');
  });

  it('shows the non-active running mismatch as result confirmation, not a spinner', () => {
    expect(resolveRunStatusPresentation({
      ...base,
      needsResultConfirmation: true,
    }, 'connected')).toMatchObject({
      kind: 'confirming-result',
      isTerminal: false,
      spins: false,
    });
  });

  it('keeps an accepted ACK visible until OC lifecycle takes over', () => {
    expect(resolveRunStatusPresentation({
      ...base,
      command: 'accepted',
    }, 'connected')).toMatchObject({
      kind: 'accepted',
      isTerminal: false,
      spins: true,
    });
  });

  it('settles an unresolved non-active result without an infinite spinner', () => {
    expect(resolveRunStatusPresentation({
      ...base,
      resultUnconfirmed: true,
    }, 'connected')).toMatchObject({
      kind: 'result-unconfirmed',
      isTerminal: false,
      spins: false,
    });
  });

  it('does not label every actionable error as an interruption or invent a time limit', () => {
    expect(zh.chat.runIssueTitle).not.toContain('中断');
    expect(en.chat.runIssueTitle.toLowerCase()).not.toContain('interrupted');
    expect(zh.chat.runTimedOut).toContain('科研龙虾明确报告');
    expect(zh.chat.runTimedOut).not.toContain('时间上限');
    expect(zh.taskFlow.runStatus.timeout.title).not.toContain('时间上限');
  });
});
