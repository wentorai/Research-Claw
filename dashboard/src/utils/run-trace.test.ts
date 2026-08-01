import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RUN_TRACE_DOM_ID,
  RUN_TRACE_MAX_ENTRIES,
  _setRunTraceEnabledForTests,
  clearRunTrace,
  getRunTraceSnapshot,
  installRunTraceProbe,
  recordRunTrace,
} from './run-trace';

describe('run reconciliation trace probe', () => {
  beforeEach(() => {
    clearRunTrace();
    _setRunTraceEnabledForTests(false);
    delete window.__RC_RUN_TRACE__;
    document.getElementById(RUN_TRACE_DOM_ID)?.remove();
  });

  afterEach(() => {
    clearRunTrace();
    _setRunTraceEnabledForTests(null);
    delete window.__RC_RUN_TRACE__;
    document.getElementById(RUN_TRACE_DOM_ID)?.remove();
  });

  it('is disabled by default and retains nothing', () => {
    recordRunTrace({ source: 'chat', action: 'send', sessionKey: 'main', runId: 'run-1' });
    expect(getRunTraceSnapshot()).toEqual([]);
  });

  it('records only the fixed metadata schema and never generic payload content', () => {
    _setRunTraceEnabledForTests(true);
    recordRunTrace({
      source: 'history',
      action: 'response',
      sessionKey: 'agent:main:project-a',
      runId: 'run-1',
      eventEpoch: 2,
      requestGeneration: 7,
      status: 'running',
      hasActiveRun: true,
      fieldsPresent: ['status', 'hasActiveRun', 'inFlightRun'],
      // Deliberately attack the runtime boundary with a field the API does not
      // support. sanitize() must not spread unknown input properties.
      message: 'TOP SECRET USER PROMPT',
    } as Parameters<typeof recordRunTrace>[0] & { message: string });

    const snapshot = getRunTraceSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      source: 'history',
      action: 'response',
      sessionKey: 'agent:main:project-a',
      runId: 'run-1',
      eventEpoch: 2,
      requestGeneration: 7,
      status: 'running',
      hasActiveRun: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain('TOP SECRET');
  });

  it('is a bounded ring buffer', () => {
    _setRunTraceEnabledForTests(true);
    for (let i = 0; i < RUN_TRACE_MAX_ENTRIES + 4; i += 1) {
      recordRunTrace({ source: 'session-store', action: `event-${i}` });
    }
    const snapshot = getRunTraceSnapshot();
    expect(snapshot).toHaveLength(RUN_TRACE_MAX_ENTRIES);
    expect(snapshot[0].action).toBe('event-4');
  });

  it('installs a browser export API without exposing mutable internal entries', () => {
    _setRunTraceEnabledForTests(true);
    recordRunTrace({ source: 'gateway', action: 'sessions.changed', fieldsPresent: ['status'] });
    installRunTraceProbe();

    const first = window.__RC_RUN_TRACE__!.snapshot();
    first[0].action = 'tampered';

    expect(window.__RC_RUN_TRACE__!.enabled()).toBe(true);
    expect(window.__RC_RUN_TRACE__!.snapshot()[0].action).toBe('sessions.changed');
    window.__RC_RUN_TRACE__!.clear();
    expect(window.__RC_RUN_TRACE__!.snapshot()).toEqual([]);
  });

  it('publishes the same metadata-only snapshot to the opt-in acceptance DOM probe', () => {
    _setRunTraceEnabledForTests(true);
    installRunTraceProbe();
    recordRunTrace({
      source: 'session-store',
      action: 'reconciled',
      sessionKey: 'agent:main:project-1',
      runId: 'run-1',
      hasActiveRun: true,
      fieldsPresent: ['status', 'hasActiveRun'],
    });

    const element = document.getElementById(RUN_TRACE_DOM_ID);
    expect(element?.getAttribute('data-rc-acceptance-probe')).toBe('run-trace');
    expect(JSON.parse(element?.textContent ?? '[]')).toEqual(getRunTraceSnapshot());
    expect(element?.textContent).not.toContain('message');
  });
});
