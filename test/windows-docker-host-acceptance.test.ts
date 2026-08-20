import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const ACCEPTANCE_ROOT = path.join(
  ROOT,
  'scripts',
  'acceptance',
  'windows-docker-host-smoke',
);

describe('native Windows Docker Desktop host smoke', () => {
  it('pins the published 0.8.3 multi-arch and amd64 descriptors', () => {
    const runner = fs.readFileSync(
      path.join(ACCEPTANCE_ROOT, 'Test-Wentor-Windows-Docker.ps1'),
      'utf8',
    );

    expect(runner.charCodeAt(0)).toBe(0xfeff);
    expect(runner).toContain(
      "$IndexDigest = 'sha256:fb5fe72c215c11f744ef8aa00151d1169219fee479d2e528f934c322a7806dd2'",
    );
    expect(runner).toContain(
      "$Amd64ManifestDigest = 'sha256:6b2a1ba0268b39858670677189755e5582f96c3bcad3b88ae4d372964d823a88'",
    );
    expect(runner).toContain(
      "$ExpectedRevision = 'b9bd4c2c546cddd9a53871165094394d42da1543'",
    );
    expect(runner).toContain("$ExpectedVersion = '0.8.3'");
  });

  it('covers the real host, image, health, four-volume and cleanup boundaries', () => {
    const runner = fs.readFileSync(
      path.join(ACCEPTANCE_ROOT, 'Test-Wentor-Windows-Docker.ps1'),
      'utf8',
    );
    const launcher = fs.readFileSync(
      path.join(ACCEPTANCE_ROOT, 'Run-Wentor-Windows-Docker-Test.cmd'),
      'utf8',
    );
    const readme = fs.readFileSync(
      path.join(ACCEPTANCE_ROOT, 'README.txt'),
      'utf8',
    );

    expect(runner).toContain("'host.windows-x64-admin'");
    expect(runner).toContain("'docker.linux-amd64'");
    expect(runner).toContain("'image.remote-digest-binding'");
    expect(runner).toContain("'container.healthz'");
    expect(runner).toContain("'volumes.four-mounts'");
    expect(runner).toContain("'volume.persistence-round-trip'");
    expect(runner).toContain("'container.logs-and-top'");
    expect(runner).toContain("'cleanup.task-owned-resources'");
    expect(runner).toContain("'127.0.0.1'");
    expect(runner).toContain("'--platform', 'linux/amd64'");
    expect(runner).not.toMatch(/Read-Host|pause\.exe|Console\.Read/);
    expect(launcher).toContain('powershell.exe');
    expect(launcher).toContain('pwsh.exe');
    expect(launcher).toContain('-NonInteractive');
    expect(launcher).not.toMatch(/\bpause\b/i);
    expect(Buffer.from(launcher, 'utf8').every((byte) =>
      byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126)
    )).toBe(true);
    expect(readme).toContain('does not read a Setup Token or model API key');
    expect(readme).toContain('does not remove an existing container or volume');
    expect(readme).toContain('does not replace the destructive 11-scenario T10 gate');
  });
});
