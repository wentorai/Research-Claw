#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const CORE_PROBES = Object.freeze([
  ['rc.lit.list', { limit: 1 }],
  ['rc.ws.tree', { depth: 1 }],
  ['rc.task.list', { limit: 1 }],
  ['rc.monitor.list', { limit: 1 }],
  ['rc.review.candidates', { root: 'sources' }],
  ['rc.periph.devices.list', {}, undefined, 'peripherals'],
  ['rc.job.list', { limit: 1 }],
  ['rc.supervisor.reviews.list', { limit: 1 }, 'dual-model-supervisor'],
]);

export function planReadinessProbes(config = {}) {
  const peripheralsPolicy = config?.plugins?.entries?.['research-claw-core']
    ?.config?.productPolicy?.capabilities?.peripherals;
  return CORE_PROBES.map(([method, params, plugin, capability]) => {
    if (capability === 'peripherals' && peripheralsPolicy === 'disabled') {
      return {
        method,
        params,
        plugin,
        expectation: 'unavailable',
        reason: 'peripherals policy is disabled',
      };
    }
    return { method, params, plugin, expectation: 'available' };
  });
}

export function isExpectedUnavailableError(message) {
  return /unknown method|method not found|invalid_request|feature unavailable/i.test(message);
}

export function extractJson(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Gateway returned no JSON object');
  return JSON.parse(raw.slice(start, end + 1));
}

export function evaluateGatewayHealth(health, requiredPluginIds = ['research-claw-core']) {
  if (!health?.ok) return { ok: false, reason: 'OpenClaw health response is not ok' };
  const coreError = health?.plugins?.errors?.find?.((entry) => requiredPluginIds.includes(entry?.id));
  if (coreError) {
    return {
      ok: false,
      reason: `${coreError.id} ${coreError.failurePhase || 'activation'} failed: ${coreError.error || 'unknown error'}`,
    };
  }
  return { ok: true };
}

function flag(args, name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

export async function runReadiness(options) {
  const { root, configPath, port, token, timeout } = options;
  const entry = path.join(root, 'node_modules', 'openclaw', 'dist', 'entry.js');
  const report = { ok: false, port, core: null, probes: [] };
  let socket;
  let config = {};
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
  const pluginEnabled = (id) => config?.plugins?.entries?.[id]?.enabled === true;
  const requiredPluginIds = [
    'research-claw-core',
    ...CORE_PROBES.flatMap(([, , plugin]) => plugin && pluginEnabled(plugin) ? [plugin] : []),
  ];
  try {
    const requireFromOpenClaw = createRequire(fs.realpathSync(entry));
    const WebSocket = requireFromOpenClaw('ws');
    socket = await openReadinessSocket({ WebSocket, port, token, timeout });
    const health = await socket.call('health');
    report.core = evaluateGatewayHealth(health, requiredPluginIds);
    if (!report.core.ok) {
      socket.close();
      return report;
    }
  } catch (error) {
    socket?.close();
    report.core = { ok: false, reason: error instanceof Error ? error.message : String(error) };
    return report;
  }

  for (const probe of planReadinessProbes(config)) {
    const { method, params, plugin, expectation } = probe;
    if (plugin && !pluginEnabled(plugin)) {
      report.probes.push({ method, ok: true, skipped: true, reason: `${plugin} is disabled` });
      continue;
    }
    try {
      await socket.call(method, params);
      if (expectation === 'unavailable') {
        report.probes.push({
          method,
          ok: false,
          reason: `${probe.reason}, but the RPC is still registered`,
        });
      } else {
        report.probes.push({ method, ok: true });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (expectation === 'unavailable' && isExpectedUnavailableError(message)) {
        report.probes.push({
          method,
          ok: true,
          expectedUnavailable: true,
          reason: probe.reason,
        });
      } else {
        report.probes.push({ method, ok: false, reason: message });
      }
    }
  }
  report.ok = report.core.ok && report.probes.every((probe) => probe.ok);
  socket.close();
  return report;
}

async function openReadinessSocket({ WebSocket, port, token, timeout }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const queued = [];
  const waiters = [];
  let sequence = 0;

  const dispatch = (frame) => {
    const index = waiters.findIndex((waiter) => waiter.predicate(frame));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    } else queued.push(frame);
  };
  ws.on('message', (data) => {
    try { dispatch(JSON.parse(data.toString('utf8'))); } catch {}
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Gateway WebSocket open timed out')), timeout);
    ws.once('open', () => { clearTimeout(timer); resolve(); });
    ws.once('error', (error) => { clearTimeout(timer); reject(error); });
  });

  const waitFor = (predicate) => {
    const queuedIndex = queued.findIndex(predicate);
    if (queuedIndex >= 0) return Promise.resolve(queued.splice(queuedIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('Gateway response timed out'));
        }, timeout),
      };
      waiters.push(waiter);
    });
  };
  await waitFor((frame) => frame.type === 'event' && frame.event === 'connect.challenge');

  const request = async (method, params = {}) => {
    const id = `readiness-${++sequence}`;
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
    const response = await waitFor((frame) => frame.type === 'res' && frame.id === id);
    if (!response.ok) {
      throw new Error(`${method}: ${response.error?.message || JSON.stringify(response.error)}`);
    }
    return response.payload;
  };
  await request('connect', {
    minProtocol: 4,
    maxProtocol: 4,
    client: {
      id: 'gateway-client',
      version: 'research-claw-readiness',
      platform: 'node',
      mode: 'backend',
      displayName: 'Research-Claw readiness',
    },
    caps: [],
    role: 'operator',
    // Plugin RPCs are currently classified by OpenClaw as custom admin
    // methods even when the individual probe is read-only.
    scopes: ['operator.admin'],
    auth: token ? { token } : {},
  });

  return {
    call: request,
    close: () => ws.close(1000, 'readiness complete'),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const root = path.resolve(flag(args, '--root', path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')));
  const configPath = path.resolve(flag(args, '--config', path.join(root, 'config', 'openclaw.json')));
  const port = Number(flag(args, '--port', '28789'));
  const timeout = Number(flag(args, '--timeout', '5000'));
  let token = flag(args, '--token', '');
  if (!token) {
    try { token = JSON.parse(fs.readFileSync(configPath, 'utf8'))?.gateway?.auth?.token || ''; } catch {}
  }
  const report = await runReadiness({ root, configPath, port, token, timeout });
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(report)}\n`);
  else if (report.ok) process.stdout.write(`[ready] Research-Claw Core and ${report.probes.length} capability probes are healthy\n`);
  else {
    process.stderr.write(`[not-ready] ${report.core?.reason || 'one or more Core RPC probes failed'}\n`);
    for (const probe of report.probes.filter((item) => !item.ok)) {
      process.stderr.write(`[not-ready] ${probe.method}: ${probe.reason}\n`);
    }
  }
  process.exit(report.ok ? 0 : 1);
}
