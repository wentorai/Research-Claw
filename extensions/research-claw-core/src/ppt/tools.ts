import type { ToolDefinition } from '../types.js';
import type { PptService } from './service.js';

function ok(text: string, details: unknown): unknown {
  return { content: [{ type: 'text', text }], details };
}

function fail(message: string): unknown {
  return { content: [{ type: 'text', text: `Error: ${message}` }], details: { error: message } };
}

export function createPptTools(service: PptService): ToolDefinition[] {
  return [
    {
      name: 'ppt_init',
      description:
        'Initialize a PPT Master project (skills/ppt-master/scripts/project_manager.py init). ' +
        'Use this before generating slides.',
      parameters: {
        type: 'object',
        required: ['projectName'],
        properties: {
          projectName: {
            type: 'string',
            minLength: 1,
            maxLength: 120,
            description: 'Project folder name (letters, numbers, _, -, .)',
          },
          format: {
            type: 'string',
            default: 'ppt169',
            description: 'Canvas format (e.g. ppt169)',
          },
        },
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          if (typeof params.projectName !== 'string') return fail('projectName is required');
          const result = await service.initProject({
            projectName: params.projectName,
            format: typeof params.format === 'string' ? params.format : undefined,
          });
          return ok(
            `PPT project initialized: ${result.projectPath}`,
            result,
          );
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: 'ppt_export',
      description:
        'Export a PPT Master project to PPTX (skills/ppt-master/scripts/svg_to_pptx.py). ' +
        'projectPath must be relative to the ppt workspace root.',
      parameters: {
        type: 'object',
        required: ['projectPath'],
        properties: {
          projectPath: {
            type: 'string',
            minLength: 1,
            description: 'Project path under pptRoot, e.g. projects/my-deck',
          },
          stage: {
            type: 'string',
            default: 'final',
            description: 'Export stage passed to -s (default: final)',
          },
        },
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          if (typeof params.projectPath !== 'string') return fail('projectPath is required');
          const result = await service.exportProject({
            projectPath: params.projectPath,
            stage: typeof params.stage === 'string' ? params.stage : undefined,
          });
          const { sourceOutputPath: _ignoredSourceOutputPath, ...publicResult } = result;
          return ok(
            `PPT export completed. Output saved to workspace outputs: ${result.outputPath ?? result.projectPath}`,
            publicResult,
          );
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];
}
