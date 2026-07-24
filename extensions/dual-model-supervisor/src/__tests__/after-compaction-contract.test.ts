/**
 * P1-A — after_compaction must operate on the REAL OpenClaw event shape.
 *
 * OC 2026.6.1 PluginHookAfterCompactionEvent = { messageCount, tokenCount?,
 * compactedCount, sessionFile? } — it does NOT carry before/after message arrays.
 * The pre-fix handler read phantom `event.original` / `event.compacted` (via an
 * `as` cast that invented the fields), so it always early-returned and
 * MemoryGuardian.afterCompaction NEVER ran — a silent dead path.
 *
 * This test fires the handler with the REAL event and asserts it produces an
 * OBSERVABLE audit (the gap is surfaced, not silent). On the phantom-field code
 * this fails: no audit is recorded.
 */

import { describe, expect, it } from 'vitest';
import { loadPluginFresh } from './harness/plugin-harness.js';

const CONFIG = { enabled: true, supervisorModel: 'fake/model', reviewMode: 'full', appendReviewToChannelOutput: true };

interface LogEntry { type: string; action: string; details: string }

describe('P1-A after_compaction real-event contract', () => {
  it('runs on the real event (counts + sessionFile) and records an observable audit', async () => {
    const h = await loadPluginFresh(CONFIG);

    // Real OC AfterCompactionEvent — NO original/compacted arrays.
    await h.fire(
      'after_compaction',
      { messageCount: 40, tokenCount: 8000, compactedCount: 12, sessionFile: '/tmp/session.jsonl' },
      { sessionKey: 'agent:main:skA', sessionId: 'skA' },
    );

    const log = (await h.rpc.get('rc.supervisor.log')!({ type: 'memory_guard', limit: 10 })) as {
      entries: LogEntry[];
    };
    const observed = log.entries.some(
      (e) => e.type === 'memory_guard' && /compaction observed/.test(e.details),
    );
    expect(observed).toBe(true);
  });

  it('no-ops without a session key (never guesses)', async () => {
    const h = await loadPluginFresh(CONFIG);
    await h.fire(
      'after_compaction',
      { messageCount: 5, compactedCount: 1 },
      { sessionId: undefined, sessionKey: undefined },
    );
    const log = (await h.rpc.get('rc.supervisor.log')!({ type: 'memory_guard', limit: 10 })) as {
      entries: LogEntry[];
    };
    expect(log.entries.length).toBe(0);
  });

  // Invariant §7.7: "降级可见" must not override the feature switch — when the
  // memory guard is OFF, no memory_guard business audit may be written.
  it('records NO memory_guard audit when memoryGuard is disabled', async () => {
    const h = await loadPluginFresh({ ...CONFIG, memoryGuard: { enabled: false } });
    await h.fire(
      'after_compaction',
      { messageCount: 40, compactedCount: 12 },
      { sessionKey: 'agent:main:skA', sessionId: 'skA' },
    );
    const log = (await h.rpc.get('rc.supervisor.log')!({ type: 'memory_guard', limit: 10 })) as {
      entries: LogEntry[];
    };
    expect(log.entries.length).toBe(0);
  });

  it('records NO memory_guard audit when reviewMode is not full', async () => {
    const h = await loadPluginFresh({ ...CONFIG, reviewMode: 'correct' });
    await h.fire(
      'after_compaction',
      { messageCount: 40, compactedCount: 12 },
      { sessionKey: 'agent:main:skA', sessionId: 'skA' },
    );
    const log = (await h.rpc.get('rc.supervisor.log')!({ type: 'memory_guard', limit: 10 })) as {
      entries: LogEntry[];
    };
    expect(log.entries.length).toBe(0);
  });
});
