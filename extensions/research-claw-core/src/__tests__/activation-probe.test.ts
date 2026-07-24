import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import {
  auditPluginActivation,
  discoverPluginInputs,
  findRecentStartupFailures,
  resolveOpenClawStateDir,
  type ProbeInput,
} from '../self-check/activation-probe.js';

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

describe('self-check disk discovery', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-activation-probe-'));
    tempDirs.push(dir);
    return dir;
  }

  it('discovers a native state-dir research-plugins install and reproduces the v1.4.7 gap', () => {
    const root = tempDir();
    const stateDir = path.join(root, 'state');
    const pluginDir = path.join(stateDir, 'extensions', 'research-plugins');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'openclaw.plugin.json'),
      JSON.stringify({
        id: 'research-plugins',
        main: 'index.ts',
        contracts: { tools: ['paper_search', 'citation_graph'] },
      }),
    );

    const discovered = discoverPluginInputs({
      projectRoot: path.join(root, 'project'),
      stateDir,
      loadPaths: [],
    });
    expect(discovered.map((plugin) => plugin.id)).toEqual(['research-plugins']);
    expect(auditPluginActivation(discovered).map((finding) => finding.kind)).toEqual([
      'missing-activation',
    ]);
  });

  it('does not flag the native install when its activation contract is complete', () => {
    const root = tempDir();
    const stateDir = path.join(root, 'state');
    const pluginDir = path.join(stateDir, 'extensions', 'research-plugins');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'openclaw.plugin.json'),
      JSON.stringify({
        id: 'research-plugins',
        main: 'index.ts',
        activation: { onStartup: true },
        contracts: { tools: ['paper_search'] },
      }),
    );

    const discovered = discoverPluginInputs({
      projectRoot: path.join(root, 'project'),
      stateDir,
      loadPaths: [],
    });
    expect(auditPluginActivation(discovered)).toEqual([]);
  });

  it('turns a genuinely malformed manifest on disk into unreadable-manifest', () => {
    const root = tempDir();
    const pluginDir = path.join(root, 'project', 'extensions', 'broken-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'openclaw.plugin.json'), '{"id":');

    const discovered = discoverPluginInputs({
      projectRoot: path.join(root, 'project'),
      stateDir: path.join(root, 'state'),
      loadPaths: [],
    });
    expect(discovered).toHaveLength(1);
    expect(discovered[0].manifest).toBeNull();
    expect(auditPluginActivation(discovered)[0]?.kind).toBe('unreadable-manifest');
  });

  it('deduplicates the same plugin reached through bundled, state, and explicit paths', () => {
    const root = tempDir();
    const pluginDir = path.join(root, 'project', 'extensions', 'research-claw-core');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'openclaw.plugin.json'),
      JSON.stringify(healthy.manifest),
    );

    const discovered = discoverPluginInputs({
      projectRoot: path.join(root, 'project'),
      stateDir: path.join(root, 'project'),
      loadPaths: [pluginDir, path.join(pluginDir, 'index.ts')],
    });
    expect(discovered).toHaveLength(1);
  });

  it('honours OPENCLAW_STATE_DIR and finds recent startup_failed snapshots there', () => {
    const root = tempDir();
    const stateDir = path.join(root, 'custom-state');
    const stabilityDir = path.join(stateDir, 'logs', 'stability');
    fs.mkdirSync(stabilityDir, { recursive: true });
    const recent = path.join(stabilityDir, 'gateway-startup_failed-20260725.json');
    const stale = path.join(stabilityDir, 'gateway-startup_failed-stale.json');
    fs.writeFileSync(recent, '{}');
    fs.writeFileSync(stale, '{}');
    const now = Date.now();
    fs.utimesSync(stale, new Date(now - 48 * 60 * 60 * 1000), new Date(now - 48 * 60 * 60 * 1000));

    expect(resolveOpenClawStateDir({ OPENCLAW_STATE_DIR: stateDir }, '/wrong-home')).toBe(
      stateDir,
    );
    expect(resolveOpenClawStateDir({ OPENCLAW_STATE_DIR: '~/custom-state' }, root)).toBe(
      path.join(root, 'custom-state'),
    );
    expect(findRecentStartupFailures(stateDir, now)).toEqual([recent]);
  });
});
