import { describe, expect, it } from 'vitest';

import { loadPluginFresh } from './harness/plugin-harness.js';

const OFF_CONFIG = {
  enabled: false,
  supervisorModel: 'test/reviewer',
  reviewMode: 'off',
};

describe('runtime config across independently evaluated plugin modules', () => {
  it('an RPC update controls hooks retained by the other module instance', async () => {
    const servingHooks = await loadPluginFresh(OFF_CONFIG);
    expect(await servingHooks.fire(
      'before_prompt_build',
      {},
      { sessionKey: 'agent:main:cross-module-config' },
    )).toEqual({});

    const rpcOwner = await loadPluginFresh(
      OFF_CONFIG,
      undefined,
      { preserveRuntimeConfigHub: true },
    );
    const updated = await rpcOwner.rpc.get('rc.supervisor.config')!({
      enabled: true,
      reviewMode: 'correct',
    }) as { ok?: boolean };
    expect(updated.ok).toBe(true);
    const runtimeConfigKey = Symbol.for('research-claw.dual-model-supervisor.runtime-config.v1');
    const shared = (globalThis as Record<PropertyKey, unknown>)[runtimeConfigKey] as {
      current?: { enabled?: boolean; reviewMode?: string };
    };
    expect(shared.current).toMatchObject({ enabled: true, reviewMode: 'correct' });

    const result = await servingHooks.fire(
      'before_prompt_build',
      {},
      { sessionKey: 'agent:main:cross-module-config' },
    ) as { prependContext?: string };
    expect(result).toEqual({
      prependContext: expect.stringContaining('[Supervisor] You are under dual-model supervision'),
    });

    const toolResult = await servingHooks.fire(
      'before_tool_call',
      { toolName: 'exec', params: { command: 'rm -rf /' } },
      { sessionKey: 'agent:main:cross-module-config' },
    ) as { block?: boolean };
    expect(toolResult.block).toBe(true);
  });
});
