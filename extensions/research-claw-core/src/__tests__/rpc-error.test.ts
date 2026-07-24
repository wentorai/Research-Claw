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

  it('preserves domain code (ErrorShape) and logs at warn WITHOUT stack', () => {
    const err = { code: 'PAPER_NOT_FOUND', message: 'Paper not found' };
    const out = buildRpcErrorOutcome('rc.lit.get', err, ['id']);
    expect(out.code).toBe('PAPER_NOT_FOUND');
    expect(out.message).toBe('Paper not found');
    expect(out.level).toBe('warn');
    expect(out.line).toContain('[PAPER_NOT_FOUND]');
    expect(out.line).not.toContain('\n'); // one-liner, no stack
  });

  it('passes through a coded Error instance', () => {
    const err = Object.assign(new Error('duplicate'), { code: 'DUPLICATE_PAPER' });
    const out = buildRpcErrorOutcome('rc.lit.add', err, ['doi']);
    expect(out.code).toBe('DUPLICATE_PAPER');
    expect(out.level).toBe('warn');
  });

  it('handles a thrown string', () => {
    const out = buildRpcErrorOutcome('rc.task.create', 'plain string failure', ['title']);
    expect(out.code).toBe('PLUGIN_ERROR');
    expect(out.message).toBe('plain string failure');
    expect(out.level).toBe('error');
  });

  it('NEVER logs param VALUES — only key names (secret safety)', () => {
    // provider.upsert / setApiKey carry an apiKey value; it must not leak.
    const err = new Error('upsert failed');
    const secret = 'sk-test-DEADBEEF-do-not-leak';
    const out = buildRpcErrorOutcome('rc.provider.upsert', err, ['provider', 'apiKey']);
    expect(out.line).toContain('apiKey'); // the KEY is fine
    expect(out.line).not.toContain(secret); // the VALUE must never appear
  });

  it('renders (none) when there are no params', () => {
    const out = buildRpcErrorOutcome('rc.onboarding.status', new Error('x'), []);
    expect(out.line).toContain('params: [(none)]');
  });
});
