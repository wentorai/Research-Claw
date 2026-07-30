import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTestDb } from './setup.js';
import { ExecutionTraceService } from '../execution-trace/service.js';

const fixture = JSON.parse(fs.readFileSync(
  new URL('./fixtures/openclaw-2026.6.1-tool-hooks.json', import.meta.url),
  'utf8',
)) as {
  before: { event: { toolName: string; runId: string; toolCallId: string }; context: { sessionKey: string } };
  after: { event: { toolName: string; runId: string; toolCallId: string; durationMs: number }; context: { sessionKey: string } };
};

describe('execution trace parity with OpenClaw 2026.6.1 hook payloads', () => {
  it('deduplicates before/after phases and persists safe detail across service reconstruction', () => {
    const db = createTestDb();
    const service = new ExecutionTraceService(db);
    const before = fixture.before;
    service.recordBefore({
      sessionKey: before.context.sessionKey,
      runId: before.event.runId,
      toolCallId: before.event.toolCallId,
      toolName: before.event.toolName,
      timestamp: 100,
    });
    service.recordBefore({
      sessionKey: before.context.sessionKey,
      runId: before.event.runId,
      toolCallId: before.event.toolCallId,
      toolName: before.event.toolName,
      timestamp: 101,
    });
    service.recordAfter({
      sessionKey: fixture.after.context.sessionKey,
      runId: fixture.after.event.runId,
      toolCallId: fixture.after.event.toolCallId,
      toolName: fixture.after.event.toolName,
      durationMs: fixture.after.event.durationMs,
      timestamp: 112,
    });
    expect(new ExecutionTraceService(db).summary(['run-fixture'])).toEqual({
      'run-fixture': { toolCount: 1, errorCount: 0 },
    });
    expect(service.detail('run-fixture')[0]).toMatchObject({
      tool_name: 'read',
      status: 'completed',
      duration_ms: 12,
    });
    expect(JSON.stringify(service.detail('run-fixture'))).not.toContain('paper.md');
    db.close();
  });
});
