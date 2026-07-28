import { describe, expect, it, vi } from 'vitest';
import { ReviewerClient } from '../client/reviewer.js';
import { parseConfig } from '../core/config.js';
import type { PluginLogger, ReviewerReadiness, RuntimeLlmComplete } from '../core/types.js';
import { loadPluginFresh } from './harness/plugin-harness.js';

function logger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } satisfies PluginLogger;
}

function emptyRuntimeResult() {
  return {
    text: '',
    provider: 'minimax',
    model: 'MiniMax-M2.7',
    agentId: 'main',
    usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
    audit: { caller: { kind: 'plugin' as const, id: 'dual-model-supervisor' } },
  };
}

describe('reviewer runtime health', () => {
  it('marks an empty runtime response unavailable, reports it once, and stops retrying until configuration changes', async () => {
    const runtimeComplete = vi.fn<RuntimeLlmComplete>(async () => emptyRuntimeResult());
    const log = logger();
    const transitions: ReviewerReadiness[] = [];
    const client = new ReviewerClient({
      supervisorConfig: parseConfig({
        enabled: true,
        supervisorModel: 'minimax/MiniMax-M2.7',
        reviewMode: 'correct',
      }),
      providers: {
        minimax: {
          baseUrl: 'https://api.minimaxi.com/v1',
          api: 'openai-completions',
          models: [{ id: 'MiniMax-M2.7' }],
        },
      },
      logger: log,
      runtimeComplete,
      onReadinessChanged: (readiness) => transitions.push(readiness),
    });

    expect(client.getReadiness()).toMatchObject({
      ready: true,
      effectiveModel: 'minimax/MiniMax-M2.7',
    });

    await expect(client.review('return JSON', 'first review')).resolves.toBeNull();
    expect(client.getReadiness()).toMatchObject({
      ready: false,
      modelSource: 'unavailable',
      effectiveModel: 'minimax/MiniMax-M2.7',
      reason: expect.stringMatching(/empty content/i),
    });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ ready: false });
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(
      /AI review.*no usable content.*main chat.*dangerous-command protection/i,
    ));

    await expect(client.review('return JSON', 'second review')).resolves.toBeNull();
    expect(runtimeComplete).toHaveBeenCalledTimes(1);
    expect(transitions).toHaveLength(1);

    client.updateSupervisorConfig(parseConfig({
      enabled: true,
      supervisorModel: 'minimax/MiniMax-M2.7',
      reviewMode: 'correct',
    }));
    expect(client.getReadiness().ready).toBe(true);

    await expect(client.review('return JSON', 'third review')).resolves.toBeNull();
    expect(runtimeComplete).toHaveBeenCalledTimes(2);
    expect(transitions).toHaveLength(2);
  });

  it('publishes the runtime degradation through status, logs, and persisted audit', async () => {
    const runtimeComplete = vi.fn<RuntimeLlmComplete>(async () => emptyRuntimeResult());
    const harness = await loadPluginFresh(
      {
        enabled: true,
        supervisorModel: 'minimax/MiniMax-M2.7',
        reviewMode: 'correct',
        toolReviewGateMs: 500,
      },
      {
        models: {
          providers: {
            minimax: {
              baseUrl: 'https://api.minimaxi.com/v1',
              api: 'openai-completions',
              models: [{ id: 'MiniMax-M2.7' }],
            },
          },
        },
      },
      { runtimeLlmComplete: runtimeComplete },
    );

    await harness.fire(
      'before_tool_call',
      { toolName: 'exec', params: { command: 'pwd' } },
      { sessionKey: 'agent:main:runtime-health' },
    );

    const status = await harness.rpc.get('rc.supervisor.status')!({}) as {
      reviewerReady: boolean;
      reviewerUnavailableReason?: string;
    };
    expect(status).toMatchObject({
      reviewerReady: false,
      reviewerUnavailableReason: expect.stringMatching(/empty content/i),
    });
    expect(harness.logs.warn).toContainEqual(expect.stringMatching(/AI review returned no usable content/i));

    const audit = await harness.rpc.get('rc.supervisor.log')!({ limit: 100 }) as {
      entries: Array<{ type: string; action: string; details: string }>;
    };
    expect(audit.entries).toContainEqual(expect.objectContaining({
      type: 'reviewer_health',
      action: 'warn',
      details: expect.stringMatching(/AI review returned no usable content/i),
    }));

    await harness.fire(
      'before_tool_call',
      { toolName: 'exec', params: { command: 'pwd -P' } },
      { sessionKey: 'agent:main:runtime-health' },
    );
    expect(runtimeComplete).toHaveBeenCalledTimes(1);
  });
});
