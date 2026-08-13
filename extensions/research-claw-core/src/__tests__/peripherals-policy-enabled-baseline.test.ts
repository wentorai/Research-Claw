import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import plugin from '../../index.js';

const inventory = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../../../../test/fixtures/peripherals-policy-enabled-inventory-0.8.2.json'),
  'utf8',
)) as {
  agentTools: { coreTotal: number; peripherals: string[] };
  gatewayRpc: { coreTotal: number; peripherals: string[] };
  httpRoutes: { coreTotal: number; all: string[]; peripherals: string[] };
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-peripherals-enabled-baseline-'));
const services: Array<{ stop?: () => void | Promise<void> }> = [];
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });

afterAll(async () => {
  for (const service of services) await service.stop?.();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('0.8.2 all-enabled peripherals runtime inventory baseline', () => {
  async function captureInventory(productPolicy?: unknown) {
    const tools: string[] = [];
    const rpc: string[] = [];
    const routes: string[] = [];
    let bootstrapHook: ((event: any) => void) | undefined;

    await plugin.register?.({
      id: 'research-claw-core',
      name: 'Research-Claw Core',
      pluginConfig: {
        dbPath: path.join(root, 'library.db'),
        workspace: { root: workspace },
        ...(productPolicy === undefined ? {} : { productPolicy }),
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
      registerGatewayMethod: (method: string) => { rpc.push(method); },
      registerHttpRoute: (route: { path?: string }) => { if (route.path) routes.push(route.path); },
      registerService: (service: { stop?: () => void | Promise<void> }) => { services.push(service); },
      on: () => {},
      registerHook: (name: string, handler: (event: any) => void) => {
        if (name === 'agent:bootstrap') bootstrapHook = handler;
      },
    } as never);

    return { tools, rpc, routes, bootstrapHook };
  }

  it.each([
    ['ordinary absent policy', undefined],
    ['enabled-hidden presentation policy', {
      capabilities: {
        settings: 'enabled-hidden',
        extensions: 'enabled-hidden',
        supervisor: 'enabled-hidden',
        peripherals: 'enabled-hidden',
      },
    }],
  ] as const)('keeps the exact tool, RPC, and HTTP inventory for %s', async (_name, policy) => {
    const { tools, rpc, routes, bootstrapHook } = await captureInventory(policy);

    expect(tools).toHaveLength(inventory.agentTools.coreTotal);
    expect(rpc).toHaveLength(inventory.gatewayRpc.coreTotal);
    expect(routes.sort()).toEqual(inventory.httpRoutes.all);
    expect(inventory.agentTools.peripherals.every((name) => tools.includes(name))).toBe(true);
    expect(inventory.gatewayRpc.peripherals.every((name) => rpc.includes(name))).toBe(true);
    expect(inventory.httpRoutes.peripherals.every((route) => routes.includes(route))).toBe(true);

    const rootAgents = path.join(workspace, 'AGENTS.md');
    const upstreamContent = '## §11 Peripherals\nENABLED_PERIPHERAL_SENTINEL periph_list\n';
    fs.writeFileSync(rootAgents, upstreamContent);
    fs.rmSync(path.join(workspace, '.ResearchClaw'), { recursive: true, force: true });
    const upstream = {
      context: {
        workspaceDir: workspace,
        bootstrapFiles: [{ name: 'AGENTS.md', path: rootAgents, missing: false, content: upstreamContent }],
      },
    };
    bootstrapHook?.({ ...upstream, context: { ...upstream.context, pluginConfig: {} } });
    expect(upstream.context.bootstrapFiles[0]?.content).toContain('ENABLED_PERIPHERAL_SENTINEL');
  });
});
