/**
 * P1-D — human-in-the-loop approval audit lifecycle.
 *
 * Under dangerousToolPolicy:'block' a confirmed-dangerous tool is hard-blocked
 * (unchanged default). Under 'approve', before_tool_call returns OC's
 * `requireApproval` and the audit trail must be a correct state machine:
 *   requested  →  allowed | denied | timeout | cancelled   (exactly one terminal)
 * Before the user resolves, the audit must NOT contain a block/denied (the tool
 * is pending, not decided). Duplicate resolutions collapse to a single terminal.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPluginFresh, type Harness } from './harness/plugin-harness.js';

const BASE = {
  enabled: true,
  supervisorModel: 'testprov/testmodel',
  reviewMode: 'correct',
  highRiskTools: ['exec'],
  providers: {
    testprov: { api: 'openai-completions', baseUrl: 'http://mock.local/x', apiKey: 'k', models: [{ id: 'testmodel' }] },
  },
};

interface LogEntry { type: string; action: string; details: string; metadata?: string }
interface ApprovalReq {
  title: string;
  description: string;
  allowedDecisions?: string[];
  onResolution?: (d: string) => void | Promise<void>;
}
interface ToolResult { block?: boolean; blockReason?: string; requireApproval?: ApprovalReq }

const dangerCtx = (sk: string) => ({ sessionKey: `agent:main:${sk}`, sessionId: sk, toolName: 'exec' });
const dangerEvent = () => ({ toolName: 'exec', params: { command: 'rm -rf /' } });

async function approvalLog(h: Harness): Promise<LogEntry[]> {
  const r = (await h.rpc.get('rc.supervisor.log')!({ type: 'approval', limit: 50 })) as { entries: LogEntry[] };
  return r.entries;
}
const isTerminal = (e: LogEntry) => /allowed|denied|timeout|cancelled/i.test(e.details);

describe('P1-D approval lifecycle', () => {
  it("block policy: determined danger hard-blocks (block audit, no requireApproval)", async () => {
    const h = await loadPluginFresh({ ...BASE, dangerousToolPolicy: 'block' });
    const r = (await h.fire('before_tool_call', dangerEvent(), dangerCtx('skA'))) as ToolResult;
    expect(r.block).toBe(true);
    expect(r.requireApproval).toBeUndefined();
  });

  it('approve policy: returns requireApproval and writes ONLY a requested audit (no block/denied pre-resolution)', async () => {
    const h = await loadPluginFresh({ ...BASE, dangerousToolPolicy: 'approve' });
    const r = (await h.fire('before_tool_call', dangerEvent(), dangerCtx('skA'))) as ToolResult;
    expect(r.block ?? false).toBe(false);
    expect(r.requireApproval).toBeDefined();
    expect(r.requireApproval!.allowedDecisions).toContain('deny');
    expect(typeof r.requireApproval!.onResolution).toBe('function');

    const log = await approvalLog(h);
    expect(log.some((e) => /requested/i.test(e.details))).toBe(true);
    expect(log.every((e) => e.action !== 'block')).toBe(true); // never block before resolution
    expect(log.some(isTerminal)).toBe(false); // no terminal yet
  });

  it('approve: allow-once → allowed terminal (not a block)', async () => {
    const h = await loadPluginFresh({ ...BASE, dangerousToolPolicy: 'approve' });
    const r = (await h.fire('before_tool_call', dangerEvent(), dangerCtx('skA'))) as ToolResult;
    await r.requireApproval!.onResolution!('allow-once');
    const log = await approvalLog(h);
    expect(log.some((e) => /allowed/i.test(e.details) && e.action !== 'block')).toBe(true);
  });

  it('approve: deny → denied terminal (action block)', async () => {
    const h = await loadPluginFresh({ ...BASE, dangerousToolPolicy: 'approve' });
    const r = (await h.fire('before_tool_call', dangerEvent(), dangerCtx('skB'))) as ToolResult;
    await r.requireApproval!.onResolution!('deny');
    const log = await approvalLog(h);
    expect(log.some((e) => /denied/i.test(e.details) && e.action === 'block')).toBe(true);
  });

  it('approve: timeout → timeout terminal', async () => {
    const h = await loadPluginFresh({ ...BASE, dangerousToolPolicy: 'approve' });
    const r = (await h.fire('before_tool_call', dangerEvent(), dangerCtx('skC'))) as ToolResult;
    await r.requireApproval!.onResolution!('timeout');
    const log = await approvalLog(h);
    expect(log.some((e) => /timeout/i.test(e.details))).toBe(true);
  });

  it('approve: duplicate resolution collapses to exactly ONE terminal', async () => {
    const h = await loadPluginFresh({ ...BASE, dangerousToolPolicy: 'approve' });
    const r = (await h.fire('before_tool_call', dangerEvent(), dangerCtx('skD'))) as ToolResult;
    await r.requireApproval!.onResolution!('deny');
    await r.requireApproval!.onResolution!('deny'); // duplicate
    await r.requireApproval!.onResolution!('allow-once'); // conflicting late resolution
    const log = await approvalLog(h);
    expect(log.filter(isTerminal).length).toBe(1);
  });

  /**
   * Idempotency must not depend on how many OTHER approvals happened in between.
   *
   * The implementation this replaced tracked resolved ids in a global Set bounded at
   * 1000 entries, evicting the oldest past the cap. Once approval-1's id was evicted,
   * re-resolving it wrote a SECOND, conflicting terminal (allowed, then denied). To
   * actually reach that eviction the probe must cross the cap — a handful of
   * in-between approvals passes on the broken implementation too and proves nothing.
   * The per-callback one-shot latch has no cap, so the count is irrelevant to it.
   */
  const EVICTION_PROBE_COUNT = 1_001; // > the 1000-entry cap of the bounded-Set implementation

  it('re-resolving an approval after 1001 other approvals stays idempotent (crosses any bounded-set cap)', async () => {
    const h = await loadPluginFresh({ ...BASE, dangerousToolPolicy: 'approve' });
    const first = (await h.fire('before_tool_call', dangerEvent(), dangerCtx('sk1'))) as ToolResult;
    await first.requireApproval!.onResolution!('allow-once'); // approval-1 → allowed terminal

    for (let i = 0; i < EVICTION_PROBE_COUNT; i++) {
      const r = (await h.fire('before_tool_call', dangerEvent(), dangerCtx(`skN${i}`))) as ToolResult;
      await r.requireApproval!.onResolution!('deny');
    }

    // Re-resolve the FIRST approval with a CONFLICTING decision — must be ignored.
    await first.requireApproval!.onResolution!('deny');

    // Scope the query to approval-1's own session: with 1000+ approvals recorded, a
    // global tail query would never reach back to it.
    const r = (await h.rpc.get('rc.supervisor.log')!({ type: 'approval', sessionId: 'agent:main:sk1', limit: 50 })) as { entries: LogEntry[] };
    const firstTerminals = r.entries.filter((e) => isTerminal(e) && /"approvalId":"approval-1"/.test(e.metadata ?? ''));
    expect(firstTerminals.length).toBe(1); // exactly one terminal for approval-1
    expect(/allowed/i.test(firstTerminals[0].details)).toBe(true); // the ORIGINAL, not the late deny
  }, 60_000);
});

// Deep-review danger (tool passes quick-check but the reviewer flags blocked:true).
describe('P1-D approval lifecycle — deep-review danger', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { (globalThis as { fetch: unknown }).fetch = origFetch; vi.restoreAllMocks(); });

  it('keeps the native plugin approval descriptor within the OpenClaw title and description limits', async () => {
    const longTool = `tool-${'工具'.repeat(80)}`;
    (globalThis as { fetch: unknown }).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ blocked: true, blockReason: 'X'.repeat(400) }) } }],
      }),
      text: async () => '',
    }));
    const h = await loadPluginFresh({
      ...BASE,
      dangerousToolPolicy: 'approve',
      highRiskTools: [longTool],
    });
    const r = (await h.fire(
      'before_tool_call',
      { toolName: longTool, params: {} },
      { sessionKey: 'agent:main:length', toolName: longTool },
    )) as ToolResult;

    expect(r.requireApproval).toBeDefined();
    expect(r.requireApproval!.title.length).toBeLessThanOrEqual(80);
    expect(r.requireApproval!.description.length).toBeLessThanOrEqual(256);
  });

  it('approve: reviewer-flagged block → requireApproval + requested (no block pre-resolution)', async () => {
    (globalThis as { fetch: unknown }).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"blocked":true,"blockReason":"exfiltration risk"}' } }] }),
      text: async () => '',
    }));
    const h = await loadPluginFresh({ ...BASE, dangerousToolPolicy: 'approve' });
    // benign command passes the quick check → reaches the deep reviewer
    const r = (await h.fire('before_tool_call', { toolName: 'exec', params: { command: 'ls -la' } }, dangerCtx('skE'))) as ToolResult;
    expect(r.block ?? false).toBe(false);
    expect(r.requireApproval).toBeDefined();
    const log = await approvalLog(h);
    expect(log.some((e) => /requested/i.test(e.details))).toBe(true);
    expect(log.every((e) => e.action !== 'block')).toBe(true);
    await r.requireApproval!.onResolution!('deny');
    const after = await approvalLog(h);
    expect(after.some((e) => /denied/i.test(e.details) && e.action === 'block')).toBe(true);
  });
});
