import type { ExecutionTraceService } from '../execution-trace/service.js';
import { registerExecutionTraceRpc } from '../execution-trace/rpc.js';
import type { RegisterMethod } from '../types.js';
import type { PresentationService } from './service.js';

function validateRunIds(params: Record<string, unknown>): { sessionKey: string; runIds: string[] } {
  if (typeof params.sessionKey !== 'string' || !params.sessionKey) {
    throw new Error('sessionKey is required');
  }
  if (
    !Array.isArray(params.runIds)
    || params.runIds.length < 1
    || params.runIds.length > 100
    || params.runIds.some((runId) => typeof runId !== 'string' || !runId)
  ) {
    throw new Error('runIds must be an array of 1-100 non-empty strings');
  }
  return { sessionKey: params.sessionKey, runIds: [...new Set(params.runIds as string[])] };
}

export function registerPresentationRpc(
  registerMethod: RegisterMethod,
  presentations: PresentationService,
  executionTrace: ExecutionTraceService,
): void {
  registerExecutionTraceRpc(registerMethod, executionTrace);
  registerMethod('rc.execution.presentations', async (params) => {
    const { sessionKey, runIds } = validateRunIds(params);
    const foreign = runIds.find((runId) => (
      (presentations.hasForeignRun(sessionKey, runId) || executionTrace.hasForeignRun(sessionKey, runId))
      && !presentations.hasRun(sessionKey, runId)
      && !executionTrace.hasRun(sessionKey, runId)
    ));
    if (foreign) throw new Error(`runId does not belong to sessionKey: ${foreign}`);
    return { presentations: presentations.getRuns(sessionKey, runIds) };
  });
  registerMethod('rc.execution.cleanupSession', async (params) => {
    if (typeof params.sessionKey !== 'string' || !params.sessionKey) {
      throw new Error('sessionKey is required');
    }
    const deletedRecords = presentations.deleteSession(params.sessionKey);
    executionTrace.deleteSession(params.sessionKey);
    return { ok: true, deletedRecords };
  });
}
