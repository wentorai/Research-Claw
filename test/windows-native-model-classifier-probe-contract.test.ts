import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const PROBE_ROOT = path.join(
  ROOT,
  'scripts',
  'acceptance',
  'windows-native-model-classifier-probe',
);

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

describe('Windows v20 model classifier probe', () => {
  it('self-tests only stable status constants and secret-shape rejection', () => {
    const output = execFileSync(process.execPath, [
      path.join(PROBE_ROOT, 'probe-windows-model-classifier.cjs'),
      '--self-test',
    ], { cwd: ROOT, encoding: 'utf8' });
    expect(JSON.parse(output)).toEqual({ ok: true });
  });

  it('pins the exact production helper without printing raw provider errors', () => {
    const helper = path.join(ROOT, 'scripts', 'bootstrap-profile', 'model-probe.cjs');
    const probe = fs.readFileSync(
      path.join(PROBE_ROOT, 'probe-windows-model-classifier.cjs'),
      'utf8',
    );
    expect(probe).toContain(`const HELPER_SHA256 = '${sha256(helper)}';`);
    expect(probe).toContain("RC_MODEL_PROBE_DEBUG: '0'");
    expect(probe).not.toMatch(/rawProviderError|providerError|stderr:\s*result/u);
  });

  it('requires no token, key, pause, or keyboard input', () => {
    const source = fs.readdirSync(PROBE_ROOT)
      .map((name) => fs.readFileSync(path.join(PROBE_ROOT, name), 'utf8'))
      .join('\n');
    expect(source).not.toMatch(/--auth-token|setup token file|model api key value/iu);
    expect(source).not.toMatch(/pause\s*>?nul|Read-Host|Console\.Read/iu);
    expect(source).not.toMatch(/rca_[A-Za-z0-9_-]{43,}/u);
    expect(source).not.toMatch(/(^|[^A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{16,}/mu);
  });
});
