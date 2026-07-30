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
    return { runId: params.runId, tools: service.detail(params.runId) };
  });
}
