/**
 * Plugin integration harness — registers and drives the REAL index.ts plugin
 * through a mock PluginApi, invoking hooks with the true OpenClaw
 * `handler(event, ctx)` two-argument contract. No hook logic is re-implemented
 * here; the harness only captures the handlers the plugin registers and fires
 * them, so tests exercise production wiring (session resolution, footer cache,
 * audit) exactly as the gateway would.
 */

import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

export interface Harness {
  /** Fire a hook with the real (event, ctx) signature; returns the merged handler result. */
  fire(hookName: string, event: unknown, ctx: unknown): Promise<unknown>;
  /** Registered RPC methods (rc.supervisor.*). */
  rpc: Map<string, (params: Record<string, unknown>) => Promise<unknown>>;
  /** Captured logger output. */
  logs: { info: string[]; warn: string[]; error: string[] };
  /**
   * Wait until `predicate()` is truthy (polling real state), or reject after
   * `timeoutMs`. This is a state-based completion condition — NOT a fixed sleep —
   * so it is correct regardless of machine speed or how long the async work takes.
   */
  waitUntil(predicate: () => boolean, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<void>;
  hookNames(): string[];
}

let _dbCounter = 0;

/**
 * Load a FRESH copy of the plugin (module singletons reset) and register it
 * against a mock api. Each call is isolated so multi-session state does not leak
 * across tests.
 */
export async function loadPluginFresh(
  pluginConfig: Record<string, unknown>,
  globalConfig?: Record<string, unknown>,
): Promise<Harness> {
  vi.resetModules();

  const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] };
  const hooks = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const rpc = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();

  // Unique temp DB path per harness so better-sqlite3 never collides.
  const dbPath = pluginConfig.dbPath ?? path.join(os.tmpdir(), `rc-supervisor-test-${process.pid}-${_dbCounter++}.db`);

  const api = {
    id: 'dual-model-supervisor',
    name: 'Dual Model Supervisor',
    config: globalConfig,
    pluginConfig: { ...pluginConfig, dbPath },
    logger: {
      debug: () => {},
      info: (m: string) => logs.info.push(m),
      warn: (m: string) => logs.warn.push(m),
      error: (m: string) => logs.error.push(m),
    },
    resolvePath: (p: string) => p,
    registerTool: () => {},
    registerGatewayMethod: (method: string, handler: unknown) => {
      // Adapt the gateway (opts) form to a simple params→result callable for tests.
      rpc.set(method, async (params: Record<string, unknown>) => {
        let captured: unknown;
        let capturedErr: { code: string; message: string } | undefined;
        await (handler as (opts: unknown) => Promise<void>)({
          params,
          respond: (ok: boolean, payload?: unknown, error?: { code: string; message: string }) => {
            if (ok) captured = payload;
            else capturedErr = error;
          },
          context: {},
        });
        if (capturedErr) throw new Error(capturedErr.message);
        return captured;
      });
    },
    registerHttpRoute: () => {},
    registerService: () => {},
    on: (hookName: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      const list = hooks.get(hookName) ?? [];
      list.push(handler);
      hooks.set(hookName, list);
    },
  };

  const mod = (await import('../../../index.js')) as {
    default: { register: (api: unknown) => void };
  };
  mod.default.register(api);

  return {
    async fire(hookName, event, ctx) {
      const list = hooks.get(hookName) ?? [];
      let result: unknown;
      for (const handler of list) {
        const r = await handler(event, ctx);
        if (r !== undefined && r !== null) result = r;
      }
      return result;
    },
    rpc,
    logs,
    async waitUntil(predicate, opts) {
      const timeoutMs = opts?.timeoutMs ?? 2000;
      const intervalMs = opts?.intervalMs ?? 5;
      const start = Date.now();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (predicate()) return;
        if (Date.now() - start > timeoutMs) {
          throw new Error(`waitUntil: predicate not satisfied within ${timeoutMs}ms`);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    },
    hookNames: () => [...hooks.keys()],
  };
}
