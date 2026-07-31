import fs from 'node:fs';
import { createRequire } from 'node:module';
import type BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createTestDb } from './setup.js';
import { ExecutionTraceService } from '../execution-trace/service.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import { getCurrentVersion, runMigrations } from '../db/migrations.js';
import { registerExecutionTraceRpc } from '../execution-trace/rpc.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof BetterSqlite3;

const fixture = JSON.parse(fs.readFileSync(
  new URL('./fixtures/openclaw-2026.6.1-tool-hooks.json', import.meta.url),
  'utf8',
)) as {
  before: { event: { toolName: string; runId: string; toolCallId: string }; context: { sessionKey: string } };
  after: { event: { toolName: string; runId: string; toolCallId: string; durationMs: number }; context: { sessionKey: string } };
};

describe('execution trace parity with OpenClaw 2026.6.1 hook payloads', () => {
  it('ships the durable Skill lifecycle schema in fresh databases', () => {
    const db = createTestDb();
    expect(SCHEMA_VERSION).toBe(22);
    const table = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'rc_execution_skill_events'
    `).get();
    expect(table).toBeTruthy();
    db.close();
  });

  it('migrates an existing v21 database to durable Skill lifecycle events', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE rc_schema_version (
        version INTEGER NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO rc_schema_version (version, applied_at) VALUES (21, datetime('now'));
    `);
    runMigrations(db);

    expect(getCurrentVersion(db)).toBe(22);
    const service = new ExecutionTraceService(db);
    expect(service.recordSkillLifecycle({
      sessionKey: 'agent:main:migrated',
      runId: 'run-migrated',
      skillKey: 'rp:migrated-skill',
      skillName: 'migrated-skill',
      skillSource: 'research-plugins',
      lifecycle: 'candidate',
      timestamp: 123,
    })).toBe(true);
    expect(new ExecutionTraceService(db).skillLifecycleDetail('run-migrated')[0]).toMatchObject({
      lifecycle: 'candidate',
      observed_at: 123,
    });
    db.close();
  });

  it('returns persisted lifecycle events through exact-run detail RPC after reconstruction', async () => {
    const db = createTestDb();
    const service = new ExecutionTraceService(db);
    service.recordSkillLifecycle({
      sessionKey: 'agent:main:rpc',
      runId: 'run-rpc',
      skillKey: 'rp:systematic-review-guide',
      skillName: 'systematic-review-guide',
      skillSource: 'research-plugins',
      lifecycle: 'candidate',
      toolCallId: 'search-call',
      timestamp: 100,
    });
    const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown> | unknown>();
    registerExecutionTraceRpc(
      (name, handler) => handlers.set(name, handler),
      new ExecutionTraceService(db),
    );

    const detail = await handlers.get('rc.execution.detail')!({ runId: 'run-rpc' }) as {
      skillEvents: Array<Record<string, unknown>>;
    };
    expect(detail.skillEvents).toEqual([
      expect.objectContaining({
        skill_name: 'systematic-review-guide',
        lifecycle: 'candidate',
      }),
    ]);
    db.close();
  });

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
      'run-fixture': { toolCount: 1, errorCount: 0, skillCount: 0 },
    });
    expect(service.detail('run-fixture')[0]).toMatchObject({
      tool_name: 'read',
      status: 'completed',
      duration_ms: 12,
    });
    expect(JSON.stringify(service.detail('run-fixture'))).not.toContain('paper.md');
    db.close();
  });

  it('persists a reply hash, resolves it after reconstruction, and never stores reply text', () => {
    const db = createTestDb();
    const service = new ExecutionTraceService(db);
    service.recordReply({
      sessionKey: 'agent:main:fixture',
      runId: 'run-reply',
      text: '这是只应以哈希形式保存的回复',
      timestamp: 2_000,
    });

    const reconstructed = new ExecutionTraceService(db);
    expect(reconstructed.resolveReplies('agent:main:fixture', [{
      index: 7,
      timestamp: 9_000,
      textHashes: ['af932326', '9c5660d4'],
    }])).toEqual([]);

    const row = db.prepare('SELECT * FROM rc_execution_replies WHERE run_id = ?')
      .get('run-reply') as Record<string, unknown>;
    expect(row.reply_hash).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(row)).not.toContain('这是只应以哈希形式保存的回复');
    expect(reconstructed.resolveReplies('agent:main:fixture', [{
      index: 7,
      timestamp: 20_000,
      textHashes: [String(row.reply_hash)],
    }])).toEqual([{ index: 7, runId: 'run-reply' }]);
    db.close();
  });

  it('backfills pre-migration replies from the real tool activity interval', () => {
    const db = createTestDb();
    const service = new ExecutionTraceService(db);
    service.recordBefore({
      sessionKey: 'agent:main:fixture',
      runId: 'run-legacy',
      toolCallId: 'call-legacy',
      toolName: 'read',
      timestamp: 10_000,
    });
    expect(service.resolveReplies('agent:main:fixture', [{
      index: 0,
      timestamp: 15_000,
      textHashes: ['00000000'],
      turnStartedAt: 9_000,
    }])).toEqual([{ index: 0, runId: 'run-legacy' }]);
    db.close();
  });

  it('does not attach a previous turn tool run to a later no-tool reply', () => {
    const db = createTestDb();
    const service = new ExecutionTraceService(db);
    service.recordBefore({
      sessionKey: 'agent:main:fixture',
      runId: 'run-previous-turn',
      toolCallId: 'call-previous-turn',
      toolName: 'read',
      timestamp: 10_000,
    });
    expect(service.resolveReplies('agent:main:fixture', [{
      index: 2,
      timestamp: 30_000,
      textHashes: ['00000000'],
      turnStartedAt: 25_000,
    }])).toEqual([]);
    db.close();
  });
});
