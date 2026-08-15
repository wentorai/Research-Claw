import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const ADMISSION = path.join(ROOT, 'scripts/bootstrap-profile/entrypoint-admission.cjs');
const TX = 'tx-11111111-1111-4111-8111-111111111111';

function run(pendingTransaction: unknown, admitted?: string) {
  return spawnSync(process.execPath, [ADMISSION], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      ...(admitted ? { RC_BOOTSTRAP_TX_ID: admitted } : {}),
    },
    input: JSON.stringify({ pendingTransaction }),
    encoding: 'utf8',
  });
}

describe('Docker entrypoint Bootstrap Profile admission', () => {
  it('admits ordinary startup when no transaction is pending', () => {
    expect(run(null).status).toBe(0);
  });

  it.each(['applied', 'verified'])(
    'admits only the exact installer tx-id in %s state',
    (state) => {
      expect(run({ txId: TX, state }, TX).status).toBe(0);
      expect(run({ txId: TX, state }).status).toBe(42);
      expect(run({ txId: TX, state }, 'tx-22222222-2222-4222-8222-222222222222').status)
        .toBe(42);
    },
  );

  it.each(['staged', 'preparing', 'committed', 'rolled-back'])(
    'rejects installer admission for non-runnable state %s',
    (state) => {
      expect(run({ txId: TX, state }, TX).status).toBe(42);
    },
  );

  it('rejects malformed or oversized status input without echoing it', () => {
    const malformed = spawnSync(process.execPath, [ADMISSION], {
      input: '{not-json', encoding: 'utf8', env: { PATH: process.env.PATH ?? '' },
    });
    expect(malformed.status).toBe(64);
    expect(`${malformed.stdout}${malformed.stderr}`).toBe('');
    const oversized = spawnSync(process.execPath, [ADMISSION], {
      input: 'x'.repeat(65 * 1024), encoding: 'utf8', env: { PATH: process.env.PATH ?? '' },
    });
    expect(oversized.status).toBe(64);
  });
});
