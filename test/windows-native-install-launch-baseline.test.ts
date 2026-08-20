import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const BASELINE_ROOT = path.join(
  ROOT,
  'scripts',
  'acceptance',
  'windows-native-ux-baseline',
);
const MANIFEST_PATH = path.join(BASELINE_ROOT, 'baseline-manifest.json');
const FIXTURES_PATH = path.join(BASELINE_ROOT, 'regression-fixtures.json');

type SharedSurface = {
  path: string;
  sha256: string;
  topologies: string[];
};

type RuntimeFixture = {
  id: string;
  provenance: 'real-windows-sanitized' | 'controlled-local' | 'synthetic';
  expectedClass:
    | 'product-runtime-red'
    | 'probe-contract-red-product-unknown'
    | 'runtime-protocol-green-interaction-red';
  observed: {
    installTransactionGreen: boolean;
    http200: boolean;
    configGet: 'pass' | 'fail' | 'not-run';
    stableTicks: boolean;
    quickEditEnabled: boolean | null;
    browserAutoOpen: 'pass' | 'fail' | 'not-observed';
    failureCode: string | null;
  };
};

type OwnershipFixture = {
  id: string;
  provenance: 'real-windows-sanitized' | 'controlled-local' | 'synthetic';
  topology: string;
  receipt: {
    present: boolean;
    pidExists: boolean;
    creationTimeMatches: boolean;
    executableMatches: boolean;
    managedRootMatches: boolean;
    protocolMatches: boolean;
  };
  expectedAction: 'preserve-and-reject' | 'clear-receipt-only';
};

type InteractionFixture = {
  id: string;
  provenance: 'synthetic';
  observed: {
    quickEditEnabled: boolean;
    progressAdvancedWithoutInput: boolean;
    http200: boolean;
    browserDispatchAttempted: boolean;
    browserDispatchAccepted: boolean;
    copyableFallbackVisible: boolean;
  };
  expectedAction: 'fail-interaction-gate' | 'show-copyable-fallback';
};

type UxCaptureFixture = {
  id: string;
  provenance: 'real-windows-sanitized';
  sourceReportSha256: { json: string; text: string };
  captureCoreSha256: string;
  sourceCommitObserved: string | null;
  sharedFileTupleMatchesCommit: string;
  observed: {
    powershell51: boolean;
    powershell7: boolean;
    ipv4Http200: boolean;
    localhostHttp200: boolean;
    nodeDnsBrandAlias: string;
    chromiumBrandAlias: string;
    browserDispatchAccepted: boolean;
    exactListenerIdentityCaptured: boolean;
    sourceGitDiscovered: boolean;
    secretPatternHits: number;
  };
  expectedClass: 'host-prerequisite-red-browser-alias-unresolved';
};

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function classifyRuntime(fixture: RuntimeFixture): RuntimeFixture['expectedClass'] {
  const observed = fixture.observed;
  if (
    observed.failureCode === 'INVALID_CLIENT_IDENTITY'
    && observed.http200
    && observed.configGet === 'not-run'
  ) {
    return 'probe-contract-red-product-unknown';
  }
  if (
    observed.installTransactionGreen
    && observed.http200
    && observed.configGet === 'pass'
    && observed.stableTicks
    && (observed.quickEditEnabled || observed.browserAutoOpen !== 'pass')
  ) {
    return 'runtime-protocol-green-interaction-red';
  }
  return 'product-runtime-red';
}

function ownershipAction(fixture: OwnershipFixture): OwnershipFixture['expectedAction'] {
  const receipt = fixture.receipt;
  if (
    receipt.present
    && !receipt.pidExists
    && !receipt.creationTimeMatches
    && !receipt.executableMatches
    && !receipt.managedRootMatches
    && !receipt.protocolMatches
  ) {
    return 'clear-receipt-only';
  }
  return 'preserve-and-reject';
}

function interactionAction(fixture: InteractionFixture): InteractionFixture['expectedAction'] | 'accept' {
  const observed = fixture.observed;
  if (observed.quickEditEnabled && !observed.progressAdvancedWithoutInput) {
    return 'fail-interaction-gate';
  }
  if (
    observed.http200
    && observed.browserDispatchAttempted
    && !observed.browserDispatchAccepted
    && observed.copyableFallbackVisible
  ) {
    return 'show-copyable-fallback';
  }
  return 'accept';
}

describe('Windows native install and daily-launch frozen baseline', () => {
  it('pins every shared source byte and its affected topology fan-out', () => {
    const manifest = readJson<{
      schemaVersion: number;
      productionBaseline: {
        commit: string;
        tree: string;
        worktreeStatus: string;
      };
      sharedSurfaces: SharedSurface[];
    }>(MANIFEST_PATH);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.productionBaseline).toEqual({
      commit: '6d433849e98d5c34b2d8656c13c4c25f1688ed6b',
      tree: '2f77b533b0da9c301368aa799b226049c7ab2894',
      worktreeStatus: 'clean-integrated-windows-candidate',
    });
    expect(manifest.sharedSurfaces.length).toBeGreaterThanOrEqual(12);
    for (const surface of manifest.sharedSurfaces) {
      expect(sha256(path.join(ROOT, surface.path)), surface.path).toBe(
        surface.sha256,
      );
      expect(surface.topologies, surface.path).toContain('windows-native');
      if (
        [
          'scripts/install.sh',
          'scripts/run.sh',
          'scripts/ensure-config.cjs',
          'scripts/node-runtime.cjs',
          'scripts/native-runtime-guard.cjs',
          'scripts/runtime-preflight.cjs',
        ].includes(surface.path)
      ) {
        expect(surface.topologies, surface.path).toContain('macos-native');
      }
    }
  });

  it('records why the last real Windows package and evidence are stale', () => {
    const manifest = readJson<{
      lastRealWindowsArtifact: {
        packageName: string;
        packageSha256: string;
        evidenceSourceCommit: string;
        status: string;
        changedPathsToCurrent: Array<{ status: string; path: string }>;
      };
      latestRealWindowsAttempt: {
        packageName: string;
        packageSha256: string;
        evidenceSourceCommit: string;
        status: string;
        releaseAuthority: boolean;
      };
      remoteAuthorityAtBaseline: Record<string, string>;
    }>(MANIFEST_PATH);
    expect(manifest.lastRealWindowsArtifact).toMatchObject({
      packageName: 'Wentor-Weifang-RC-0.8.3-Windows-Native-Offline-v18.zip',
      packageSha256: '3d8df487f42762334691287b9191d371310bd016996bf7e5000801385d0b5320',
      evidenceSourceCommit: '661879c9a4b43833b9c25047e505bb4c3ff4fdc4',
      status: 'stale-not-release-authority',
    });
    expect(manifest.lastRealWindowsArtifact.changedPathsToCurrent.length)
      .toBeGreaterThan(20);
    expect(manifest.latestRealWindowsAttempt).toEqual(expect.objectContaining({
      packageName: 'Wentor-Weifang-RC-0.8.3-Windows-Native-Offline-v20.zip',
      packageSha256: '11e122bba2016d2b3f319239839bd050948870cedddcad7b57c9fafa60fbe35c',
      evidenceSourceCommit: '0fbda5eac478457a721ce500a2b7b04de9027190',
      status: 'red-model-probe-cause-unclassified',
      releaseAuthority: false,
    }));
    expect(manifest.remoteAuthorityAtBaseline).toEqual({
      localMain: 'e63679c189c162d623c498a9031b274897cac43d',
      localCandidate: '6d433849e98d5c34b2d8656c13c4c25f1688ed6b',
      giteeMain: '5015be7a72387098f122cb3e7cc4aae32714d4fa',
      giteeCandidate: '661879c9a4b43833b9c25047e505bb4c3ff4fdc4',
      githubMain: '5015be7a72387098f122cb3e7cc4aae32714d4fa',
      originMain: '5015be7a72387098f122cb3e7cc4aae32714d4fa',
    });
  });

  it('keeps product failures separate from probe-contract false reds', () => {
    const fixtures = readJson<{ runtime: RuntimeFixture[] }>(FIXTURES_PATH);
    expect(fixtures.runtime.map((fixture) => fixture.id)).toEqual([
      'windows-v16-runtime-red',
      'windows-v17-probe-identity-red',
      'windows-v18-runtime-interaction-red',
      'windows-v19-plugin-cron-red',
      'windows-v20-model-probe-red',
    ]);
    for (const fixture of fixtures.runtime) {
      expect(classifyRuntime(fixture), fixture.id).toBe(fixture.expectedClass);
    }
  });

  it('freezes the v2 real-Windows red without treating Node DNS as browser evidence', () => {
    const fixtures = readJson<{ uxCapture: UxCaptureFixture[] }>(FIXTURES_PATH);
    expect(fixtures.uxCapture).toEqual([
      expect.objectContaining({
        id: 'windows-wux-v2-host-and-alias-red',
        provenance: 'real-windows-sanitized',
        sourceReportSha256: {
          json: 'b649f8ad25cbb57aa44c1daa90d3f661d53d681fe4d882e850fd1ef3dff25dfe',
          text: 'd7108ef8cbe38d6db1e3075020afcfb0ad4f10052b6f6726f8672b5a3ca21652',
        },
        captureCoreSha256: 'f07ef8b1fdb53c3fe236f1d1139ad0ba005ffd21c995282c61fc021a161c3d9b',
        sourceCommitObserved: null,
        sharedFileTupleMatchesCommit: '661879c9a4b43833b9c25047e505bb4c3ff4fdc4',
        expectedClass: 'host-prerequisite-red-browser-alias-unresolved',
      }),
    ]);
    const observed = fixtures.uxCapture[0].observed;
    expect(observed).toMatchObject({
      powershell51: true,
      powershell7: false,
      ipv4Http200: true,
      localhostHttp200: true,
      nodeDnsBrandAlias: 'ENOTFOUND',
      chromiumBrandAlias: 'not-run',
      browserDispatchAccepted: true,
      exactListenerIdentityCaptured: true,
      sourceGitDiscovered: false,
      secretPatternHits: 0,
    });
  });

  it('never authorizes a kill from a foreign listener or stale receipt', () => {
    const fixtures = readJson<{ ownership: OwnershipFixture[] }>(FIXTURES_PATH);
    expect(fixtures.ownership.map((fixture) => fixture.id)).toEqual([
      'foreign-listener-without-receipt',
      'stale-owner-receipt',
    ]);
    for (const fixture of fixtures.ownership) {
      expect(ownershipAction(fixture), fixture.id).toBe(fixture.expectedAction);
      expect(fixture.expectedAction).not.toBe('stop-process');
    }
  });

  it('keeps Enter/QuickEdit stalls and browser-dispatch failures as independent negative fixtures', () => {
    const fixtures = readJson<{ interaction: InteractionFixture[] }>(FIXTURES_PATH);
    expect(fixtures.interaction.map((fixture) => fixture.id)).toEqual([
      'quickedit-enter-stall',
      'browser-dispatch-rejected-with-fallback',
    ]);
    for (const fixture of fixtures.interaction) {
      expect(interactionAction(fixture), fixture.id).toBe(fixture.expectedAction);
    }

    const quickEditControlledFlip = structuredClone(fixtures.interaction[0]);
    quickEditControlledFlip.observed.quickEditEnabled = false;
    quickEditControlledFlip.observed.progressAdvancedWithoutInput = true;
    expect(interactionAction(quickEditControlledFlip)).toBe('accept');

    const browserControlledFlip = structuredClone(fixtures.interaction[1]);
    browserControlledFlip.observed.browserDispatchAccepted = true;
    expect(interactionAction(browserControlledFlip)).toBe('accept');
  });

  it('preserves the contaminated macOS ABI fixture as a functional-open failure', () => {
    const fixtures = readJson<{
      nativeAbi: Array<{
        id: string;
        provenance: string;
        buildAbi: number;
        gatewayAbi: number;
        javascriptRequirePassed: boolean;
        databaseOpenPassed: boolean;
        expectedRepairProof: string;
      }>;
    }>(FIXTURES_PATH);
    expect(fixtures.nativeAbi).toEqual([
      expect.objectContaining({
        id: 'macos-node24-binding-under-node22',
        provenance: 'controlled-local',
        buildAbi: 137,
        gatewayAbi: 127,
        javascriptRequirePassed: true,
        databaseOpenPassed: false,
        expectedRepairProof: 'in-memory-database-select-one',
      }),
    ]);
  });

  it('captures the current browser, alias, BOM and daily-launch gaps explicitly', () => {
    const manifest = readJson<{
      currentKnownGaps: {
        sourceInstallWindowsHasUtf8Bom: boolean;
        browserLaunch: string;
        brandedLocalhostOrigin: boolean;
        dailyLauncher: boolean;
        trayHost: boolean;
      };
    }>(MANIFEST_PATH);
    const installerBytes = fs.readFileSync(
      path.join(ROOT, 'scripts', 'install-windows.ps1'),
    );
    const installSh = fs.readFileSync(
      path.join(ROOT, 'scripts', 'install.sh'),
      'utf8',
    );
    const ensureConfig = fs.readFileSync(
      path.join(ROOT, 'scripts', 'ensure-config.cjs'),
      'utf8',
    );
    expect([...installerBytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(manifest.currentKnownGaps.sourceInstallWindowsHasUtf8Bom).toBe(true);
    expect(installSh).toContain('cmd.exe /c start "" "$DASHBOARD_URL"');
    expect(installSh).toContain('>/dev/null 2>&1 || true');
    expect(manifest.currentKnownGaps.browserLaunch).toBe(
      'msys-cmd-start-failure-swallowed',
    );
    expect(ensureConfig).not.toContain('xn--w8yz0bg0vrjz.localhost');
    expect(manifest.currentKnownGaps.brandedLocalhostOrigin).toBe(false);
    expect(manifest.currentKnownGaps.dailyLauncher).toBe(false);
    expect(manifest.currentKnownGaps.trayHost).toBe(false);
  });

  it('proves the source-byte guard detects a controlled SHA flip', () => {
    const manifest = readJson<{ sharedSurfaces: SharedSurface[] }>(MANIFEST_PATH);
    const surface = manifest.sharedSurfaces[0];
    const sourcePath = path.join(ROOT, surface.path);
    const original = fs.readFileSync(sourcePath);
    const controlledFlip = Buffer.from(original);
    controlledFlip[0] ^= 0x01;
    expect(sha256(sourcePath)).toBe(surface.sha256);
    expect(crypto.createHash('sha256').update(controlledFlip).digest('hex'))
      .not.toBe(surface.sha256);
  });

  it('keeps all committed baseline fixtures free of credential shapes', () => {
    const files = fs.readdirSync(BASELINE_ROOT)
      .filter((name) => name.endsWith('.json') || name.endsWith('.md'));
    const source = files
      .map((name) => fs.readFileSync(path.join(BASELINE_ROOT, name), 'utf8'))
      .join('\n');
    expect(source).not.toMatch(/rca_[A-Za-z0-9_-]{43,}/);
    expect(source).not.toMatch(/(^|[^A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{16,}/m);
    expect(source).not.toMatch(/Authorization\s*:\s*Bearer\s+\S+/i);
  });

  it('binds the stale evidence path list to the actual historical diff', () => {
    const manifest = readJson<{
      lastRealWindowsArtifact: {
        evidenceSourceCommit: string;
        changedPathsToCurrent: Array<{ status: string; path: string }>;
      };
    }>(MANIFEST_PATH);
    const actual = execFileSync(
      'git',
      [
        'diff',
        '--name-status',
        `${manifest.lastRealWindowsArtifact.evidenceSourceCommit}..5015be7a72387098f122cb3e7cc4aae32714d4fa`,
      ],
      { cwd: ROOT, encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [status, ...fileParts] = line.split('\t');
        return { status, path: fileParts.join('\t') };
      });
    expect(actual).toEqual(manifest.lastRealWindowsArtifact.changedPathsToCurrent);
  });
});
