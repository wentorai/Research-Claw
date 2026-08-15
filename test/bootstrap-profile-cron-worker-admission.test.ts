import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const APPLIER_MODULE = path.join(ROOT, 'scripts/bootstrap-profile/applier.cjs');

describe('cron worker admission and lifecycle publication', () => {
  it('validates encoded input and the minimal worker environment before publishing an active epoch', () => {
    const source = fs.readFileSync(APPLIER_MODULE, 'utf8');
    const start = source.indexOf('function runCronWorker(');
    const end = source.indexOf('\nasync function inspectCronState', start);
    const body = source.slice(start, end);
    const encoded = body.indexOf('Buffer.from(JSON.stringify(payload ?? {}))');
    const encodedLimit = body.indexOf('encoded.length > CRON_WORKER_LIMIT');
    const environment = body.indexOf('minimalWorkerEnv(');
    const publication = body.indexOf('openCronWorkerLifecycle(paths, txId)');
    const spawn = body.indexOf('child = spawn(');
    const childError = body.indexOf("child.once('error'");
    const childClose = body.indexOf("child.once('close'");
    const errorHandler = body.slice(childError, childClose);
    const stderrHandler = body.slice(
      body.indexOf("child.stderr.on('data'"),
      body.indexOf("child.stdin.on('error'"),
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(encoded).toBeGreaterThanOrEqual(0);
    expect(encodedLimit).toBeGreaterThan(encoded);
    expect(environment).toBeGreaterThanOrEqual(0);
    expect(publication).toBeGreaterThanOrEqual(0);
    expect(spawn).toBeGreaterThan(publication);
    expect(encoded).toBeLessThan(publication);
    expect(encodedLimit).toBeLessThan(publication);
    expect(environment).toBeLessThan(publication);
    expect(childError).toBeGreaterThan(spawn);
    expect(childClose).toBeGreaterThan(childError);
    expect(errorHandler).not.toContain('finish(');
    expect(stderrHandler).toContain("child.kill('SIGKILL')");
  });
});
