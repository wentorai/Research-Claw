import type { RegisterMethod } from '../types.js';
import type { ExecutionTraceService } from './service.js';

export function registerExecutionTraceRpc(
  registerMethod: RegisterMethod,
  service: ExecutionTraceService,
): void {
  registerMethod('rc.execution.summary', async (params) => {
    if (!Array.isArray(params.runIds) || params.runIds.length > 100 || params.runIds.some((id) => typeof id !== 'string' || !id)) {
      throw new Error('runIds must be an array of 1-100 non-empty strings');
    }
    return { summaries: service.summary(params.runIds) };
  });
  registerMethod('rc.execution.detail', async (params) => {
    if (typeof params.runId !== 'string' || !params.runId) throw new Error('runId is required');
    return {
      runId: params.runId,
      tools: service.detail(params.runId),
      skills: service.skillDetail(params.runId),
    };
  });
  registerMethod('rc.execution.resolve', async (params) => {
    if (typeof params.sessionKey !== 'string' || !params.sessionKey) {
      throw new Error('sessionKey is required');
    }
    if (!Array.isArray(params.candidates) || params.candidates.length > 500) {
      throw new Error('candidates must be an array with at most 500 items');
    }
    const candidates = params.candidates.map((item, position) => {
      const candidate = item as Record<string, unknown>;
      if (
        typeof candidate.index !== 'number'
        || !Number.isInteger(candidate.index)
        || candidate.index < 0
        || typeof candidate.timestamp !== 'number'
        || !Number.isFinite(candidate.timestamp)
        || !Array.isArray(candidate.textHashes)
        || candidate.textHashes.length < 1
        || candidate.textHashes.length > 2
        || candidate.textHashes.some((hash) => typeof hash !== 'string' || !/^[0-9a-f]{8}$/.test(hash))
        || (
          candidate.turnStartedAt !== undefined
          && (typeof candidate.turnStartedAt !== 'number' || !Number.isFinite(candidate.turnStartedAt))
        )
      ) {
        throw new Error(`invalid reply candidate at position ${position}`);
      }
      return {
        index: candidate.index,
        timestamp: candidate.timestamp,
        textHashes: candidate.textHashes as string[],
        turnStartedAt: candidate.turnStartedAt as number | undefined,
      };
    });
    return { bindings: service.resolveReplies(params.sessionKey, candidates) };
  });
}
