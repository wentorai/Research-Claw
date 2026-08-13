import { afterAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof BetterSqlite3;

const constructed: string[] = [];
const forbiddenRegistration: string[] = [];
const bridgeAdoptions: unknown[] = [];

vi.mock('../periph/service.js', () => ({
  PeriphService: class {
    constructor() {
      constructed.push('PeriphService');
      throw new Error('PeriphService must not be constructed while peripherals are disabled');
    }
  },
}));
vi.mock('../periph/plaud.js', () => ({
  PlaudManager: class {
    constructor() {
      constructed.push('PlaudManager');
      throw new Error('PlaudManager must not be constructed while peripherals are disabled');
    }
  },
}));
vi.mock('../periph/rtsp-preview.js', () => ({
  PREVIEW_PLAYLIST_NAME: 'index.m3u8',
  RtspPreviewManager: class {
    constructor() {
      constructed.push('RtspPreviewManager');
      throw new Error('RtspPreviewManager must not be constructed while peripherals are disabled');
    }
  },
}));
vi.mock('../periph/tools.js', () => ({
  createPeriphTools: () => {
    forbiddenRegistration.push('tools');
    throw new Error('peripheral tools factory must not run while disabled');
  },
}));
vi.mock('../periph/rpc.js', () => ({
  RTSP_PREVIEW_ROUTE: '/rc/rtsp-preview',
  registerPeriphRpc: () => {
    forbiddenRegistration.push('rpc');
    throw new Error('peripheral RPC factory must not run while disabled');
  },
}));
vi.mock('../periph/bridge.js', () => ({
  periphBridge: {
    adoptContext: (context: unknown) => {
      bridgeAdoptions.push(context);
      throw new Error('generic RPC must not adopt a peripheral bridge while disabled');
    },
  },
}));

const inventory = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../../../../test/fixtures/peripherals-policy-enabled-inventory-0.8.2.json'),
  'utf8',
)) as {
  agentTools: { coreTotal: number; peripherals: string[] };
  gatewayRpc: { coreTotal: number; peripherals: string[] };
  httpRoutes: { coreTotal: number; all: string[]; peripherals: string[] };
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-peripherals-disabled-register-'));

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('disabled peripherals Core registration', () => {
  it('omits every active surface, leaves manifest declarations, and filters bootstrap in memory', async () => {
    const { default: plugin } = await import('../../index.js');
    const tools: string[] = [];
    const rpc = new Map<string, (opts: any) => Promise<void>>();
    const routes: string[] = [];
    const hooks = new Map<string, (event: any) => void>();
    const typedHooks = new Map<string, Array<(event: any) => unknown>>();
    const workspace = path.join(root, 'workspace');
    const rcDir = path.join(workspace, '.ResearchClaw');
    fs.mkdirSync(rcDir, { recursive: true });
    const agentsPath = path.join(rcDir, 'AGENTS.md');
    const onDisk = [
      '# Agent contract',
      '## §10 File Layers',
      'keep-before',
      '## §11 Peripherals',
      'Use periph_list and source_type=device.',
      '## §12 Preserved',
      'keep-after',
      '',
    ].join('\n');
    fs.writeFileSync(agentsPath, onDisk);

    await plugin.register?.({
      id: 'research-claw-core',
      name: 'Research-Claw Core',
      pluginConfig: {
        dbPath: path.join(root, 'library.db'),
        workspace: { root: workspace },
        productPolicy: {
          capabilities: {
            settings: 'enabled-hidden',
            extensions: 'enabled-hidden',
            supervisor: 'enabled-hidden',
            peripherals: 'disabled',
          },
        },
      },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      runtime: {
        config: {
          current: () => ({}),
          mutateConfigFile: async () => ({ path: '', persistedHash: null }),
        },
      },
      resolvePath: (input: string) => path.isAbsolute(input) ? input : path.join(root, input),
      registerTool: (tool: { name?: string }) => { if (tool.name) tools.push(tool.name); },
      registerGatewayMethod: (method: string, handler: (opts: any) => Promise<void>) => { rpc.set(method, handler); },
      registerHttpRoute: (route: { path?: string }) => { if (route.path) routes.push(route.path); },
      registerService: () => {},
      on: (name: string, handler: (event: any) => unknown) => {
        typedHooks.set(name, [...(typedHooks.get(name) ?? []), handler]);
      },
      registerHook: (name: string, handler: (event: any) => void) => { hooks.set(name, handler); },
    } as never);

    expect(constructed).toEqual([]);
    expect(forbiddenRegistration).toEqual([]);
    expect(tools).toHaveLength(inventory.agentTools.coreTotal - inventory.agentTools.peripherals.length);
    expect(rpc).toHaveLength(inventory.gatewayRpc.coreTotal - inventory.gatewayRpc.peripherals.length);
    expect(routes).toHaveLength(inventory.httpRoutes.coreTotal - inventory.httpRoutes.peripherals.length);
    expect(inventory.agentTools.peripherals.some((name) => tools.includes(name))).toBe(false);
    expect(inventory.gatewayRpc.peripherals.some((name) => rpc.has(name))).toBe(false);
    expect(routes).not.toContain('/rc/rtsp-preview');
    expect(plugin.contracts?.tools).toEqual(expect.arrayContaining(inventory.agentTools.peripherals));

    let monitorResponse: { ok?: boolean; error?: { code?: string } } | undefined;
    await rpc.get('rc.monitor.list')?.({
      params: {},
      context: { broadcast: () => {} },
      respond: (ok: boolean, _payload: unknown, error: { code?: string }) => {
        monitorResponse = { ok, error };
      },
    });
    expect(monitorResponse?.ok).toBe(true);
    expect(bridgeAdoptions).toEqual([]);

    const bootstrap: {
      context: {
        workspaceDir: string;
        bootstrapFiles: Array<{ name: string; path: string; missing: boolean; content?: string }>;
      };
    } = {
      context: {
        workspaceDir: workspace,
        bootstrapFiles: [{ name: 'AGENTS.md', path: path.join(workspace, 'AGENTS.md'), missing: true }],
      },
    };
    const pluginEvent = {
      ...bootstrap,
      // Mirror OC 2026.6.1 registry's shallow event.context copy. The hook
      // must mutate the shared bootstrapFiles array for the upstream resolver.
      context: { ...bootstrap.context, pluginConfig: {} },
    };
    hooks.get('agent:bootstrap')?.(pluginEvent);
    const injected = bootstrap.context.bootstrapFiles[0]?.content ?? '';
    expect(injected).toContain('keep-before');
    expect(injected).toContain('keep-after');
    expect(injected).not.toMatch(/§11|periph_|source_type\s*=\s*device/i);
    expect(fs.readFileSync(agentsPath, 'utf8')).toBe(onDisk);

    fs.rmSync(rcDir, { recursive: true, force: true });
    const rootAgentsPath = path.join(workspace, 'AGENTS.md');
    const upstreamContent = [
      '## §10 Root Before',
      'root-before',
      '## §11 Peripherals',
      'ROOT_PERIPHERAL_SENTINEL periph_list',
      '## §12 Root After',
      'root-after',
      '',
    ].join('\n');
    fs.writeFileSync(rootAgentsPath, upstreamContent);
    const upstreamBootstrap = {
      context: {
        workspaceDir: workspace,
        bootstrapFiles: [{
          name: 'AGENTS.md', path: rootAgentsPath, missing: false, content: upstreamContent,
        }],
      },
    };
    const upstreamPluginEvent = {
      ...upstreamBootstrap,
      context: { ...upstreamBootstrap.context, pluginConfig: {} },
    };
    hooks.get('agent:bootstrap')?.(upstreamPluginEvent);
    expect(upstreamBootstrap.context.bootstrapFiles[0]).toMatchObject({
      path: rootAgentsPath,
      missing: false,
    });
    expect(upstreamBootstrap.context.bootstrapFiles[0]?.content).toContain('root-before');
    expect(upstreamBootstrap.context.bootstrapFiles[0]?.content).toContain('root-after');
    expect(upstreamBootstrap.context.bootstrapFiles[0]?.content).not.toMatch(/§11|ROOT_PERIPHERAL_SENTINEL|periph_list/i);
    expect(fs.readFileSync(rootAgentsPath, 'utf8')).toBe(upstreamContent);

    const db = new Database(path.join(root, 'library.db'));
    try {
      db.prepare(`
        INSERT INTO rc_monitors (
          id, name, source_type, target, filters, schedule, enabled, notify,
          agent_prompt, gateway_job_id, last_results, memory, created_at, updated_at
        ) VALUES (
          'legacy-whitespace-device', 'PRIVATE_DEVICE_MONITOR', ?, 'camera-id', '{}',
          '*/5 * * * *', 1, 1, 'PRIVATE_DEVICE_PROMPT periph_camera_snap',
          'cron-device-job', '[]', '{"v":1,"seen":[],"runs":[],"notes":""}',
          datetime('now'), datetime('now')
        )
      `).run('\tDEVICE\u00a0');
    } finally {
      db.close();
    }
    const promptHook = typedHooks.get('before_prompt_build')?.[0];
    expect(promptHook).toBeTypeOf('function');
    const promptResult = await promptHook?.({ prompt: '', messages: [] }) as
      { prependContext?: string } | undefined;
    expect(promptResult?.prependContext ?? '').not.toMatch(
      /PRIVATE_DEVICE_MONITOR|PRIVATE_DEVICE_PROMPT|periph_camera_snap/i,
    );
  });
});
