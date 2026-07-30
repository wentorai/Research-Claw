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

  it('returns the unpaginated total and only clears after explicit all-scope confirmation', async () => {
    const h = await loadPluginFresh({
      enabled: true,
      reviewMode: 'correct',
      dangerousToolPolicy: 'block',
    });
    await h.rpc.get('rc.supervisor.status')!({});
    for (const sessionKey of ['agent:main:one', 'agent:main:two']) {
      await h.fire(
        'before_tool_call',
        { toolName: 'exec', params: { command: 'rm -rf /' } },
        { sessionKey, toolName: 'exec' },
      );
    }

    const page = await h.rpc.get('rc.supervisor.log')!({ limit: 1, type: 'tool_review' }) as {
      entries: unknown[];
      total: number;
    };
    expect(page.entries).toHaveLength(1);
    expect(page.total).toBe(2);

    await expect(h.rpc.get('rc.supervisor.log.clear')!({})).rejects.toThrow(/scope.*all/i);
    expect((await h.rpc.get('rc.supervisor.log')!({ type: 'tool_review' }) as { total: number }).total).toBe(2);

    expect(await h.rpc.get('rc.supervisor.log.clear')!({ scope: 'all' })).toEqual({
      ok: true,
      deleted: 3,
    });
    expect((await h.rpc.get('rc.supervisor.log')!({}) as { total: number }).total).toBe(0);
    expect(h.broadcasts.at(-1)).toEqual({
      event: 'plugin.supervisor.review.cleared',
      payload: { deleted: 3, timestamp: expect.any(Number) },
    });
    expect(await h.rpc.get('rc.supervisor.status')!({})).toMatchObject({
      enabled: true,
      reviewMode: 'correct',
    });
  });
});
