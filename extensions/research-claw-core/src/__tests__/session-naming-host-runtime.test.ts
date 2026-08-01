import { access } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  createSessionNamingRuntimeComplete,
  type SessionNamingEmbeddedRunParams,
} from '../session-naming/host-runtime.js';

const CONFIG_WITHOUT_PROVIDER_CATALOG = {
  agents: {
    defaults: {
      model: { primary: 'deepseek/deepseek-v4-pro' },
    },
  },
};

describe('session naming host runtime parity', () => {
  it('uses OC modelRun so agent discovery can resolve a primary absent from models.providers', async () => {
    let sessionFile = '';
    const runEmbeddedAgent = vi.fn(async (params: SessionNamingEmbeddedRunParams) => {
      sessionFile = String(params.sessionFile);
      await expect(access(sessionFile.slice(0, sessionFile.lastIndexOf('/')))).resolves.toBeUndefined();
      return { payloads: [{ text: '注意力机制论文整理' }] };
    });
    const complete = createSessionNamingRuntimeComplete({
      runEmbeddedAgent,
      getConfig: () => CONFIG_WITHOUT_PROVIDER_CATALOG,
      resolveWorkspaceDir: () => '/tmp/research-claw-workspace',
    });

    const result = await complete({
      messages: [{ role: 'user', content: 'Generate a title' }],
      maxTokens: 2048,
      temperature: 0,
      purpose: 'research-claw:session-auto-name',
    });

    expect(result).toEqual({ text: '注意力机制论文整理' });
    expect(runEmbeddedAgent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'main',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      modelRun: true,
      promptMode: 'none',
      disableTools: true,
      workspaceDir: '/tmp/research-claw-workspace',
      streamParams: { maxTokens: 2048, temperature: 0 },
    }));
    await expect(access(sessionFile.slice(0, sessionFile.lastIndexOf('/')))).rejects.toThrow();
  });

  it('removes the temporary transcript after a model failure', async () => {
    let sessionFile = '';
    const complete = createSessionNamingRuntimeComplete({
      runEmbeddedAgent: vi.fn(async (params: SessionNamingEmbeddedRunParams) => {
        sessionFile = String(params.sessionFile);
        throw new Error('provider unavailable');
      }),
      getConfig: () => CONFIG_WITHOUT_PROVIDER_CATALOG,
      resolveWorkspaceDir: () => '/tmp/research-claw-workspace',
    });

    await expect(complete({ messages: [{ role: 'user', content: 'Title this' }] }))
      .rejects.toThrow('provider unavailable');
    await expect(access(sessionFile.slice(0, sessionFile.lastIndexOf('/')))).rejects.toThrow();
  });
});
