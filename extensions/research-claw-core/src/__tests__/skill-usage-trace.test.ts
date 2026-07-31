import { describe, expect, it } from 'vitest';
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
} from 'openclaw/plugin-sdk/diagnostic-runtime';
import {
  emitTrustedDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from 'openclaw/plugin-sdk/diagnostic-runtime';
import { createTestDb } from './setup.js';
import { ExecutionTraceService } from '../execution-trace/service.js';
import {
  recordSkillUsedDiagnostic,
  subscribeExecutionSkillDiagnostics,
} from '../execution-trace/skill-diagnostic.js';

const workspaceSkillRead = {
  type: 'skill.used',
  ts: 1_785_428_109_707,
  seq: 42,
  runId: 'run-real-read',
  sessionKey: 'agent:main:project-fixture',
  skillName: 'searching-literature',
  skillSource: 'workspace',
  activation: 'read',
  toolName: 'read',
  toolCallId: 'call-skill-read',
} satisfies DiagnosticEventPayload;

describe('OpenClaw-resolved Skill activation trace', () => {
  it('records a trusted workspace SKILL.md read and deduplicates repeated telemetry', () => {
    const db = createTestDb();
    const service = new ExecutionTraceService(db);
    const trusted = { trusted: true } satisfies DiagnosticEventMetadata;

    expect(recordSkillUsedDiagnostic(service, workspaceSkillRead, trusted)).toBe(true);
    expect(recordSkillUsedDiagnostic(service, workspaceSkillRead, trusted)).toBe(true);

    expect(service.summary(['run-real-read'])['run-real-read']).toEqual({
      toolCount: 0,
      errorCount: 0,
      skillCount: 1,
    });
    expect(service.skillDetail('run-real-read')[0]).toMatchObject({
      skill_key: 'workspace:searching-literature',
      skill_name: 'searching-literature',
      skill_source: 'workspace',
      activation: 'read',
      tool_call_id: 'call-skill-read',
    });
    expect(service.skillLifecycleDetail('run-real-read')).toEqual([
      expect.objectContaining({
        skill_key: 'workspace:searching-literature',
        lifecycle: 'executed',
        activation: 'read',
        tool_call_id: 'call-skill-read',
      }),
    ]);
    db.close();
  });

  it('rejects untrusted lookalike events and events without run correlation', () => {
    const db = createTestDb();
    const service = new ExecutionTraceService(db);
    expect(recordSkillUsedDiagnostic(service, workspaceSkillRead, { trusted: false })).toBe(false);
    expect(recordSkillUsedDiagnostic(
      service,
      { ...workspaceSkillRead, runId: undefined },
      { trusted: true },
    )).toBe(false);
    expect(service.skillDetail('run-real-read')).toEqual([]);
    db.close();
  });

  it('observes a real trusted OpenClaw diagnostic-bus emission end to end', async () => {
    const db = createTestDb();
    const service = new ExecutionTraceService(db);
    const unsubscribe = subscribeExecutionSkillDiagnostics(service);
    try {
      emitTrustedDiagnosticEvent({
        type: 'skill.used',
        runId: 'run-real-bus',
        sessionKey: 'agent:main:project-fixture',
        skillName: 'multi-search-engine',
        skillSource: 'workspace',
        activation: 'read',
        toolName: 'read',
        toolCallId: 'call-real-bus',
      });
      await waitForDiagnosticEventsDrained();

      expect(service.skillDetail('run-real-bus')[0]).toMatchObject({
        skill_name: 'multi-search-engine',
        skill_source: 'workspace',
        activation: 'read',
      });
      expect(new ExecutionTraceService(db).skillLifecycleDetail('run-real-bus')[0]).toMatchObject({
        skill_name: 'multi-search-engine',
        lifecycle: 'executed',
      });
    } finally {
      unsubscribe();
      db.close();
    }
  });
});
