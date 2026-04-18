import { describe, expect, it } from 'vitest';
import type { SessionState } from '../core/types.js';

// We can't easily test the full plugin register flow, but we can test the
// extracted logic that was the source of bugs.

function makeSessionState(id: string): SessionState {
  return {
    sessionId: id,
    targetConclusions: [],
    goalConfirmed: false,
    keyConclusions: [],
    userPreferences: [],
    methodologyDecisions: [],
    recentOutputs: [],
    recentSummaries: [],
    preCompactionMemory: [],
    regenerateAttempts: 0,
    regenerateHistory: [],
  };
}

describe('session routing: per-session debounce', () => {
  const DEBOUNCE_MS = 1500;

  function takeStaticRules(reviewMode: string, state: SessionState | null): string {
    if (reviewMode === 'off') return '';
    const now = Date.now();
    const lastInject = state?.lastStaticSupervisorInjectAt ?? 0;
    if (now - lastInject < DEBOUNCE_MS) return '';
    if (state) state.lastStaticSupervisorInjectAt = now;
    return '[Supervisor rules]';
  }

  it('allows injection for different sessions within debounce window', () => {
    const sessionA = makeSessionState('a');
    const sessionB = makeSessionState('b');

    const resultA = takeStaticRules('full', sessionA);
    const resultB = takeStaticRules('full', sessionB);

    expect(resultA).toBe('[Supervisor rules]');
    expect(resultB).toBe('[Supervisor rules]');
  });

  it('blocks duplicate injection for the SAME session within debounce window', () => {
    const session = makeSessionState('test');

    const first = takeStaticRules('full', session);
    const second = takeStaticRules('full', session);

    expect(first).toBe('[Supervisor rules]');
    expect(second).toBe(''); // debounced
  });

  it('returns empty for off mode', () => {
    const session = makeSessionState('test');
    expect(takeStaticRules('off', session)).toBe('');
  });

  it('works with null session (no state to track)', () => {
    // null session = no debounce tracking, always emits
    expect(takeStaticRules('full', null)).toBe('[Supervisor rules]');
    expect(takeStaticRules('full', null)).toBe('[Supervisor rules]');
  });
});

describe('session routing: activeId lookup vs Map iteration', () => {
  it('uses activeId to find correct session, not Map order', () => {
    const states = new Map<string, SessionState>();
    states.set('session-1', { ...makeSessionState('session-1'), researchGoal: 'Goal A' });
    states.set('session-2', { ...makeSessionState('session-2'), researchGoal: 'Goal B' });

    // Old behavior: picks last in Map -> session-2
    const sessionIds = Array.from(states.keys());
    const oldBehavior = states.get(sessionIds[sessionIds.length - 1]!);
    expect(oldBehavior?.researchGoal).toBe('Goal B');

    // New behavior: uses activeId -> session-1 (if that's the active one)
    const activeId = 'session-1';
    const newBehavior = activeId ? states.get(activeId) ?? null : null;
    expect(newBehavior?.researchGoal).toBe('Goal A');
  });
});
