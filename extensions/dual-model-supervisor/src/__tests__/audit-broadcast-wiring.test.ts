import { describe, expect, it } from 'vitest';
import { loadPluginFresh } from './harness/plugin-harness.js';

describe('supervisor audit broadcast wiring', () => {
  it('captures the real RPC context and emits a privacy-safe notification after an audit is persisted', async () => {
    const h = await loadPluginFresh({
      enabled: true,
      supervisorModel: 'testprov/testmodel',
      reviewMode: 'correct',
      dangerousToolPolicy: 'block',
      providers: {
        testprov: {
          api: 'openai-completions',
          baseUrl: 'http://mock.local/x',
          apiKey: 'k',
          models: [{ id: 'testmodel' }],
        },
      },
    });

    // Positive control: the same captured gateway handler can execute a known RPC.
    const status = await h.rpc.get('rc.supervisor.status')!({});
    expect(status).toMatchObject({ enabled: true });
    expect(h.broadcasts).toEqual([]);

    await h.fire(
      'before_tool_call',
      { toolName: 'exec', params: { command: 'rm -rf /' } },
      { sessionKey: 'agent:main:broadcast', toolName: 'exec' },
    );

    const log = await h.rpc.get('rc.supervisor.log')!({ type: 'tool_review' }) as {
      entries: Array<{ sessionId: string; type: string; action: string }>;
    };
    expect(log.entries).toHaveLength(1);
    expect(h.broadcasts).toEqual([{
      event: 'plugin.supervisor.review.updated',
      payload: {
        sessionId: 'agent:main:broadcast',
        type: 'tool_review',
        action: 'block',
        timestamp: expect.any(Number),
        persisted: true,
      },
    }]);
    expect(JSON.stringify(h.broadcasts)).not.toContain('rm -rf');
  });

  it('broadcasts a serving-hook audit through the RPC context owned by another module instance', async () => {
    const config = {
      enabled: true,
      supervisorModel: 'testprov/testmodel',
      reviewMode: 'correct',
      dangerousToolPolicy: 'block',
      providers: {
        testprov: {
          api: 'openai-completions',
          baseUrl: 'http://mock.local/x',
          apiKey: 'k',
          models: [{ id: 'testmodel' }],
        },
      },
    };
    const servingHooks = await loadPluginFresh(config);
    const rpcOwner = await loadPluginFresh(
      config,
      undefined,
      { preserveRuntimeConfigHub: true },
    );

    await rpcOwner.rpc.get('rc.supervisor.status')!({});
    await servingHooks.fire(
      'before_tool_call',
      { toolName: 'exec', params: { command: 'rm -rf /' } },
      { sessionKey: 'agent:main:cross-module-broadcast', toolName: 'exec' },
    );

    expect(rpcOwner.broadcasts).toEqual([{
      event: 'plugin.supervisor.review.updated',
      payload: {
        sessionId: 'agent:main:cross-module-broadcast',
        type: 'tool_review',
        action: 'block',
        timestamp: expect.any(Number),
        persisted: true,
      },
    }]);
  });
});
