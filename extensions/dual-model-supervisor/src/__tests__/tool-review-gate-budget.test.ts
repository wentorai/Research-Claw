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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeToolReviewGateOverride, parseConfig } from '../core/config.js';
import { DEFAULT_CONFIG, TOOL_REVIEW_GATE_MAX_MS, TOOL_REVIEW_GATE_MIN_MS } from '../core/types.js';
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
    const h = await loadPluginFresh(DEFAULT_GATE_CONFIG);
    await h.rpc.get('rc.supervisor.config')!({ toolReviewGateMs: 2000 });

    const persisted = JSON.parse(readFileSync(h.configPath, 'utf8')) as {
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

/**
 * C13 reopened — the manifest's range binds openclaw.json, but not the plugin's own writes.
 *
 * OpenClaw validates `plugins.entries[*].config` against the manifest's configSchema in two
 * independent places (config load throws; the plugin loader refuses to load), so a
 * hand-edited openclaw.json with an out-of-range gate never reaches this parser — the
 * gateway just refuses to start. `rc.supervisor.config` is subject to neither: it filters
 * params through an allowlist, hands them to `parseConfig`, makes the result live via
 * `setActiveConfig`, and writes it out with `persistConfig`'s bare `fs.writeFileSync`.
 *
 * While the parser only checked `> 0`, one RPC call with `toolReviewGateMs: 999999999`
 * therefore did two things: the running gate became ~11.6 days (that value is under
 * setTimeout's 2^31-1 ceiling, so it is not coerced down — every high-risk tool call would
 * really have waited), and the config file left on disk was one the next gateway start
 * would reject. Clamping in `parseConfig` is what closes both, because both go through it.
 */
describe('C13 the declared range is enforced by the production parser', () => {
  it('exposes the bounds it enforces as the same numbers the manifest declares', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../openclaw.plugin.json', import.meta.url), 'utf-8')) as {
      configSchema: { properties: { toolReviewGateMs: { minimum: number; maximum: number; default: number } } };
    };
    const gate = manifest.configSchema.properties.toolReviewGateMs;

    // Without this the parser could enforce some other range and the manifest would
    // still "declare" 500–30000 — the exact split the reviewer caught.
    expect(TOOL_REVIEW_GATE_MIN_MS).toBe(gate.minimum);
    expect(TOOL_REVIEW_GATE_MAX_MS).toBe(gate.maximum);
    expect(DEFAULT_CONFIG.toolReviewGateMs).toBe(gate.default);
    expect(TOOL_REVIEW_GATE_MIN_MS).toBeLessThan(DEFAULT_CONFIG.toolReviewGateMs);
    expect(DEFAULT_CONFIG.toolReviewGateMs).toBeLessThan(TOOL_REVIEW_GATE_MAX_MS);
  });

  it('clamps a finite out-of-range gate to the nearest bound instead of honouring it', () => {
    // Below the floor: a caller asking for "as short as possible" gets the floor, not
    // the 4s default — clamping preserves the intent, it does not reinterpret it.
    expect(parseConfig({ toolReviewGateMs: 1 }).toolReviewGateMs).toBe(500);
    expect(parseConfig({ toolReviewGateMs: 0 }).toolReviewGateMs).toBe(500);
    expect(parseConfig({ toolReviewGateMs: -5000 }).toolReviewGateMs).toBe(500);
    expect(parseConfig({ toolReviewGateMs: 499.6 }).toolReviewGateMs).toBe(500);

    // Above the ceiling: the reviewer's measured 999999999 (~11.6 days) is the case
    // that reopened C13.
    expect(parseConfig({ toolReviewGateMs: 999999999 }).toolReviewGateMs).toBe(30000);
    expect(parseConfig({ toolReviewGateMs: 30001 }).toolReviewGateMs).toBe(30000);
    expect(parseConfig({ toolReviewGateMs: Number.MAX_SAFE_INTEGER }).toolReviewGateMs).toBe(30000);

    // In range: untouched apart from rounding to whole milliseconds.
    expect(parseConfig({ toolReviewGateMs: 500 }).toolReviewGateMs).toBe(500);
    expect(parseConfig({ toolReviewGateMs: 2000 }).toolReviewGateMs).toBe(2000);
    expect(parseConfig({ toolReviewGateMs: 30000 }).toolReviewGateMs).toBe(30000);
    expect(parseConfig({ toolReviewGateMs: 7500.4 }).toolReviewGateMs).toBe(7500);
  });

  it('falls back to the default for values that are not usable numbers', () => {
    // Math.max(500, NaN) is NaN and Math.min(30000, Infinity) is 30000 — a clamp written
    // without an explicit finite check leaks NaN into setTimeout, where Node coerces it to
    // 1ms and the gate silently becomes ~0. NaN and Infinity are unreachable from JSON, so
    // this half is defensive; the string/null/object cases below are not, since the RPC
    // hands through whatever a client sends under an allowlisted key.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(parseConfig({ toolReviewGateMs: bad }).toolReviewGateMs).toBe(DEFAULT_CONFIG.toolReviewGateMs);
    }
    for (const bad of ['abc', '2000', null, {}, [], true]) {
      expect(parseConfig({ toolReviewGateMs: bad }).toolReviewGateMs).toBe(DEFAULT_CONFIG.toolReviewGateMs);
    }
    expect(parseConfig({}).toolReviewGateMs).toBe(DEFAULT_CONFIG.toolReviewGateMs);
  });

  it('persists the clamped gate, so the file it leaves behind is one OpenClaw still accepts', async () => {
    const h = await loadPluginFresh(DEFAULT_GATE_CONFIG);
    const res = (await h.rpc.get('rc.supervisor.config')!({ toolReviewGateMs: 999999999 })) as {
      config: { toolReviewGateMs: number };
    };

    // The caller is told the truth about what was stored, not echoed its own request.
    expect(res.config.toolReviewGateMs).toBe(30000);

    const persisted = JSON.parse(readFileSync(h.configPath, 'utf8')) as {
      plugins: { entries: { 'dual-model-supervisor': { config: { toolReviewGateMs?: number } } } };
    };
    expect(persisted.plugins.entries['dual-model-supervisor'].config.toolReviewGateMs).toBe(30000);

    const st = (await h.rpc.get('rc.supervisor.status')!({})) as { toolReviewGateMs?: number };
    expect(st.toolReviewGateMs).toBe(30000);
  });

  it('clamps a gate written below the floor through the RPC as well', async () => {
    const h = await loadPluginFresh(DEFAULT_GATE_CONFIG);
    const res = (await h.rpc.get('rc.supervisor.config')!({ toolReviewGateMs: 1 })) as {
      config: { toolReviewGateMs: number };
    };
    expect(res.config.toolReviewGateMs).toBe(500);
  });

  it('warns on the RPC write path that it overrode the operator, naming the value in force', async () => {
    // Clamping quietly would trade one silent lie for another: the operator wrote a
    // number, something else is in force, and only a log makes that visible before
    // they next open the Dashboard.
    //
    // The assertions match `using <n>ms instead` rather than just containing the number.
    // The message template already carries "500–30000ms range", so `toContain('30000')`
    // passed even with the clamp entirely disabled — measured, not hypothetical.
    const h = await loadPluginFresh(DEFAULT_GATE_CONFIG);
    expect(h.logs.warn.filter((m) => /toolReviewGateMs/.test(m))).toHaveLength(0); // in-range start: silent

    await h.rpc.get('rc.supervisor.config')!({ toolReviewGateMs: 999999999 });
    let warns = h.logs.warn.filter((m) => /toolReviewGateMs/.test(m));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('999999999'); // what was asked for
    expect(warns[0]).toMatch(/using 30000ms instead/); // what is actually in force

    await h.rpc.get('rc.supervisor.config')!({ toolReviewGateMs: 1 });
    warns = h.logs.warn.filter((m) => /toolReviewGateMs/.test(m));
    expect(warns).toHaveLength(2);
    expect(warns[1]).toMatch(/using 500ms instead/);
  });

  it('warns at the exact boundary the clamp uses, not half a millisecond away', () => {
    // Deciding whether to warn by comparing the request to the *rounded* result silently
    // exempts everything that rounds onto a bound: 499.6 was clamped and said nothing.
    expect(describeToolReviewGateOverride({ toolReviewGateMs: 499.6 })).toMatch(/using 500ms instead/);
    expect(describeToolReviewGateOverride({ toolReviewGateMs: 30000.4 })).toMatch(/using 30000ms instead/);
    expect(describeToolReviewGateOverride({ toolReviewGateMs: 500 })).toBeNull();
    expect(describeToolReviewGateOverride({ toolReviewGateMs: 30000 })).toBeNull();
  });

  it('says the value was the wrong type when it was, instead of blaming the range', () => {
    // "2000" is in range; the problem is that it is a string. Reporting it as a range
    // violation sends whoever reads the log looking for a bound that is not the issue.
    // NaN and Infinity have to be rendered by hand — JSON.stringify prints both as `null`,
    // while other wrong types are identified without reflecting their payload into logs.
    for (const [bad, shown] of [['2000', 'a string'], [null, 'null'], [true, 'a boolean'], [Number.NaN, 'NaN'], [Number.POSITIVE_INFINITY, 'Infinity']] as const) {
      const msg = describeToolReviewGateOverride({ toolReviewGateMs: bad });
      expect(msg).toMatch(/must be a finite number/);
      expect(msg).not.toMatch(/outside the supported/);
      expect(msg).toContain(shown);
      expect(msg).toMatch(new RegExp(`using ${DEFAULT_CONFIG.toolReviewGateMs}ms instead`));
    }
  });

  it('does not echo an arbitrary wrong-type payload into logs', () => {
    const secret = 'SENSITIVE_PAYLOAD_DO_NOT_LOG';
    for (const bad of [
      `${secret}\nforged log line`,
      { apiKey: secret },
      [secret],
    ]) {
      const msg = describeToolReviewGateOverride({ toolReviewGateMs: bad });
      expect(msg).toMatch(/must be a finite number/);
      expect(msg).not.toContain(secret);
    }
  });

  it('surfaces a sanitized wrong-type warning through the production RPC path', async () => {
    const secret = 'SENSITIVE_RPC_PAYLOAD_DO_NOT_LOG';
    const h = await loadPluginFresh(DEFAULT_GATE_CONFIG);
    const result = (await h.rpc.get('rc.supervisor.config')!({
      toolReviewGateMs: { apiKey: secret, injected: `line one\nFORGED WARN` },
    })) as { config: { toolReviewGateMs: number } };

    const warns = h.logs.warn.filter((message) => /toolReviewGateMs/.test(message));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('got an object');
    expect(warns[0]).toMatch(new RegExp(`using ${DEFAULT_CONFIG.toolReviewGateMs}ms instead`));
    expect(warns[0]).not.toContain(secret);
    expect(warns[0]).not.toMatch(/[\r\n]/);
    expect(result.config.toolReviewGateMs).toBe(DEFAULT_CONFIG.toolReviewGateMs);
  });

  it('does not warn when the value is in range or simply absent', async () => {
    // A warning that fires for legitimate settings gets filtered out and stops working.
    for (const cfg of [DEFAULT_GATE_CONFIG, { ...DEFAULT_GATE_CONFIG, toolReviewGateMs: 2000 }]) {
      const h = await loadPluginFresh(cfg);
      expect(h.logs.warn.filter((m) => /toolReviewGateMs/.test(m))).toEqual([]);
    }
    expect(describeToolReviewGateOverride({})).toBeNull();
    expect(describeToolReviewGateOverride(undefined)).toBeNull();
  });

  it('does not warn from the startup path, where OpenClaw has already rejected bad values', async () => {
    // OpenClaw validates plugins.entries[*].config against the manifest before the plugin
    // loads, so api.pluginConfig cannot carry an out-of-range gate. A warning there could
    // only ever be dead code, and this pins that it stays absent. The harness bypasses
    // OpenClaw, which is exactly why the value below still gets clamped without a warning.
    const h = await loadPluginFresh({ ...DEFAULT_GATE_CONFIG, toolReviewGateMs: 999999999 });
    expect(h.logs.warn.filter((m) => /toolReviewGateMs/.test(m))).toEqual([]);
    const st = (await h.rpc.get('rc.supervisor.status')!({})) as { toolReviewGateMs?: number };
    expect(st.toolReviewGateMs).toBe(30000);
  });

  it('actually fails the tool call open at the ceiling, not at the raw value it was given', async () => {
    // The parse-level assertions above would still pass if the hook read the raw config
    // instead of the parsed one. This is the behavioural proof that the gate is bounded.
    installHangingFetch();
    const h = await loadPluginFresh({ ...DEFAULT_GATE_CONFIG, toolReviewGateMs: 999999999 });

    vi.useFakeTimers();
    let settled = false;
    void h.fire('before_tool_call', { toolName: 'exec', params: { command: 'ls -la' } }, CTX).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(29_900);
    expect(settled).toBe(false); // clamped to the ceiling, not to the 4s default

    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBe(true); // and it does expire — 999999999ms would be ~11.6 days
  });
});
