#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const CORE_PROBES = Object.freeze([
  ['rc.lit.list', { limit: 1 }],
  ['rc.ws.tree', { depth: 1 }],
  ['rc.task.list', { limit: 1 }],
  ['rc.monitor.list', { limit: 1 }],
  ['rc.review.candidates', { root: 'sources' }],
  ['rc.periph.devices.list', {}],
  ['rc.job.list', { limit: 1 }],
  ['rc.supervisor.reviews.list', { limit: 1 }],
]);

export function extractJson(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Gateway returned no JSON object');
  return JSON.parse(raw.slice(start, end + 1));
}

export function evaluateGatewayHealth(health) {
  if (!health?.ok) return { ok: false, reason: 'OpenClaw health response is not ok' };
  const coreError = health?.plugins?.errors?.find?.((entry) => entry?.id === 'research-claw-core');
  if (coreError) {
    return {
      ok: false,
      reason: `research-claw-core ${coreError.failurePhase || 'activation'} failed: ${coreError.error || 'unknown error'}`,
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
  const call = (method, params = {}) => {
    const raw = execFileSync(process.execPath, [
      entry, 'gateway', 'call', method,
      '--url', `ws://127.0.0.1:${port}`,
      '--token', token,
      '--params', JSON.stringify(params),
      '--timeout', String(timeout),
      '--json',
    ], {
      cwd: root,
      env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return extractJson(raw);
  };

  const report = { ok: false, port, core: null, probes: [] };
  try {
    const health = call('health');
    report.core = evaluateGatewayHealth(health);
    if (!report.core.ok) return report;
  } catch (error) {
    report.core = { ok: false, reason: error instanceof Error ? error.message : String(error) };
    return report;
  }

  for (const [method, params] of CORE_PROBES) {
    try {
      call(method, params);
      report.probes.push({ method, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.probes.push({ method, ok: false, reason: message });
    }
  }
  report.ok = report.core.ok && report.probes.every((probe) => probe.ok);
  return report;
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
