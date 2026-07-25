/**
 * C13 — the deep-review gate is a declared safety/latency trade-off, not a hidden constant.
 *
 * Since C12 the deterministic gate runs for the DEFAULT config, so every high-risk tool
 * call now waits on a real main-model round trip. That wait must be:
 *  - short enough for interactive use (default 4s, was 10s),
 *  - configurable end to end (manifest → RPC → persisted config → restart),
 *  - and it must not keep burning a connection/tokens after it has already failed open:
 *    the gate cancels the underlying request instead of letting it run to the 30s cap.
 *
 * Unchanged by design: the deterministic danger rules (quick check) block synchronously
 * and never start a reviewer call, so the gate cannot delay or weaken them.
 */

import { readFileSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPluginFresh } from './harness/plugin-harness.js';

/** No toolReviewGateMs → exercises the DEFAULT, which is what ships. */
const DEFAULT_GATE_CONFIG = {
  enabled: true,
  supervisorModel: 'testprov/testmodel',
  reviewMode: 'correct',
  providers: {
    testprov: { api: 'openai-completions', baseUrl: 'http://mock.local/v1/chat/completions', apiKey: 'k', models: [{ id: 'testmodel', maxTokens: 1000 }] },
  },
};

const CTX = { sessionKey: 'agent:main:c13' };
const origFetch = globalThis.fetch;
const origCwd = process.cwd();

/** Records the AbortSignal of every request and never resolves — the caller must give up. */
function installHangingFetch(): { calls: number; signals: AbortSignal[] } {
  const state = { calls: 0, signals: [] as AbortSignal[] };
  (globalThis as { fetch: unknown }).fetch = vi.fn(
    (_url: string, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        state.calls++;
        if (init?.signal) {
          state.signals.push(init.signal);
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }
      }),
  );
  return state;
}

afterEach(() => {
  vi.useRealTimers();
  (globalThis as { fetch: unknown }).fetch = origFetch;
  process.chdir(origCwd);
  vi.restoreAllMocks();
});

type AuditEntry = { type: string; action: string; details: string };
async function auditEntries(h: Awaited<ReturnType<typeof loadPluginFresh>>): Promise<AuditEntry[]> {
  const res = (await h.rpc.get('rc.supervisor.log')!({ limit: 200 })) as { entries: AuditEntry[] };
  return res.entries;
}

describe('C13 the default deep-review gate is 4 seconds', () => {
  it('a hanging reviewer fails OPEN at the 4s boundary — not before, not at 10s', async () => {
    const fetchState = installHangingFetch();
    const h = await loadPluginFresh(DEFAULT_GATE_CONFIG);

    vi.useFakeTimers();
    let settled = false;
    const hookP = h
      .fire('before_tool_call', { toolName: 'exec', params: { command: 'ls -la' } }, CTX)
      .then((r) => {
        settled = true;
        return r;
      });

    await vi.advanceTimersByTimeAsync(3_900);
    expect(settled).toBe(false); // still inside the gate — the deep review is given its full budget

    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBe(true); // crossed 4s → fail open
    expect(await hookP).toEqual({}); // tool allowed, never over-blocked
    expect(fetchState.calls).toBeGreaterThanOrEqual(1); // the deep review WAS attempted

    vi.useRealTimers();
    const degrades = (await auditEntries(h)).filter((e) => e.type === 'tool_review' && e.action === 'warn');
    expect(degrades.length).toBeGreaterThanOrEqual(1); // the degrade is recorded, never a silent pass
  });

  it('cancels the underlying reviewer request when the gate expires', async () => {
    const fetchState = installHangingFetch();
    const h = await loadPluginFresh(DEFAULT_GATE_CONFIG);

    vi.useFakeTimers();
    const hookP = h.fire('before_tool_call', { toolName: 'exec', params: { command: 'ls -la' } }, CTX);
    await vi.advanceTimersByTimeAsync(4_100);
    await hookP;

    // The tool already proceeded, so the answer has no control value left: letting the
    // request run to the 30s cap would burn a connection and main-model tokens for nothing.
    expect(fetchState.signals.length).toBeGreaterThanOrEqual(1);
    expect(fetchState.signals.every((s) => s.aborted)).toBe(true);
  });

  it('a deterministic danger (rm -rf /) is blocked instantly and starts no reviewer call', async () => {
    const fetchState = installHangingFetch();
    const h = await loadPluginFresh(DEFAULT_GATE_CONFIG);

    const started = Date.now();
    const r = (await h.fire('before_tool_call', { toolName: 'exec', params: { command: 'rm -rf /' } }, CTX)) as { block?: boolean };

    expect(r.block).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000); // synchronous — not gated on any model
    expect(fetchState.calls).toBe(0);
  });

  it('a non-high-risk tool waits for no reviewer at all', async () => {
    const fetchState = installHangingFetch();
    const h = await loadPluginFresh(DEFAULT_GATE_CONFIG);

    const started = Date.now();
    const r = await h.fire('before_tool_call', { toolName: 'read', params: { path: '/tmp/x' } }, CTX);

    expect(r).toEqual({});
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fetchState.calls).toBe(0);
  });
});

describe('C13 the gate is configurable end to end', () => {
  it('a value saved through the RPC is persisted to openclaw.json and survives a restart', async () => {
    // Real file round-trip: persistConfig writes `<cwd>/config/openclaw.json`.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-c13-'));
    fs.mkdirSync(path.join(tmp, 'config'));
    const cfgPath = path.join(tmp, 'config', 'openclaw.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ plugins: { entries: { 'dual-model-supervisor': { config: { enabled: true } } } } }, null, 2));
    process.chdir(tmp);

    const h = await loadPluginFresh(DEFAULT_GATE_CONFIG);
    await h.rpc.get('rc.supervisor.config')!({ toolReviewGateMs: 2000 });

    const persisted = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
      plugins: { entries: { 'dual-model-supervisor': { config: { toolReviewGateMs?: number } } } };
    };
    const savedCfg = persisted.plugins.entries['dual-model-supervisor'].config;
    expect(savedCfg.toolReviewGateMs).toBe(2000);

    // Restart: a fresh load of the persisted config must report the same value.
    const h2 = await loadPluginFresh({ ...DEFAULT_GATE_CONFIG, ...savedCfg });
    const st = (await h2.rpc.get('rc.supervisor.status')!({})) as { toolReviewGateMs?: number };
    expect(st.toolReviewGateMs).toBe(2000);
  });

  it('a custom 10s gate is honoured (the default is not hard-coded into the hook)', async () => {
    installHangingFetch();
    const h = await loadPluginFresh({ ...DEFAULT_GATE_CONFIG, toolReviewGateMs: 10_000 });

    vi.useFakeTimers();
    let settled = false;
    void h.fire('before_tool_call', { toolName: 'exec', params: { command: 'ls -la' } }, CTX).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(4_100);
    expect(settled).toBe(false); // the configured 10s wins over the 4s default

    await vi.advanceTimersByTimeAsync(6_000);
    expect(settled).toBe(true);
  });

  it('the manifest declares the gate with its range, so it is not a hidden constant', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../openclaw.plugin.json', import.meta.url), 'utf-8')) as {
      configSchema: { properties: Record<string, { type?: string; default?: number; minimum?: number; maximum?: number; description?: string }> };
    };
    const gate = manifest.configSchema.properties.toolReviewGateMs;

    expect(gate).toBeDefined();
    expect(gate.type).toBe('number');
    expect(gate.default).toBe(4000);
    expect(gate.minimum).toBe(500);
    expect(gate.maximum).toBe(30000);
    // The description must state what happens on timeout — fail-open is a safety-relevant
    // property the operator is choosing when they change this number.
    expect(gate.description).toMatch(/timeout|time out/i);
  });
});
