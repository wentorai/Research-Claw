import { describe, it, expect } from 'vitest';
import { auditPluginActivation, type ProbeInput } from '../self-check/activation-probe.js';

const healthy: ProbeInput = {
  id: 'research-claw-core',
  dir: '/x/extensions/research-claw-core',
  manifest: { id: 'research-claw-core', main: 'dist/index.js', activation: { onStartup: true }, contracts: { tools: ['a', 'b'] } },
};

describe('auditPluginActivation', () => {
  it('passes a fully-wired plugin (main + onStartup + tools)', () => {
    expect(auditPluginActivation([healthy])).toEqual([]);
  });

  it('flags the v1.4.7 failure: advertises tools but no activation.onStartup', () => {
    const rp: ProbeInput = {
      id: 'research-plugins',
      dir: '/x/extensions/research-plugins',
      // 34 tools advertised, but activation missing (exact v1.4.7 shape).
      manifest: { id: 'research-plugins', main: 'dist/index.js', contracts: { tools: Array(34).fill('t') } },
    };
    const f = auditPluginActivation([rp]);
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('missing-activation');
    expect(f[0].message).toContain('34 tool');
    expect(f[0].message).toContain('research-plugins');
  });

  it('flags onStartup:true but missing main', () => {
    const p: ProbeInput = {
      id: 'x',
      dir: '/x',
      manifest: { activation: { onStartup: true }, contracts: { tools: ['a'] } },
    };
    const f = auditPluginActivation([p]);
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('missing-main');
  });

  it('does NOT flag a tool-less plugin that omits activation (legitimately discovery-only)', () => {
    const channelOnly: ProbeInput = {
      id: 'openclaw-weixin',
      dir: '/x/extensions/openclaw-weixin',
      manifest: { id: 'openclaw-weixin', main: 'dist/index.js', contracts: { tools: [] } },
    };
    expect(auditPluginActivation([channelOnly])).toEqual([]);
  });

  it('flags an unreadable/missing manifest', () => {
    const broken: ProbeInput = { id: 'ghost', dir: '/x/extensions/ghost', manifest: null };
    const f = auditPluginActivation([broken]);
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('unreadable-manifest');
  });

  it('handles a mixed fleet — only the misconfigured one is flagged', () => {
    const rpBad: ProbeInput = {
      id: 'research-plugins',
      dir: '/x/rp',
      manifest: { main: 'dist/index.js', contracts: { tools: Array(34).fill('t') } },
    };
    const findings = auditPluginActivation([healthy, rpBad]);
    expect(findings.map((f) => f.id)).toEqual(['research-plugins']);
  });
});
