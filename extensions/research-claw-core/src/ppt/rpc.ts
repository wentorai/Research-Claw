import type { RegisterMethod } from '../types.js';
import type { PptService } from './service.js';

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value;
}

export function registerPptRpc(registerMethod: RegisterMethod, service: PptService): void {
  registerMethod('rc.ppt.status', () => {
    return service.getStatus();
  });

  registerMethod('rc.ppt.bootstrap', async () => {
    return service.bootstrapPptMaster();
  });

  registerMethod('rc.ppt.outputs.list', () => {
    return service.listWorkspaceOutputs();
  });

  registerMethod('rc.ppt.init', async (params: Record<string, unknown>) => {
    const projectName = requireString(params, 'projectName');
    const format = typeof params.format === 'string' ? params.format : undefined;
    return service.initProject({ projectName, format });
  });

  registerMethod('rc.ppt.export', async (params: Record<string, unknown>) => {
    const projectPath = requireString(params, 'projectPath');
    const stage = typeof params.stage === 'string' ? params.stage : undefined;
    return service.exportProject({ projectPath, stage });
  });

  registerMethod('rc.ppt.open', async (params: Record<string, unknown>) => {
    const filePath = requireString(params, 'filePath');
    return service.openOutput(filePath);
  });

  registerMethod('rc.ppt.outputs.rename', async (params: Record<string, unknown>) => {
    const inputPath = requireString(params, 'inputPath');
    const desiredBaseName = requireString(params, 'desiredBaseName');
    return service.renameOutputFile(inputPath, desiredBaseName);
  });
}
