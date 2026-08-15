import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const ROOT = path.resolve(__dirname, '..');
const installer = fs.readFileSync(
  path.join(ROOT, 'scripts/install-docker.ps1'),
  'utf8',
);
const verifier = fs.readFileSync(
  path.join(ROOT, 'scripts/verify-installer-powershell.ps1'),
  'utf8',
);
const acceptanceHarness = fs.readFileSync(
  path.join(ROOT, 'scripts/acceptance/windows-bootstrap-docker.ps1'),
  'utf8',
);
const manifestExample = JSON.parse(
  fs.readFileSync(
    path.join(
      ROOT,
      'scripts/acceptance/windows-bootstrap-docker.manifest.example.json',
    ),
    'utf8',
  ),
) as Record<string, any>;
const manifestExamplePath = path.join(
  ROOT,
  'scripts/acceptance/windows-bootstrap-docker.manifest.example.json',
);
const manifestFinalizerPath = path.join(
  ROOT,
  'scripts/acceptance/finalize-windows-bootstrap-manifest.cjs',
);
const manifestFinalizer = fs.readFileSync(manifestFinalizerPath, 'utf8');
const gitAttributes = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
const workflow = fs.readFileSync(
  path.join(ROOT, '.github/workflows/windows-installer-contract.yml'),
  'utf8',
);
const workflowDocument = parseYaml(workflow) as {
  jobs: { powershell: { steps: Array<{ name?: string; shell?: string; run?: string }> } };
};

describe('Windows PowerShell installer contract gate', () => {
  it('rejects unknown or extra arguments before entering the installer body', () => {
    const paramEnd = installer.indexOf('$RcBootstrapAuthTokenSupplied');
    expect(paramEnd).toBeGreaterThan(0);
    const preflight = installer.slice(0, paramEnd);
    expect(preflight).toContain('$args.Count -ne 0');
    expect(preflight).toContain(
      "throw 'Unknown or extra installer arguments are not supported.'",
    );
  });

  it('keeps the setup Token in-process and the Capsule on redirected stdin', () => {
    const authTokenLines = installer
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.includes('$AuthToken'));
    expect(authTokenLines).toEqual([
      'param([string]$AuthToken)',
      'if ($RcProfileRequested -and [string]::IsNullOrWhiteSpace($AuthToken)) {',
      "if ($RcProfileRequested -and $AuthToken -notmatch '^rca_[A-Za-z0-9_-]{43,}$') {",
      '[void]$request.Headers.TryAddWithoutValidation(\'Authorization\', "Bearer $AuthToken")',
    ]);
    expect(installer).not.toContain('modelApiKey');
    expect(installer).toContain('-RedirectStandardInput $InputPath');
    expect(installer).toContain("-Command 'stage' -InputPath $script:RcProfileCapsule");
    expect(installer).not.toMatch(/docker[^\r\n]*\$AuthToken/i);
  });

  it('executes the authoritative installer under the current Windows shell', () => {
    expect(verifier).toContain("Join-Path $PSScriptRoot 'install-docker.ps1'");
    expect(verifier).toContain('[System.Environment]::Is64BitOperatingSystem');
    expect(verifier).toContain('[System.Environment]::Is64BitProcess');
    expect(verifier).toContain("$processorArchitecture -ceq 'AMD64'");
    expect(verifier).toContain('Get-CimInstance Win32_Processor');
    expect(verifier).toContain(
      '[System.Management.Automation.Language.Parser]::ParseInput',
    );
    expect(verifier).toContain('[scriptblock]::Create(`$installerText)');
    expect(verifier).toContain('& `$installerScriptBlock -AuthToken `$valid');
    expect(verifier).not.toContain("& '$quotedInstaller'");
    expect(verifier).toContain("$parameterNames[0] -eq 'AuthToken'");
    for (const scenario of [
      'no-docker',
      'empty-token',
      'invalid-token',
      'missing-value',
      'valid-token-no-docker',
      'unknown-parameter',
      'duplicate-token',
    ]) {
      expect(verifier).toContain(`name = '${scenario}'`);
    }
    expect(verifier).toContain('$scopeResult.tokenCleared');
    expect(verifier).toContain('[string]::IsNullOrEmpty($AuthToken)');
    expect(verifier).toContain('$scopeResult.bindingRemoved');
    expect(verifier).toContain('$process.ExitCode -ne 0');
    expect(verifier).toContain('$ExpectedEdition');
    expect(verifier).toContain('$ExpectedMajorVersion');
    expect(verifier).toContain('$AcceptanceHarnessPath');
    expect(verifier).toContain("'ManifestPath', 'SecretBundlePath', 'EvidenceDirectory'");
    expect(verifier).toContain("'InstallerPath', 'DisposableHostConfirmed'");
    expect(verifier).toContain("expectedMarker = '-AuthToken requires a non-empty value.'");
    expect(verifier).toContain("expectedMarker = '-AuthToken has an invalid format.'");
    expect(verifier).toContain(
      "expectedMarker = 'Unknown or extra installer arguments are not supported.'",
    );
    expect(verifier).toContain("expectedMarker = 'RC_CONTRACT_ERROR_ID=MissingArgument'");
    expect(verifier).toContain(
      "expectedMarker = 'RC_CONTRACT_ERROR_ID=ParameterAlreadyBound'",
    );
    expect(verifier).toContain("forbidDockerUnavailable = $true");
    expect(verifier).toContain("$output -match 'Docker is unavailable'");
    expect(verifier).toContain("$output -notmatch 'rca_[A-Za-z0-9_-]{43,}'");
    expect(verifier).toContain('$privateRoots.Count -eq 0');
    expect(verifier).toContain("-Filter 'rc-docker-install-*.log'");
    expect(verifier).toContain(
      "'The installer left unexpected temporary artifacts behind.'",
    );
  });

  it('runs both Windows PowerShell 5.1 and PowerShell 7 on a Windows x64 host', () => {
    expect(workflow).toContain('runs-on: windows-latest');
    const contractSteps = workflowDocument.jobs.powershell.steps.filter(
      (step) => step.run?.includes('verify-installer-powershell.ps1'),
    );
    expect(contractSteps).toEqual([
      expect.objectContaining({
        shell: 'powershell',
        run: expect.stringContaining(
          '-ExpectedEdition Desktop -ExpectedMajorVersion 5',
        ),
      }),
      expect.objectContaining({
        shell: 'pwsh',
        run: expect.stringContaining('-ExpectedEdition Core -ExpectedMajorVersion 7'),
      }),
    ]);
    for (const step of contractSteps) {
      expect(step.run).toContain(
        '-AcceptanceHarnessPath .\\scripts\\acceptance\\windows-bootstrap-docker.ps1',
      );
    }
    expect(workflow).not.toContain('continue-on-error');
  });

  it('binds the Windows Docker gate to exact non-secret provenance', () => {
    expect(acceptanceHarness).toContain("'acceptanceHarness'");
    expect(acceptanceHarness).toContain('$script:AcceptanceHarnessResolved');
    expect(acceptanceHarness).toContain('ACCEPTANCE_HARNESS_SHA256_MISMATCH');
    expect(acceptanceHarness).toContain('criticalRuntimeSha256');
    expect(acceptanceHarness).toContain("@('pull', $digestRef)");
    expect(acceptanceHarness).toContain('digestReference = $digestRef');
    expect(acceptanceHarness).toContain('observedImageId = [string]$inspect.Id');
    expect(acceptanceHarness).toContain('IMAGE_BUILD_ENV_LABEL_MISMATCH');
    expect(acceptanceHarness).toContain('function Assert-ImageReferenceId');
    expect(acceptanceHarness).toContain(
      'Assert-ImageReferenceId $script:HealthFailRef $script:HealthFailImageId',
    );
    expect(acceptanceHarness).toContain('function New-VolumeHelperSnapshot');
    expect(acceptanceHarness).toContain('New-VolumeHelperSnapshot');
    expect(acceptanceHarness).toContain('function Assert-InputSourcesStable');
    expect(acceptanceHarness).toContain('Assert-InputSourcesStable');
    expect(acceptanceHarness).toContain('executedFromPrivateSnapshot = $true');
    expect(acceptanceHarness).toContain('parsedAndInvokedFromSingleSnapshot = $true');
    expect(acceptanceHarness).toContain('function Assert-InstallerSecretFlowContract');
    expect(acceptanceHarness).toContain('$script:InstallerSecretFlowContract');
    expect(acceptanceHarness).toContain(
      "proofMethod = 'powershell-ast-exact-snapshot-plus-runtime-posthoc'",
    );
    expect(acceptanceHarness).toContain(
      "observationMode = 'posthoc-surviving-containers-current-host-processes-and-host-temp'",
    );
    const checksumPublish = acceptanceHarness.indexOf(
      '[System.IO.File]::Move($shaTemporary, $shaTarget)',
    );
    const jsonPublish = acceptanceHarness.indexOf(
      '[System.IO.File]::Move($jsonTemporary, $target)',
    );
    expect(checksumPublish).toBeGreaterThan(0);
    expect(jsonPublish).toBeGreaterThan(checksumPublish);
    expect(acceptanceHarness).toContain(
      'A passed JSON final name is therefore',
    );
    expect(acceptanceHarness).not.toContain('tokenInArgv = $false');
    expect(acceptanceHarness).not.toContain('tokenInEnvironment = $false');
    expect(acceptanceHarness).not.toContain('tokenEnteredContainer = $false');
    expect(acceptanceHarness).not.toContain('$ImageManifest.imageId');

    expect(manifestExample).toHaveProperty('acceptanceHarness.sha256');
    expect(manifestExample).toHaveProperty('expectedFailures.badCapsule.capsuleDigest');
    expect(manifestExample).toHaveProperty(
      'images.candidate.criticalRuntimeSha256',
    );
    expect(manifestExample).not.toHaveProperty('images.candidate.imageId');
    expect(manifestExample).not.toHaveProperty('images.healthFail.imageId');
  });

  it('strictly binds every model-key scan needle to the redeemed Capsule', () => {
    expect(acceptanceHarness).toContain('function Test-SecretStringEqual');
    expect(acceptanceHarness).toContain('[object]$ExpectedModelKey');
    expect(acceptanceHarness).toContain(
      "Assert-ExactProperties $capsule.secrets @('modelApiKey')",
    );
    expect(acceptanceHarness).toContain(
      "Fail-Gate 'CAPSULE_ATTESTATION_MODEL_KEY_MISMATCH'",
    );
    expect(acceptanceHarness).toContain('modelKeyBinding = $true');
    expect(acceptanceHarness).toContain("'bad-capsule-before-installer'");
    expect(acceptanceHarness).toContain("'bad-capsule-after-installer'");
    expect(acceptanceHarness).toContain("'health-fail-after-installer'");
    expect(acceptanceHarness).toContain('$script:CapsuleAttestations.Count -ne 6');
    expect(acceptanceHarness).toContain(".GetType().Name -cne 'String'");
    expect(acceptanceHarness).toContain("'SECRET_NEEDLES_MUST_BE_DISTINCT'");
    expect(acceptanceHarness).toContain("'MANIFEST_CONTAINS_SECRET'");
    expect(acceptanceHarness).toContain("'SECRET_PRESENT_IN_PROCESS_ENVIRONMENT'");
    expect(acceptanceHarness).toContain("'GATEWAY_NOT_HEALTHY_AFTER_VOLUME_SCAN'");
    expect(acceptanceHarness).toContain("'PROFILE_STATUS_RECEIPT_MISMATCH'");
    expect(acceptanceHarness).toContain("'DOCKER_LOG_SCAN_FAILED'");
    expect(acceptanceHarness).toContain("'DOCKER_PROCESS_SCAN_FAILED'");
  });

  it('assembles only a complete non-secret Windows gate manifest', () => {
    expect(manifestFinalizer).not.toContain('process.exit(');
    expect(manifestFinalizer).toContain('process.exitCode = 1');
    expect(manifestFinalizer).toContain('sameNode(currentTemporary, temporaryIdentity)');
    const temporaryReadback = manifestFinalizer.indexOf(
      'const readback = readFileSnapshot(\n      temporary,',
    );
    const hardLinkCommit = manifestFinalizer.indexOf(
      'fs.linkSync(temporary, resolved)',
    );
    const publishCatch = manifestFinalizer.indexOf('} catch (error) {', hardLinkCommit);
    expect(temporaryReadback).toBeGreaterThan(0);
    expect(hardLinkCommit).toBeGreaterThan(temporaryReadback);
    expect(publishCatch).toBeGreaterThan(hardLinkCommit);
    expect(manifestFinalizer.slice(hardLinkCommit, publishCatch)).not.toContain(
      'lstatSync(resolved',
    );
    expect(manifestFinalizer.slice(hardLinkCommit, publishCatch)).not.toContain(
      'readFileSnapshot(',
    );
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-windows-manifest-test.'));
    try {
      const rejectedOutput = path.join(root, 'rejected.json');
      const rejected = spawnSync(
        process.execPath,
        [manifestFinalizerPath, manifestExamplePath, '--output', rejectedOutput],
        { encoding: 'utf8' },
      );
      expect(rejected.status).not.toBe(0);
      expect(rejected.stdout).toBe('');
      expect(rejected.stderr).toContain('UNRESOLVED_MANIFEST_PLACEHOLDER');
      expect(fs.existsSync(rejectedOutput)).toBe(false);

      const draft = structuredClone(manifestExample);
      draft.gateId = 'rc-t10-windows-fixture-20260815';
      draft.fixtureAuthority.id = 'rc-t10-staging-fixture-20260815';
      draft.fixtureAuthority.expiresAtUtc = '2030-01-01T00:00:00Z';
      draft.images.candidate.repository = 'registry.example.com/wentor/candidate';
      draft.images.healthFail.repository = 'registry.example.com/wentor/health-fail';
      draft.images.candidate.registryDigest = `sha256:${'1'.repeat(64)}`;
      draft.images.healthFail.registryDigest = `sha256:${'2'.repeat(64)}`;
      draft.images.candidate.labels['org.opencontainers.image.revision'] = '4'.repeat(40);
      draft.images.healthFail.labels['org.opencontainers.image.revision'] = '4'.repeat(40);
      for (const [index, name] of ['valid', 'rotate', 'healthFail'].entries()) {
        draft.expectedProfiles[name].id = 'thermoelectric-user-a';
        draft.expectedProfiles[name].digest = String(index + 5).repeat(64);
      }
      draft.expectedFailures.badCapsule.capsuleDigest = '8'.repeat(64);
      const input = path.join(root, 'draft.json');
      fs.writeFileSync(input, `${JSON.stringify(draft)}\n`, { mode: 0o600 });

      const output = path.join(root, 'gate.json');
      const result = spawnSync(
        process.execPath,
        [manifestFinalizerPath, input, '--output', output],
        { encoding: 'utf8' },
      );
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      const outputBytes = fs.readFileSync(output);
      expect(outputBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
      const outputText = outputBytes.toString('utf8');
      expect(outputText).not.toMatch(/REPLACE_|\.invalid|rca_[A-Za-z0-9_-]{43,}/);
      const manifest = JSON.parse(outputText);
      expect(manifest.acceptanceHarness.sha256).toBe(
        sha256(path.join(ROOT, 'scripts/acceptance/windows-bootstrap-docker.ps1')),
      );
      expect(manifest.installer.sha256).toBe(
        sha256(path.join(ROOT, 'scripts/install-docker.ps1')),
      );
      expect(manifest.evidenceHelper.sha256).toBe(
        sha256(path.join(ROOT, 'scripts/acceptance/windows-volume-evidence.cjs')),
      );
      expect(manifest.images.healthFail.failureEntrypointSha256).toBe(
        sha256(path.join(ROOT, 'scripts/acceptance/entrypoint-health-fail.sh')),
      );
      expect(manifest.images.candidate.criticalRuntimeSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(manifest).not.toHaveProperty('tokens');
      expect(manifest).not.toHaveProperty('modelKeys');

      const mismatchedRuntime = structuredClone(draft);
      mismatchedRuntime.images.candidate.criticalRuntimeSha256 = '3'.repeat(64);
      const mismatchedRuntimeInput = path.join(root, 'runtime-mismatch.json');
      fs.writeFileSync(mismatchedRuntimeInput, JSON.stringify(mismatchedRuntime));
      const mismatchedRuntimeResult = spawnSync(
        process.execPath,
        [
          manifestFinalizerPath,
          mismatchedRuntimeInput,
          '--output',
          path.join(root, 'runtime-mismatch-output.json'),
        ],
        { encoding: 'utf8' },
      );
      expect(mismatchedRuntimeResult.status).not.toBe(0);
      expect(mismatchedRuntimeResult.stderr).toContain('LOCAL_SOURCE_RUNTIME_MISMATCH');

      const unsafeRevision = structuredClone(draft);
      unsafeRevision.expectedProfiles.healthFail.revision = 2_147_483_648;
      const unsafeRevisionInput = path.join(root, 'unsafe-revision.json');
      fs.writeFileSync(unsafeRevisionInput, JSON.stringify(unsafeRevision));
      const unsafeRevisionResult = spawnSync(
        process.execPath,
        [
          manifestFinalizerPath,
          unsafeRevisionInput,
          '--output',
          path.join(root, 'unsafe-revision-output.json'),
        ],
        { encoding: 'utf8' },
      );
      expect(unsafeRevisionResult.status).not.toBe(0);
      expect(unsafeRevisionResult.stderr).toContain('INVALID_PROFILE_EXPECTATION');

      const injectedSecret = structuredClone(draft);
      injectedSecret.images.candidate.repository = `registry.example.com/rca_${'a'.repeat(43)}`;
      const injectedSecretInput = path.join(root, 'injected-secret.json');
      fs.writeFileSync(injectedSecretInput, JSON.stringify(injectedSecret));
      const injectedSecretResult = spawnSync(
        process.execPath,
        [
          manifestFinalizerPath,
          injectedSecretInput,
          '--output',
          path.join(root, 'injected-secret-output.json'),
        ],
        { encoding: 'utf8' },
      );
      expect(injectedSecretResult.status).not.toBe(0);
      expect(injectedSecretResult.stderr).toContain('SECRET_LIKE_MANIFEST_VALUE');

      const overwriteResult = spawnSync(
        process.execPath,
        [manifestFinalizerPath, input, '--output', output],
        { encoding: 'utf8' },
      );
      expect(overwriteResult.status).not.toBe(0);
      expect(overwriteResult.stderr).toContain('OUTPUT_ALREADY_EXISTS');

      if (process.platform !== 'win32') {
        const foreignTarget = path.join(root, 'foreign-missing-target.json');
        const foreignOutput = path.join(root, 'foreign-dangling-output.json');
        fs.symlinkSync(foreignTarget, foreignOutput);
        const foreignResult = spawnSync(
          process.execPath,
          [manifestFinalizerPath, input, '--output', foreignOutput],
          { encoding: 'utf8' },
        );
        expect(foreignResult.status).not.toBe(0);
        expect(foreignResult.stderr).toContain('OUTPUT_ALREADY_EXISTS');
        expect(fs.lstatSync(foreignOutput).isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(foreignOutput)).toBe(foreignTarget);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps every cross-platform provenance input byte-stable on Windows', () => {
    expect(gitAttributes).toContain('*.ps1 text eol=lf');
    expect(gitAttributes).toContain('/package.json text eol=lf');
    expect(gitAttributes).toContain('/pnpm-lock.yaml text eol=lf');
    expect(gitAttributes).toContain(
      '/scripts/bootstrap-profile/unicode-15.0-assigned-ranges.json text eol=lf',
    );
  });

  it('ships a value-free secret schema and a fail-closed operator checklist', () => {
    const schema = JSON.parse(
      fs.readFileSync(
        path.join(
          ROOT,
          'scripts/acceptance/windows-bootstrap-docker.secret-bundle.schema.json',
        ),
        'utf8',
      ),
    );
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.schemaVersion.const).toBe(1);
    expect(schema.properties.tokens.additionalProperties).toBe(false);
    expect(schema.properties.modelKeys.additionalProperties).toBe(false);
    expect(schema.properties.tokens.required).toEqual([
      'network',
      'unknown',
      'revoked',
      'badCapsule',
      'valid',
      'rotate',
      'healthFail',
    ]);
    expect(schema.properties.modelKeys.required).toEqual([
      'badCapsule',
      'valid',
      'rotate',
      'healthFail',
    ]);
    expect(JSON.stringify(schema)).not.toMatch(/rca_[A-Za-z0-9_-]{43,}/);

    const checklist = fs.readFileSync(
      path.join(ROOT, 'scripts/acceptance/windows-bootstrap-docker.operator-checklist.md'),
      'utf8',
    );
    expect(checklist).toContain('finalize-windows-bootstrap-manifest.cjs');
    expect(checklist).toContain('Windows PowerShell 5.1');
    expect(checklist).toContain('PowerShell 7');
    expect(checklist).toContain('Docker Desktop');
    expect(checklist).toContain('Do not place the bundle in Git');
    expect(checklist).toContain('revoke all seven fixture Tokens');
    expect(checklist).toContain('destroy the disposable VM');
  });
});
