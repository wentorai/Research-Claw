import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const INSTALLER = path.join(ROOT, 'scripts', 'install-windows.ps1');
const AUDITOR = path.join(ROOT, 'scripts', 'audit_windows_bundle.py');
const ACCEPTANCE_ROOT = path.join(
  ROOT,
  'scripts',
  'acceptance',
  'windows-offline-ffmpeg',
);

describe('native Windows offline FFmpeg runtime', () => {
  it('pins and functionally verifies the bundled Windows x64 runtime', () => {
    const source = fs.readFileSync(INSTALLER, 'utf8');

    expect(source).toContain("$FfmpegVersion = '9.0.1'");
    expect(source).toContain(
      "$FfmpegArchive = 'ffmpeg-release-essentials-9.0.1.7z'",
    );
    expect(source).toContain(
      "$FfmpegSha256 = '49a73bdf0850092a252ac4641d922f3048d63ed113e196cc65ce1e4f7fb33e85'",
    );
    expect(source).toContain(
      "$FfmpegExeSha256 = '72a489eccd008c2ec2c0a5856c5c75bc3d8bbfa90166c4566865c246445e6aa3'",
    );
    expect(source).toContain(
      "$FfprobeExeSha256 = '19202b23c0043f15ad1b7bce2344f406fd52bd6efd8f995ce02e7392a1cec52f'",
    );
    expect(source).toContain('function Ensure-Ffmpeg');
    expect(source).toContain("'ffmpeg-9.0.1-essentials_build\\bin\\ffmpeg.exe'");
    expect(source).toContain("'ffmpeg-9.0.1-essentials_build\\bin\\ffprobe.exe'");
    expect(source).toContain("'anullsrc=r=8000:cl=mono'");
    expect(source).toContain("'-show_entries', 'stream=codec_name,sample_rate'");
    expect(source).toContain("'^ffmpeg version 9\\.0\\.1(?:-|\\s|$)'");
    expect(source).toContain("'^ffprobe version 9\\.0\\.1(?:-|\\s|$)'");
    expect(source).toContain('Get-Sha256 $ffmpegExe');
    expect(source).toContain('Get-Sha256 $ffprobeExe');
    expect(source).toContain('Add-ProcessPath $binRoot');

    const gitIndex = source.indexOf('$bash = Ensure-GitBash');
    const ffmpegIndex = source.indexOf('$ffmpegBin = Ensure-Ffmpeg');
    const bashIndex = source.indexOf('& $bash @arguments');
    expect(gitIndex).toBeGreaterThan(0);
    expect(ffmpegIndex).toBeGreaterThan(gitIndex);
    expect(ffmpegIndex).toBeLessThan(bashIndex);
  });

  it('requires the exact FFmpeg archive in every final offline ZIP', () => {
    const source = fs.readFileSync(AUDITOR, 'utf8');

    expect(source).toContain('runtime/ffmpeg-release-essentials-9.0.1.7z');
    expect(source).toContain(
      '49a73bdf0850092a252ac4641d922f3048d63ed113e196cc65ce1e4f7fb33e85',
    );
  });

  it('ships a no-input offline Windows acceptance runner for the same bytes', () => {
    const runner = fs.readFileSync(
      path.join(ACCEPTANCE_ROOT, 'Install-Test-Wentor-Ffmpeg.ps1'),
      'utf8',
    );
    const launcher = fs.readFileSync(
      path.join(ACCEPTANCE_ROOT, 'Run-Wentor-Ffmpeg-Test.cmd'),
      'utf8',
    );
    const bootstrap = fs.readFileSync(
      path.join(ACCEPTANCE_ROOT, 'Invoke-Wentor-Ffmpeg-Test.ps1'),
      'utf8',
    );
    const readme = fs.readFileSync(
      path.join(ACCEPTANCE_ROOT, 'README.txt'),
      'utf8',
    );

    expect(runner.charCodeAt(0)).toBe(0xfeff);
    expect(runner).toContain("$FfmpegVersion = '9.0.1'");
    expect(runner).toContain(
      "$FfmpegArchiveSha256 = '49a73bdf0850092a252ac4641d922f3048d63ed113e196cc65ce1e4f7fb33e85'",
    );
    expect(runner).toContain(
      "$FfmpegExeSha256 = '72a489eccd008c2ec2c0a5856c5c75bc3d8bbfa90166c4566865c246445e6aa3'",
    );
    expect(runner).toContain(
      "$FfprobeExeSha256 = '19202b23c0043f15ad1b7bce2344f406fd52bd6efd8f995ce02e7392a1cec52f'",
    );
    expect(runner).toContain("'anullsrc=r=8000:cl=mono'");
    expect(runner).toContain("'stream=codec_name,sample_rate'");
    expect(runner).toContain("'^ffmpeg version 9\\.0\\.1(?:-|\\s|$)'");
    expect(runner).toContain("'^ffprobe version 9\\.0\\.1(?:-|\\s|$)'");
    expect(runner).toContain("'isolated media round-trip'");
    expect(runner).toContain('Wentor-FFmpeg-Test-');
    expect(runner).toContain('steps = $steps.ToArray()');
    expect(runner).not.toContain('steps = @($steps)');
    expect(runner).not.toMatch(/Read-Host|pause\.exe|Console\.Read/);
    expect(runner).not.toMatch(/\bexit\s+[01]\b/i);
    expect(bootstrap.charCodeAt(0)).toBe(0xfeff);
    expect(bootstrap).toContain('Start-Transcript');
    expect(bootstrap).toContain('WENTOR_FFMPEG_BOOTSTRAP_LOG=');
    expect(bootstrap).toContain('& $RunnerPath');
    expect(bootstrap).not.toMatch(/Read-Host|pause\.exe|Console\.Read/);
    expect(launcher).toContain('-NonInteractive');
    expect(launcher).toContain('Invoke-Wentor-Ffmpeg-Test.ps1');
    expect(launcher).toContain('Wentor-FFmpeg-Bootstrap-Desktop5-');
    expect(launcher).toContain('Wentor-FFmpeg-Bootstrap-Core7-');
    expect(launcher).toContain('notepad.exe');
    expect(launcher).toContain('timeout.exe /t 300 /nobreak');
    expect(launcher).not.toMatch(/\bpause\b/i);
    expect(Buffer.from(launcher, 'utf8').every((byte) =>
      byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126)
    )).toBe(true);
    expect(readme).toContain('does not read a Setup Token or model API key');
    expect(readme).toContain('does not install or start Research-Claw');
  });
});
