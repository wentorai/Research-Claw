import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionNamingLlmParams, SessionNamingLlmResult } from './service.js';

const MODEL_RUN_TIMEOUT_MS = 120_000;

export interface SessionNamingEmbeddedRunParams {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  trigger: 'manual';
  sessionFile: string;
  workspaceDir: string;
  config: Record<string, unknown>;
  prompt: string;
  provider: string;
  model: string;
  modelRun: true;
  promptMode: 'none';
  disableTools: true;
  timeoutMs: number;
  runId: string;
  cleanupBundleMcpOnRunEnd: true;
  streamParams: { maxTokens?: number; temperature?: number };
  abortSignal?: AbortSignal;
}

export interface SessionNamingEmbeddedRunResult {
  payloads?: Array<{ text?: string; isError?: boolean; isReasoning?: boolean }>;
  meta?: { finalAssistantVisibleText?: string };
}

export interface SessionNamingHostRuntimeOptions {
  runEmbeddedAgent?: (
    params: SessionNamingEmbeddedRunParams,
  ) => Promise<SessionNamingEmbeddedRunResult>;
  getConfig: () => Record<string, unknown>;
  resolveWorkspaceDir: (config: Record<string, unknown>, agentId: string) => string;
}

function resolvePrimaryModel(config: Record<string, unknown>): { provider: string; model: string } {
  const agents = config.agents && typeof config.agents === 'object'
    ? config.agents as Record<string, unknown>
    : undefined;
  const defaults = agents?.defaults && typeof agents.defaults === 'object'
    ? agents.defaults as Record<string, unknown>
    : undefined;
  const modelConfig = defaults?.model;
  const primary = typeof modelConfig === 'string'
    ? modelConfig
    : modelConfig && typeof modelConfig === 'object'
      ? (modelConfig as Record<string, unknown>).primary
      : undefined;
  if (typeof primary !== 'string') {
    throw new Error('Research-Claw primary model is not configured for session naming');
  }
  const slash = primary.indexOf('/');
  if (slash <= 0 || slash === primary.length - 1) {
    throw new Error('Research-Claw primary model must use provider/model format');
  }
  return { provider: primary.slice(0, slash), model: primary.slice(slash + 1) };
}

function collectVisibleText(result: SessionNamingEmbeddedRunResult): string {
  const payloadText = (result.payloads ?? [])
    .filter((payload) => !payload.isError && !payload.isReasoning)
    .map((payload) => payload.text?.trim() ?? '')
    .filter(Boolean)
    .join('\n')
    .trim();
  return payloadText || result.meta?.finalAssistantVisibleText?.trim() || '';
}

/**
 * Build the title completion on OC's one-shot modelRun path.
 *
 * OC 6.1's lightweight runtime.llm.complete intentionally skips agent model
 * discovery. That rejects configured plugin-supplied models which the normal
 * chat runner resolves successfully. modelRun is the host-owned no-tools path
 * used by OC itself for one-shot inference; it preserves model/auth parity
 * without duplicating provider transport in Research-Claw.
 */
export function createSessionNamingRuntimeComplete(
  options: SessionNamingHostRuntimeOptions,
): (params: SessionNamingLlmParams) => Promise<SessionNamingLlmResult> {
  return async (params) => {
    if (!options.runEmbeddedAgent) {
      throw new Error('Research-Claw embedded agent runtime is unavailable for session naming');
    }
    const config = options.getConfig();
    const { provider, model } = resolvePrimaryModel(config);
    const workspaceDir = options.resolveWorkspaceDir(config, 'main');
    const tempDir = await mkdtemp(join(tmpdir(), 'research-claw-session-name-'));
    const runId = `session-name-${randomUUID()}`;
    try {
      const result = await options.runEmbeddedAgent({
        sessionId: runId,
        sessionKey: `agent:main:session-naming:${runId}`,
        agentId: 'main',
        trigger: 'manual',
        sessionFile: join(tempDir, 'session.jsonl'),
        workspaceDir,
        config,
        prompt: params.messages.map((message) => message.content).join('\n\n'),
        provider,
        model,
        modelRun: true,
        promptMode: 'none',
        disableTools: true,
        timeoutMs: MODEL_RUN_TIMEOUT_MS,
        runId,
        cleanupBundleMcpOnRunEnd: true,
        streamParams: {
          ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
          ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        },
        ...(params.signal ? { abortSignal: params.signal } : {}),
      });
      const text = collectVisibleText(result);
      if (!text) throw new Error('Session naming model returned an empty response');
      return { text };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}
