import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  CORE_PROBES,
  evaluateGatewayHealth,
  extractJson,
  planReadinessProbes,
} from '../scripts/runtime-readiness.mjs';

const ROOT = path.resolve(__dirname, '..');

describe('Research-Claw runtime readiness', () => {
  it('rejects a live OpenClaw process whose Core register phase failed', () => {
    const result = evaluateGatewayHealth({
      ok: true,
      plugins: { errors: [{ id: 'research-claw-core', failurePhase: 'register', error: 'ABI mismatch' }] },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('register failed');
    expect(result.reason).toContain('ABI mismatch');
  });

  it('accepts health only when Core has no runtime activation error', () => {
    expect(evaluateGatewayHealth({ ok: true, plugins: { errors: [] } })).toEqual({ ok: true });
    expect(evaluateGatewayHealth({ ok: false })).toEqual({
      ok: false,
      reason: 'OpenClaw health response is not ok',
    });
  });

  it('also rejects an enabled optional service that failed registration', () => {
    const health = {
      ok: true,
      plugins: { errors: [{ id: 'dual-model-supervisor', error: 'register failed' }] },
    };
    expect(evaluateGatewayHealth(health).ok).toBe(true);
    expect(evaluateGatewayHealth(health, [
      'research-claw-core', 'dual-model-supervisor',
    ]).ok).toBe(false);
  });

  it('probes every product surface affected by the incident using read-only methods', () => {
    expect(CORE_PROBES.map(([method]) => method)).toEqual(expect.arrayContaining([
      'rc.lit.list', 'rc.ws.tree', 'rc.task.list', 'rc.monitor.list',
      'rc.review.candidates', 'rc.periph.devices.list', 'rc.job.list',
      'rc.supervisor.reviews.list',
    ]));
  });

  it('treats a disabled peripheral RPC as required-absent instead of a readiness failure', () => {
    const probes = planReadinessProbes({
      plugins: {
        entries: {
          'research-claw-core': {
            enabled: true,
            config: {
              productPolicy: {
                capabilities: { peripherals: 'disabled' },
              },
            },
          },
        },
      },
    });
    expect(probes.find((probe) => probe.method === 'rc.periph.devices.list')).toMatchObject({
      expectation: 'unavailable',
      reason: 'peripherals policy is disabled',
    });
    expect(probes.find((probe) => probe.method === 'rc.monitor.list')).toMatchObject({
      expectation: 'available',
    });
  });

  it('keeps enabled-hidden peripherals live because that policy hides only Dashboard UI', () => {
    const probes = planReadinessProbes({
      plugins: {
        entries: {
          'research-claw-core': {
            enabled: true,
            config: {
              productPolicy: {
                capabilities: { peripherals: 'enabled-hidden' },
              },
            },
          },
        },
      },
    });
    expect(probes.find((probe) => probe.method === 'rc.periph.devices.list')).toMatchObject({
      expectation: 'available',
    });
  });

  it('parses JSON from CLI output and replaces healthz-only installer readiness', () => {
    expect(extractJson('notice\n{"ok":true}\n')).toEqual({ ok: true });
    const installer = fs.readFileSync(path.join(ROOT, 'scripts', 'install.sh'), 'utf8');
    const health = fs.readFileSync(path.join(ROOT, 'scripts', 'health.sh'), 'utf8');
    expect(installer).toContain('runtime-readiness.mjs');
    expect(health).toContain('runtime-readiness.mjs');
  });
});
