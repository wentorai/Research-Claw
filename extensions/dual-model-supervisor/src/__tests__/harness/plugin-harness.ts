/**
 * Plugin integration harness — registers and drives the REAL index.ts plugin
 * through a mock PluginApi, invoking hooks with the true OpenClaw
 * `handler(event, ctx)` two-argument contract. No hook logic is re-implemented
 * here; the harness only captures the handlers the plugin registers and fires
 * them, so tests exercise production wiring (session resolution, review store,
 * audit) exactly as the gateway would.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, vi } from 'vitest';

export interface Harness {
  /** Fire a hook with the real (event, ctx) signature; returns the merged handler result. */
  fire(hookName: string, event: unknown, ctx: unknown): Promise<unknown>;
  /** Registered RPC methods (rc.supervisor.*). */
  rpc: Map<string, (params: Record<string, unknown>) => Promise<unknown>>;
  /** Captured logger output. */
  logs: { info: string[]; warn: string[]; error: string[] };
  /** Events emitted through the real gateway request context's broadcast function. */
  broadcasts: Array<{ event: string; payload: unknown }>;
  /** Exact SQLite path used by this harness instance. */
  databasePath: string;
  /** Harness-owned OpenClaw config path used by runtime.config mutations. */
  configPath: string;
  /** Whether the harness owns and removes the database path after the test. */
  ownsDatabasePath: boolean;
  /**
   * Wait until `predicate()` is truthy (polling real state), or reject after
   * `timeoutMs`. This is a state-based completion condition — NOT a fixed sleep —
   * so it is correct regardless of machine speed or how long the async work takes.
   */
  waitUntil(predicate: () => boolean, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<void>;
  hookNames(): string[];
  hookHandlerCounts(): Record<string, number>;
  /** Re-register against the same PluginApi surface to verify local de-duplication. */
  reregisterCurrentApi(): void;
  /**
   * Register the already-evaluated plugin module against a fresh PluginApi
   * registration surface, as happens during an in-process gateway restart.
   */
  registerFreshApi(): string[];
}

const pendingCleanup: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of pendingCleanup.splice(0)) cleanup();
});

/**
 * Load a FRESH copy of the plugin (module singletons reset) and register it
 * against a mock api. Each call is isolated so multi-session state does not leak
 * across tests.
 */
export async function loadPluginFresh(
  pluginConfig: Record<string, unknown>,
  globalConfig?: Record<string, unknown>,
  opts?: {
    preserveRuntimeConfigHub?: boolean;
    configMutationError?: Error;
    runtimeLlmComplete?: (params: {
      messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
      model?: string;
      maxTokens?: number;
      temperature?: number;
      systemPrompt?: string;
      signal?: AbortSignal;
      purpose?: string;
      agentId?: string;
    }) => Promise<{
      text: string;
      provider: string;
      model: string;
      agentId: string;
      usage: Record<string, number>;
      audit: { caller: { kind: 'plugin'; id?: string }; purpose?: string };
    }>;
  },
): Promise<Harness> {
  if (!opts?.preserveRuntimeConfigHub) {
    const runtimeConfigKey = Symbol.for('research-claw.dual-model-supervisor.runtime-config.v1');
    delete (globalThis as Record<PropertyKey, unknown>)[runtimeConfigKey];
  }
  vi.resetModules();

  const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] };
  const hooks = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const rpc = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const broadcasts: Array<{ event: string; payload: unknown }> = [];
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-supervisor-config-test-'));
  const configDir = path.join(configRoot, 'config');
  const configPath = path.join(configDir, 'openclaw.json');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({
      plugins: {
        entries: {
          'dual-model-supervisor': {
            enabled: true,
            config: {},
          },
        },
      },
    }, null, 2)}\n`,
    'utf8',
  );

  // A random file path avoids PID-reuse collisions. The module's own exit
  // finalizer is captured below so afterEach can close SQLite before deleting
  // the generated database and WAL sidecars. Restart/recovery tests pass an
  // explicit file path, which this harness never deletes.
  const configuredDbPath =
    typeof pluginConfig.dbPath === 'string' ? pluginConfig.dbPath : undefined;
  const generatedDbPath = configuredDbPath === undefined;
  const dbPath = configuredDbPath
    ?? path.join(os.tmpdir(), `rc-supervisor-test-${randomUUID()}.db`);

  const api = {
    id: 'dual-model-supervisor',
    name: 'Dual Model Supervisor',
    config: globalConfig,
    pluginConfig: { ...pluginConfig, dbPath },
    runtime: {
      config: {
        current: () => globalConfig ?? {},
        mutateConfigFile: async ({
          mutate,
        }: {
          afterWrite: { mode: 'auto' };
          mutate: (draft: Record<string, unknown>) => void;
        }) => {
          if (opts?.configMutationError) throw opts.configMutationError;
          const draft = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
          mutate(draft);
          const tmpPath = `${configPath}.tmp`;
          fs.writeFileSync(tmpPath, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
          fs.renameSync(tmpPath, configPath);
          return {
            path: configPath,
            persistedHash: null,
          };
        },
      },
      ...(opts?.runtimeLlmComplete
        ? { llm: { complete: opts.runtimeLlmComplete } }
        : {}),
    },
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
          context: {
            broadcast: (event: string, payload: unknown) => broadcasts.push({ event, payload }),
          },
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

  const exitListenersBefore = new Set(process.listeners('exit'));
  const mod = (await import('../../../index.js')) as {
    default: { register: (api: unknown) => void };
  };
  mod.default.register(api);
  const moduleExitListeners = process
    .listeners('exit')
    .filter((listener) => !exitListenersBefore.has(listener));
  pendingCleanup.push(() => {
    for (const listener of moduleExitListeners) {
      process.removeListener('exit', listener);
      listener(0);
    }
    if (generatedDbPath) {
      for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(`${dbPath}${suffix}`, { force: true });
      }
    }
    fs.rmSync(configRoot, { recursive: true, force: true });
  });

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
    broadcasts,
    databasePath: dbPath,
    configPath,
    ownsDatabasePath: generatedDbPath,
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
    hookHandlerCounts: () => Object.fromEntries([...hooks].map(([name, handlers]) => [name, handlers.length])),
    reregisterCurrentApi() {
      mod.default.register(api);
    },
    registerFreshApi() {
      const restartedHooks = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
      const restartedApi = {
        ...api,
        on: (hookName: string, handler: (event: unknown, ctx: unknown) => unknown) => {
          const list = restartedHooks.get(hookName) ?? [];
          list.push(handler);
          restartedHooks.set(hookName, list);
        },
      };
      mod.default.register(restartedApi);
      return [...restartedHooks.keys()];
    },
  };
}
