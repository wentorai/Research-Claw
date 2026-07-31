import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { runMigrations, getCurrentVersion } from '../db/migrations.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import { ExecutionTraceService } from '../execution-trace/service.js';
import { adaptWorkspacePresentation } from '../presentation/adapters.js';
import { PresentationCoordinator } from '../presentation/coordinator.js';
import { registerPresentationRpc } from '../presentation/rpc.js';
import { loadOpenClawSessionRegistry } from '../presentation/retention.js';
import { PresentationService } from '../presentation/service.js';
import { registerWorkspaceRpc } from '../workspace/rpc.js';
import type { WorkspaceService } from '../workspace/service.js';

const live = JSON.parse(fs.readFileSync(
  new URL('./fixtures/presentation-hooks-live-2026.6.1.json', import.meta.url),
  'utf8',
)) as Record<string, any>;
const negative = JSON.parse(fs.readFileSync(
  new URL('./fixtures/presentation-negative-contracts-2026.6.1.json', import.meta.url),
  'utf8',
)) as Record<string, any>;

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function appendFixture(
  service: PresentationService,
  toolName: string,
  overrides: Partial<{ sessionKey: string; runId: string; toolCallId: string }> = {},
) {
  const hook = live.cases[toolName].after_tool_call;
  const file = adaptWorkspacePresentation(toolName, hook.event.result);
  expect(file).not.toBeNull();
  return service.append({
    sessionKey: overrides.sessionKey ?? hook.context.sessionKey,
    runId: overrides.runId ?? hook.context.runId,
    toolCallId: overrides.toolCallId ?? hook.event.toolCallId,
    toolName,
    source: 'full',
    completeness: 'complete',
    payload: { kind: 'file', file: file! },
  });
}

describe('workspace presentation adapter', () => {
  it.each([
    ['workspace_save', 'outputs/contracts/base.csv', 24],
    ['workspace_append', 'outputs/contracts/base.csv', 38],
    ['workspace_export', 'outputs/contracts/base.xlsx', 4972],
    ['workspace_download', 'outputs/contracts/example.html', 559],
  ])('strictly projects the real %s payload', (toolName, path, size) => {
    const payload = adaptWorkspacePresentation(
      toolName,
      live.cases[toolName].after_tool_call.event.result,
    );
    expect(payload).toMatchObject({ path, sizeBytes: size, operation: toolName });
  });

  it('rejects business errors, unsupported tools, oversized and malicious fields', () => {
    expect(adaptWorkspacePresentation(
      'workspace_export',
      negative.real.workspace_export_business_error.after_tool_call.event.result,
    )).toBeNull();
    expect(adaptWorkspacePresentation('workspace_read', { details: { path: 'outputs/x.md', size: 1 } })).toBeNull();
    expect(adaptWorkspacePresentation('workspace_save', {
      details: { path: '../escape.md', size: 1, committed: false },
    })).toBeNull();
    expect(adaptWorkspacePresentation('workspace_save', {
      details: { path: 'outputs/x.md', size: Number.MAX_SAFE_INTEGER + 1, committed: false },
    })).toBeNull();
  });
});

describe('immutable file presentation records', () => {
  it('supports fresh install and the exact v22 to current migration', () => {
    const fresh = freshDb();
    expect(SCHEMA_VERSION).toBe(23);
    expect(getCurrentVersion(fresh)).toBe(23);
    expect(fresh.prepare("SELECT name FROM sqlite_master WHERE name = 'rc_execution_presentation_records'").get()).toBeTruthy();

    const migrated = freshDb();
    migrated.prepare('DELETE FROM rc_schema_version').run();
    migrated.prepare("INSERT INTO rc_schema_version(version, applied_at) VALUES (22, datetime('now'))").run();
    migrated.exec('DROP TABLE rc_execution_presentation_records; DROP TABLE rc_execution_presentation_runs;');
    runMigrations(migrated);
    expect(getCurrentVersion(migrated)).toBe(23);
    expect(migrated.prepare("SELECT name FROM sqlite_master WHERE name = 'rc_execution_presentation_records'").get()).toBeTruthy();
  });

  it('deduplicates repeated events and presents the newest fact for one path', () => {
    const db = freshDb();
    const service = new PresentationService(db);
    const first = appendFixture(service, 'workspace_save', { sessionKey: 'session-a', runId: 'run-a' });
    const duplicate = appendFixture(service, 'workspace_save', { sessionKey: 'session-a', runId: 'run-a' });
    const complete = appendFixture(service, 'workspace_append', { sessionKey: 'session-a', runId: 'run-a' });

    expect(first).toMatchObject({ appended: true, recordsRevision: 1 });
    expect(duplicate).toMatchObject({ appended: false, recordsRevision: 1 });
    expect(complete).toMatchObject({ appended: true, recordsRevision: 2 });
    expect(service.getRuns('session-a', ['run-a'])['run-a']).toMatchObject({
      recordsRevision: 2,
      files: [{ path: 'outputs/contracts/base.csv', sizeBytes: 38 }],
    });
  });

  it('keeps two paths and session/run scopes separate', () => {
    const db = freshDb();
    const service = new PresentationService(db);
    appendFixture(service, 'workspace_save', { sessionKey: 'session-a', runId: 'run-a' });
    appendFixture(service, 'workspace_download', { sessionKey: 'session-a', runId: 'run-a' });
    appendFixture(service, 'workspace_export', { sessionKey: 'session-b', runId: 'run-b' });

    expect(service.getRuns('session-a', ['run-a'])['run-a'].files).toHaveLength(2);
    expect(service.getRuns('session-a', ['run-b'])).toEqual({});
  });

  it('advances revision on persisted partial to full complete without later downgrade', () => {
    const db = freshDb();
    const service = new PresentationService(db);
    const hook = live.cases.workspace_save.after_tool_call;
    const file = adaptWorkspacePresentation('workspace_save', hook.event.result)!;
    expect(service.append({
      sessionKey: 'session-a', runId: 'run-a', toolCallId: 'call-a',
      toolName: 'workspace_save', source: 'persisted', completeness: 'partial',
      payload: { kind: 'file', file },
    })).toMatchObject({ recordsRevision: 1 });
    expect(service.append({
      sessionKey: 'session-a', runId: 'run-a', toolCallId: 'call-a',
      toolName: 'workspace_save', source: 'full', completeness: 'complete',
      payload: { kind: 'file', file },
    })).toMatchObject({ appended: true, recordsRevision: 2 });
    expect(service.append({
      sessionKey: 'session-a', runId: 'run-a', toolCallId: 'call-a',
      toolName: 'workspace_save', source: 'persisted', completeness: 'partial',
      payload: { kind: 'file', file },
    })).toMatchObject({ appended: false, recordsRevision: 2 });
  });

  it('rejects an oversized normalized record before it can grow the database', () => {
    const service = new PresentationService(freshDb());
    expect(() => service.append({
      sessionKey: 'session-a', runId: 'run-a', toolCallId: 'call-a',
      toolName: 'search_openalex', source: 'full', completeness: 'complete',
      payload: {
        kind: 'paper_batch', semantic: 'retrieved', status: 'available', captureSource: 'full', provider: 'openalex',
        queryUnavailable: true, returned: 1, inspected: 1, eligible: 1, stored: 1,
        inputCapped: false, runCapped: false, persistedDetailsTruncated: false,
        candidates: [{
          candidateId: 'candidate-a', provider: 'openalex', returnIndex: 1,
          source: 'openalex', strongAliases: ['provider:openalex:W1'], actionable: true,
          title: 'Paper', authors: [], abstractPreview: 'x'.repeat(300_000),
        }],
      },
    })).toThrow(/exceeds .* bytes/);
    expect(service.getRuns('session-a', ['run-a'])).toEqual({});
  });
});

describe('persisted fallback correlation and RPC isolation', () => {
  it('converges partial-before-complete, duplicate, and late persisted events by revision', () => {
    const db = freshDb();
    const trace = new ExecutionTraceService(db);
    const presentations = new PresentationService(db);
    const changed: Array<{ runId: string; recordsRevision: number }> = [];
    const coordinator = new PresentationCoordinator(presentations, trace, {
      ttlMs: 60_000,
      onChanged: (event) => changed.push(event),
    });
    const hook = live.cases.workspace_save;
    coordinator.beforeTool(hook.before_tool_call.event, hook.before_tool_call.context);

    expect(coordinator.persistedToolResult(
      hook.tool_result_persist.event,
      hook.tool_result_persist.context,
    )).toMatchObject({ recordsRevision: 1 });
    expect(coordinator.afterTool(
      hook.after_tool_call.event,
      hook.after_tool_call.context,
    )).toMatchObject({ recordsRevision: 2 });
    expect(coordinator.afterTool(
      hook.after_tool_call.event,
      hook.after_tool_call.context,
    )).toMatchObject({ appended: false, recordsRevision: 2 });
    expect(coordinator.persistedToolResult(
      hook.tool_result_persist.event,
      hook.tool_result_persist.context,
    )).toMatchObject({ appended: false, recordsRevision: 2 });
    expect(changed).toEqual([
      expect.objectContaining({ runId: hook.after_tool_call.context.runId, recordsRevision: 1 }),
      expect.objectContaining({ runId: hook.after_tool_call.context.runId, recordsRevision: 2 }),
    ]);
  });

  it('fails closed for missing/synthetic IDs and cross-Run toolCallId reuse', () => {
    const db = freshDb();
    const trace = new ExecutionTraceService(db);
    const service = new PresentationService(db);
    const coordinator = new PresentationCoordinator(service, trace, { ttlMs: 60_000 });
    const persisted = live.cases.workspace_save.tool_result_persist;

    coordinator.beforeTool({ toolName: 'workspace_save', runId: 'run-a', toolCallId: 'same' }, { sessionKey: 'session-a' });
    coordinator.beforeTool({ toolName: 'workspace_save', runId: 'run-b', toolCallId: 'same' }, { sessionKey: 'session-a' });
    expect(coordinator.persistedToolResult(
      { ...persisted.event, toolCallId: 'same' },
      { sessionKey: 'session-a', toolCallId: 'same' },
    )).toBeNull();
    expect(coordinator.persistedToolResult(
      { ...persisted.event, toolCallId: undefined },
      { sessionKey: 'session-a' },
    )).toBeNull();
    expect(coordinator.persistedToolResult(
      { ...persisted.event, toolCallId: 'synthetic', isSynthetic: true },
      { sessionKey: 'session-a', toolCallId: 'synthetic' },
    )).toBeNull();
    expect(service.getRuns('session-a', ['run-a', 'run-b'])).toEqual({});
  });

  it('uses an exact unique DB fallback after coordinator memory loss', () => {
    const db = freshDb();
    const trace = new ExecutionTraceService(db);
    const service = new PresentationService(db);
    const persisted = live.cases.workspace_save.tool_result_persist;
    trace.recordBefore({
      sessionKey: 'session-a', runId: 'run-a', toolCallId: 'call-a',
      toolName: 'workspace_save', timestamp: Date.now(),
    });
    const coordinator = new PresentationCoordinator(service, trace, { ttlMs: 60_000 });
    expect(coordinator.persistedToolResult(
      { ...persisted.event, toolCallId: 'call-a' },
      { sessionKey: 'session-a', toolCallId: 'call-a' },
    )).toMatchObject({ runId: 'run-a', recordsRevision: 1 });
  });

  it('requires sessionKey and rejects a foreign run in summary, detail, and presentations', async () => {
    const db = freshDb();
    const trace = new ExecutionTraceService(db);
    trace.recordBefore({ sessionKey: 'session-b', runId: 'run-b', toolCallId: 'call-b', toolName: 'workspace_save' });
    const presentations = new PresentationService(db);
    appendFixture(presentations, 'workspace_save', { sessionKey: 'session-b', runId: 'run-b' });
    const handlers = new Map<string, (params: Record<string, unknown>) => unknown>();
    registerPresentationRpc((name, handler) => handlers.set(name, handler), presentations, trace);

    await expect(handlers.get('rc.execution.presentations')!({ sessionKey: 'session-a', runIds: ['run-b'] })).rejects.toThrow(/session/i);
    await expect(handlers.get('rc.execution.summary')!({ sessionKey: 'session-a', runIds: ['run-b'] })).rejects.toThrow(/session/i);
    await expect(handlers.get('rc.execution.detail')!({ sessionKey: 'session-a', runId: 'run-b' })).rejects.toThrow(/session/i);
  });

  it('removes presentation and execution facts when a session is deleted', async () => {
    const db = freshDb();
    const trace = new ExecutionTraceService(db);
    trace.recordBefore({
      sessionKey: 'agent:main:session-a', runId: 'run-a',
      toolCallId: 'call-a', toolName: 'workspace_save',
    });
    const presentations = new PresentationService(db);
    appendFixture(presentations, 'workspace_save', {
      sessionKey: 'agent:main:session-a', runId: 'run-a', toolCallId: 'call-a',
    });
    const handlers = new Map<string, (params: Record<string, unknown>) => unknown>();
    registerPresentationRpc((name, handler) => handlers.set(name, handler), presentations, trace);

    await expect(handlers.get('rc.execution.cleanupSession')!({
      sessionKey: 'agent:main:session-a',
    })).resolves.toEqual({ ok: true, deletedRecords: 1 });
    expect(presentations.getRuns('agent:main:session-a', ['run-a'])).toEqual({});
    expect(trace.summaryForSession('agent:main:session-a', ['run-a'])).toEqual({});
  });
});

describe('file availability enrichment', () => {
  it('distinguishes present, deleted, missing, blocked, and unknown without rewriting facts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-presentation-availability-'));
    fs.writeFileSync(path.join(root, 'present.md'), 'ok');
    fs.mkdirSync(path.join(root, 'directory'));
    const fakeService = {
      resolvePath(filePath: string) {
        if (filePath === 'blocked.md') throw Object.assign(new Error('blocked'), { code: -32001 });
        if (filePath === 'unknown.md') throw Object.assign(new Error('io'), { code: 'EIO' });
        return path.join(root, filePath);
      },
    } as unknown as WorkspaceService;
    const handlers = new Map<string, (params: Record<string, unknown>) => unknown>();
    registerWorkspaceRpc((name, handler) => handlers.set(name, handler), fakeService, root);

    try {
      await expect(handlers.get('rc.ws.availability')!({ files: [
        { path: 'present.md', expected: true },
        { path: 'deleted.md', expected: true },
        { path: 'missing.md', expected: false },
        { path: 'directory', expected: true },
        { path: 'blocked.md', expected: true },
        { path: 'unknown.md', expected: true },
      ] })).resolves.toMatchObject({ files: [
        { path: 'present.md', status: 'present', sizeBytes: 2 },
        { path: 'deleted.md', status: 'deleted' },
        { path: 'missing.md', status: 'missing' },
        { path: 'directory', status: 'blocked' },
        { path: 'blocked.md', status: 'blocked' },
        { path: 'unknown.md', status: 'unknown' },
      ] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('bounded presentation retention', () => {
  it('reads bounded OC Session truth without reading transcripts', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-presentation-registry-'));
    const sessionsDir = path.join(stateDir, 'agents', 'main', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'sessions.json'), JSON.stringify({
      'agent:main:active': { sessionId: 'active-id', sessionFile: '/must/not/be/read.jsonl' },
    }));
    try {
      const snapshot = loadOpenClawSessionRegistry(stateDir);
      expect(snapshot).toMatchObject({ ok: true, filesRead: 1, errors: 0 });
      expect(snapshot.sessionKeys).toEqual(new Set(['agent:main:active']));
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('deletes only old registry-orphaned Runs within the bandwidth limit', () => {
    const db = freshDb();
    const service = new PresentationService(db);
    appendFixture(service, 'workspace_save', { sessionKey: 'agent:main:active', runId: 'run-active' });
    appendFixture(service, 'workspace_save', { sessionKey: 'agent:main:orphan', runId: 'run-old' });
    appendFixture(service, 'workspace_save', { sessionKey: 'agent:main:recent', runId: 'run-recent' });
    const now = Date.now();
    db.prepare(`
      UPDATE rc_execution_presentation_runs SET updated_at = ?
      WHERE session_key IN ('agent:main:active', 'agent:main:orphan')
    `).run(now - 8 * 24 * 60 * 60_000);

    const telemetry = service.sweepOrphans(new Set(['agent:main:active']), {
      now, graceMs: 7 * 24 * 60 * 60_000, maxScanRuns: 10, maxDeleteRuns: 1,
    });
    expect(telemetry).toMatchObject({
      activeSessions: 1, eligibleOrphanRuns: 1, deletedRuns: 1, deletedRecords: 1,
      totalRunsBefore: 3, totalRecordsBefore: 3,
    });
    expect(service.getRuns('agent:main:active', ['run-active'])).toHaveProperty('run-active');
    expect(service.getRuns('agent:main:orphan', ['run-old'])).toEqual({});
    expect(service.getRuns('agent:main:recent', ['run-recent'])).toHaveProperty('run-recent');
  });
});
