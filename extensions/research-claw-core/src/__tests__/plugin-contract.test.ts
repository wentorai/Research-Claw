import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import plugin from '../../index.js';

describe('research-claw-core plugin contracts', () => {
  it('exports the full agent tool contract used by the manifest', () => {
    const manifestPath = path.resolve(__dirname, '../../openclaw.plugin.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      contracts?: { tools?: string[] };
    };
    const runtimeTools = plugin.contracts?.tools ?? [];
    const manifestTools = manifest.contracts?.tools ?? [];

    expect(runtimeTools).toEqual(manifestTools);
    expect(runtimeTools).toContain('library_add_paper');
    expect(runtimeTools).toContain('library_search');
    expect(runtimeTools).toContain('task_list');
    expect(runtimeTools).toContain('workspace_read');
    expect(runtimeTools).toContain('monitor_list');
    expect(runtimeTools).toContain('monitor_update');
    expect(runtimeTools).toContain('monitor_collect_candidates');
  });

  it('registers agent tools on every plugin register pass', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-plugin-contract-'));
    const dbPath = path.join(root, 'library.db');
    const makeApi = () => {
      const tools: Array<{ name?: string }> = [];
      return {
        tools,
        api: {
          id: 'research-claw-core',
          name: 'Research-Claw Core',
          pluginConfig: { dbPath },
          logger: {
            info: () => {},
            warn: () => {},
            error: () => {},
            debug: () => {},
          },
          runtime: {
            config: {
              current: () => ({}),
              mutateConfigFile: async () => ({ path: '', persistedHash: null }),
            },
          },
          resolvePath: (input: string) => path.isAbsolute(input) ? input : path.join(root, input),
          registerTool: (tool: unknown) => {
            if (typeof tool === 'object' && tool) tools.push(tool as { name?: string });
          },
          registerGatewayMethod: () => {},
          registerHttpRoute: () => {},
          registerService: () => {},
          on: () => {},
          registerHook: () => {},
        },
      };
    };

    const first = makeApi();
    const second = makeApi();
    await plugin.register?.(first.api);
    await plugin.register?.(second.api);

    expect(first.tools.map(tool => tool.name)).toContain('library_batch_add');
    expect(first.tools.map(tool => tool.name)).toContain('job_start');
    expect(second.tools.map(tool => tool.name)).toContain('library_batch_add');
    expect(second.tools.map(tool => tool.name)).toContain('job_start');
  });
});
