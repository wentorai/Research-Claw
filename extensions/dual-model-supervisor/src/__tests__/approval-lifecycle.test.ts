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

interface LogEntry { type: string; action: string; details: string }
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
});

// Deep-review danger (tool passes quick-check but the reviewer flags blocked:true).
describe('P1-D approval lifecycle — deep-review danger', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { (globalThis as { fetch: unknown }).fetch = origFetch; vi.restoreAllMocks(); });

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
