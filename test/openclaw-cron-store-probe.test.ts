import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const PROBE = path.join(ROOT, 'scripts/probe-openclaw-cron-store.mjs');

async function signalLifecycle(signal: 'SIGINT' | 'SIGTERM') {
  const child = spawn(process.execPath, [PROBE, '--signal-lifecycle-probe'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let ready: { workerPid: number; temp: string } | undefined;
  const readyPromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`signal probe never became ready: ${stderr}`)), 10_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const line = stdout.split('\n').find((candidate) => candidate.trim());
      if (!line || ready) return;
      ready = JSON.parse(line);
      clearTimeout(timeout);
      resolve();
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
  });
  await readyPromise;
  child.kill(signal);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* best effort test cleanup */ }
      reject(new Error(`signal probe did not exit: ${stderr}`));
    }, 10_000);
    child.once('close', (code, exitSignal) => {
      clearTimeout(timeout);
      resolve({ code, signal: exitSignal });
    });
  });
  let workerAlive = false;
  try {
    process.kill(ready!.workerPid, 0);
    workerAlive = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  return { ready: ready!, result, stderr, workerAlive };
}

describe('OpenClaw 2026.6.1 cron persistence probe', () => {
  it('locks the SQLite-backed contract and the safe offline device cleanup boundary', () => {
    const report = JSON.parse(execFileSync(process.execPath, [PROBE], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    }));

    expect(report.openclawVersion).toBe('2026.6.1');
    expect(report.storePathLabel).toMatch(/cron[/\\]jobs\.json$/);
    expect(report.canonicalBackend).toBe('sqlite');
    expect(report.canonicalStateDb).toMatch(/state[/\\]openclaw\.sqlite$/);
    expect(report.sqliteExists).toBe(true);
    expect(report.jsonExistsAfterSdkSave).toBe(false);

    // jobs.json is now a legacy migration label/input. The canonical SDK reads
    // SQLite even when that JSON file is corrupt, while RC's old reconciler
    // exits non-zero on the same irrelevant sidecar.
    expect(report.malformedJsonIgnoredByCanonicalSdk).toBe(true);
    expect(report.legacyJsonReconcilerExitCode).toBe(1);
    expect(report.legacyJsonReconcilerError).toMatch(/cannot read cron store/i);

    // Device monitor row + exact bound job id OR exact sessionKey is the only
    // deletion contract. Prefix/name matches and non-device monitor jobs stay.
    expect(new Set(report.removedJobIds)).toEqual(new Set([
      'job-device-bound',
      'job-device-orphan',
      'job-device-duplicate',
      'job-device-id-only',
    ]));
    expect(report.preservedJobIds).toEqual([
      'job-feed',
      'operator-job',
      'job-prefix-trap',
      'job-name-only',
    ]);

    const devices = report.monitorRowsAfterDisable.filter(
      (row: { source_type: string }) => row.source_type === 'device',
    );
    expect(devices).toHaveLength(3);
    expect(devices.every(
      (row: { enabled: number; gateway_job_id: string | null }) =>
        row.enabled === 0 && row.gateway_job_id === null,
    )).toBe(true);
    expect(report.monitorRowsAfterDisable.find(
      (row: { id: string }) => row.id === 'feed-monitor',
    )).toMatchObject({ enabled: 1, gateway_job_id: 'job-feed' });

    // SQLite serializes writers, but it cannot protect against a still-running
    // Gateway later persisting a stale in-memory snapshot. Cleanup therefore
    // remains safe only after Gateway stop and before restart.
    expect(report.sqliteWriterWaitMs).toBeGreaterThanOrEqual(700);
    expect(report.staleWriter).toEqual({
      removedBeforeStaleSave: true,
      resurrectedAfterStaleSave: true,
    });
    expect(report.workerLifecycle).toEqual({
      timeoutObserved: true,
      timeoutWorkerAlive: false,
      registeredWorkersAfterTimeout: 0,
    });
    expect(report.rollback.byteExact).toBe(true);
    expect(report.rollback.postRestoreDigest).toBe(report.rollback.preimageDigest);
    expect(report.rollback.postRestoreMetadata).toEqual(report.rollback.snapshotMetadata);
    expect(report.rollback.snapshotMetadata.openclawState.types).toEqual(
      expect.arrayContaining(['directory', 'file', 'symlink']),
    );
    expect(report.rollback.snapshotMetadata.openclawState.emptyDirectoryCount).toBeGreaterThan(0);
    expect(report.rollback.snapshotMetadata.openclawState.symlinkCount).toBeGreaterThan(0);
    if (process.platform === 'win32') {
      expect(report.rollback.snapshotMetadata.openclawState.posixModeCompared).toBe(false);
      expect(report.rollback.semantics).toMatch(/POSIX mode not meaningful on Windows/);
    } else {
      expect(report.rollback.snapshotMetadata.openclawState.posixModeCompared).toBe(true);
      expect(report.rollback.semantics).toMatch(/content-mode-symlink-target/);
    }
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('cleans registered workers and temp state on %s', async (signal, expectedCode) => {
    const result = await signalLifecycle(signal);
    expect(result.result).toEqual({ code: expectedCode, signal: null });
    expect(result.stderr).toMatch(new RegExp(`interrupted by ${signal}`));
    expect(result.workerAlive).toBe(false);
    expect(fs.existsSync(result.ready.temp)).toBe(false);
  });
});
