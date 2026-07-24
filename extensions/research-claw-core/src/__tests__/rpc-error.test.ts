import { describe, it, expect } from 'vitest';
import { buildRpcErrorOutcome } from '../rpc-error.js';

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

  it('falls back to RpcValidationError.errorCode as used by memory and task RPC', () => {
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
