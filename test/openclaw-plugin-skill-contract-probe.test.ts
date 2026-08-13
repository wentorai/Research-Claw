import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'test', 'fixtures', 'openclaw-plugin-skill-contract-2026.6.1.json'),
  'utf8',
)) as {
  conditionalPlugin: {
    manifestDeclaredTools: string[];
    runtimeModelInventory: string[];
    registeredRpcPresent: boolean;
    omittedRpcAbsent: boolean;
    pluginStatus: string;
  };
  skillDiscovery: {
    oneLevelProfileSource: string;
    collisionWinner: string;
    groupedRecursiveObserved: boolean;
    promptSnapshotSource: string;
    stableCapsuleContract: string;
  };
};

describe('OpenClaw 2026.6.1 conditional-plugin and Profile Skill contracts', () => {
  it('replays the real isolated Gateway probe', () => {
    const raw = execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'probe-openclaw-plugin-skill-contract.mjs')],
      {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 5 * 1024 * 1024,
      },
    );
    const result = JSON.parse(raw) as {
      openClawVersion: string;
      isolation: { configuredNetworkEndpoints: string };
      conditionalPlugin: {
        manifestDeclaredTools: string[];
        runtimeModelInventory: string[];
        registeredRpcPresent: boolean;
        omittedRpcAbsent: boolean;
        omittedToolAbsent: boolean;
        pluginInspection: { status: string; diagnostics: unknown[] };
      };
      skillDiscovery: {
        oneLevelProfile: { source: string; modelVisible: boolean };
        collisionWinner: string;
        observedGroupedRecursiveSkill?: { source: string };
        promptSnapshot: { source: string; profileSkillPresent: boolean };
        stableCapsuleContract: string;
      };
    };

    expect(result.openClawVersion).toBe('2026.6.1');
    expect(result.isolation.configuredNetworkEndpoints).toBe('loopback-only');
    expect(result.conditionalPlugin).toMatchObject({
      manifestDeclaredTools: FIXTURE.conditionalPlugin.manifestDeclaredTools,
      runtimeModelInventory: FIXTURE.conditionalPlugin.runtimeModelInventory,
      registeredRpcPresent: FIXTURE.conditionalPlugin.registeredRpcPresent,
      omittedRpcAbsent: FIXTURE.conditionalPlugin.omittedRpcAbsent,
      omittedToolAbsent: true,
      pluginInspection: {
        status: FIXTURE.conditionalPlugin.pluginStatus,
        diagnostics: [],
      },
    });
    expect(result.skillDiscovery).toMatchObject({
      oneLevelProfile: {
        source: FIXTURE.skillDiscovery.oneLevelProfileSource,
        modelVisible: true,
      },
      collisionWinner: FIXTURE.skillDiscovery.collisionWinner,
      promptSnapshot: {
        source: FIXTURE.skillDiscovery.promptSnapshotSource,
        profileSkillPresent: true,
      },
      stableCapsuleContract: FIXTURE.skillDiscovery.stableCapsuleContract,
    });
    expect(Boolean(result.skillDiscovery.observedGroupedRecursiveSkill)).toBe(
      FIXTURE.skillDiscovery.groupedRecursiveObserved,
    );
  }, 65_000);
});
