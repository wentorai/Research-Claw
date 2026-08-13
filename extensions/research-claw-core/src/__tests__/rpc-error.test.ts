import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { buildRpcErrorOutcome } from '../rpc-error.js';
import { createTestDb } from './setup.js';
import { registerTaskRpc } from '../tasks/rpc.js';
import { TaskService } from '../tasks/service.js';
import { registerMonitorRpc } from '../monitor/rpc.js';
import { MonitorService } from '../monitor/service.js';

describe('buildRpcErrorOutcome', () => {
  it('logs unexpected Error at error level WITH stack, responds PLUGIN_ERROR', () => {
    const err = new Error('boom something broke');
    const out = buildRpcErrorOutcome('rc.ws.save', err, ['path', 'content']);
    expect(out.code).toBe('PLUGIN_ERROR');
    expect(out.message).toBe('boom something broke');
    expect(out.level).toBe('error');
    expect(out.line).toContain('rc.ws.save');
    expect(out.line).toContain('params: [path, content]');
    // Stack must be present for unexpected bugs.
    expect(out.line).toContain('at ');
  });

  it('preserves the numeric ErrorShape used by literature RPC and logs at warn WITHOUT stack', () => {
    const err = { code: -32001, message: 'Paper not found' };
    const out = buildRpcErrorOutcome('rc.lit.get', err, ['id']);
    expect(out.code).toBe('-32001');
    expect(out.message).toBe('Paper not found');
    expect(out.level).toBe('warn');
    expect(out.line).toContain('[-32001]');
    expect(out.line).not.toContain('\n'); // one-liner, no stack
  });

  it('passes through a numeric JSON-RPC code attached to an Error instance', () => {
    const err = Object.assign(new Error('invalid params'), { code: -32602 });
    const out = buildRpcErrorOutcome('rc.lit.add', err, ['doi']);
    expect(out.code).toBe('-32602');
    expect(out.level).toBe('warn');
    expect(out.line).not.toContain('\n');
  });

  it('treats a missing workspace read as recoverable debug control flow', () => {
    const err = Object.assign(new Error('File not found: sources/camera/latest.jpg'), { code: -32002 });
    const out = buildRpcErrorOutcome('rc.ws.read', err, ['path']);
    expect(out.code).toBe('-32002');
    expect(out.level).toBe('debug');
    expect(out.line).toContain('deferred [-32002]');
    expect(out.line).not.toContain('\n');
  });

  it('does not globally demote -32002 errors from unrelated domains', () => {
    const err = Object.assign(new Error('Invalid parent_task_id'), { code: -32002 });
    const out = buildRpcErrorOutcome('rc.task.create', err, ['task']);
    expect(out.level).toBe('warn');
    expect(out.line).toContain('failed [-32002]');
  });

  it('falls back to an errorCode carried alongside the message', () => {
    const err = Object.assign(new Error('title is required'), {
      name: 'RpcValidationError',
      errorCode: 'INVALID_PARAMS',
    });
    const out = buildRpcErrorOutcome('rc.task.create', err, ['title']);
    expect(out.code).toBe('INVALID_PARAMS');
    expect(out.level).toBe('warn');
    expect(out.line).not.toContain('\n');
  });

  it('handles a thrown string', () => {
    const out = buildRpcErrorOutcome('rc.task.create', 'plain string failure', ['title']);
    expect(out.code).toBe('PLUGIN_ERROR');
    expect(out.message).toBe('plain string failure');
    expect(out.level).toBe('error');
  });

  it('redacts a secret embedded in error.message from both response and log', () => {
    const secret = 'rc-runtime-fixture-DEADBEEF-do-not-leak';
    for (const message of [
      `provider rejected apiKey=${secret}`,
      `provider rejected {"apiKey":"${secret}"}`,
    ]) {
      const err = new Error(message);
      const out = buildRpcErrorOutcome('rc.provider.upsert', err, ['provider', 'apiKey']);
      expect(out.line).toContain('apiKey'); // the KEY is fine
      expect(out.message).not.toContain(secret);
      expect(out.line).not.toContain(secret);
    }
  });

  it('renders (none) when there are no params', () => {
    const out = buildRpcErrorOutcome('rc.onboarding.status', new Error('x'), []);
    expect(out.line).toContain('params: [(none)]');
  });
});

/**
 * The unit cases above hand-build the thrown value. These drive the REAL
 * registered handlers with real bad params, because the defect this guards
 * against lived in the handler's re-throw, not in the classifier: a validation
 * error whose code is stripped on the way out is indistinguishable from an
 * unexpected bug and lands in the log at error level with a stack.
 */
describe('registered rc.* handlers deliver coded validation errors to the bridge', () => {
  let db: BetterSqlite3.Database;
  const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown> | unknown>();

  beforeEach(() => {
    db = createTestDb();
    handlers.clear();
    const registerMethod = (
      method: string,
      handler: (params: Record<string, unknown>) => Promise<unknown> | unknown,
    ): void => {
      handlers.set(method, handler);
    };
    registerTaskRpc(registerMethod, new TaskService(db));
    registerMonitorRpc(registerMethod, new MonitorService(db));
  });

  afterEach(() => {
    db.close();
  });

  async function outcomeOf(method: string, params: Record<string, unknown>) {
    const handler = handlers.get(method);
    expect(handler, `${method} is not registered`).toBeDefined();
    try {
      await handler!(params);
    } catch (err) {
      return buildRpcErrorOutcome(method, err, Object.keys(params));
    }
    throw new Error(`${method} unexpectedly succeeded with invalid params`);
  }

  it.each([
    ['rc.task.create', { task: { title: '' } }],
    ['rc.task.get', { id: '' }],
    ['rc.task.update', { id: 'abc', patch: 'not-an-object' }],
    ['rc.task.upcoming', { hours: 99_999 }],
    ['rc.monitor.get', { id: '' }],
    ['rc.monitor.create', { name: 'ok' }],
    ['rc.monitor.toggle', { id: 'abc', enabled: 'yes' }],
  ])('%s classifies bad params as INVALID_PARAMS at warn without a stack', async (method, params) => {
    const outcome = await outcomeOf(method, params as Record<string, unknown>);
    expect(outcome.code).toBe('INVALID_PARAMS');
    expect(outcome.level).toBe('warn');
    expect(outcome.line).not.toContain('\n');
    expect(outcome.line).not.toContain('at ');
  });

  it('still reports a genuine unexpected failure at error level with a stack', async () => {
    const outcome = await outcomeOf('rc.task.get', { id: 'no-such-task' });
    expect(outcome.code).toBe('PLUGIN_ERROR');
    expect(outcome.level).toBe('error');
    expect(outcome.line).toContain('at ');
  });
});
