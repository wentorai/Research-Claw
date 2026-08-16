import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  assertCanonicalAuthSecretPlacement,
  assertNoUnexpectedStateSecretCopies,
} = require('../scripts/bootstrap-profile/secret-copy-scan.cjs');

const CHUNK_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const SECRET = 'RC_SCAN_KEY_1234'; // Exactly 16 UTF-8 bytes.
const PROVIDER = 'custom-rc-profile-test';
const AUTH_PROFILE_ID = `${PROVIDER}:managed`;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeStateRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bootstrap-secret-scan-'));
  temporaryRoots.push(root);
  if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
  return root;
}

function canonicalAuth(key = SECRET): Record<string, unknown> {
  return {
    version: 1,
    profiles: {
      [AUTH_PROFILE_ID]: { type: 'api_key', provider: PROVIDER, key },
      'user-provider:manual': {
        type: 'api_key', provider: 'user-provider', key: 'UNRELATED_USER_KEY',
      },
    },
  };
}

describe('typed canonical auth secret assertion', () => {
  it('accepts exactly one key at the canonical managed API-key profile', () => {
    expect(assertCanonicalAuthSecretPlacement({
      authStore: canonicalAuth(),
      preimageAuthStore: {
        version: 1,
        profiles: {
          'user-provider:manual': {
            type: 'api_key', provider: 'user-provider', key: 'UNRELATED_USER_KEY',
          },
        },
      },
      authProfileId: AUTH_PROFILE_ID,
      providerId: PROVIDER,
      secret: SECRET,
    })).toEqual({ occurrences: 1, preexistingAliases: 0 });
  });

  it('accepts an unchanged preexisting manual profile that uses the managed key', () => {
    const manualProfile = { type: 'api_key', provider: 'deepseek', key: SECRET };
    const preimageAuthStore = {
      version: 1,
      profiles: { 'deepseek:manual': manualProfile },
    };
    const authStore = canonicalAuth();
    authStore.profiles['deepseek:manual'] = { ...manualProfile };

    expect(assertCanonicalAuthSecretPlacement({
      authStore,
      preimageAuthStore,
      authProfileId: AUTH_PROFILE_ID,
      providerId: PROVIDER,
      secret: SECRET,
    })).toEqual({ occurrences: 2, preexistingAliases: 1 });
  });

  it('accepts an unchanged managed profile in the preimage on an idempotent rerun', () => {
    const authStore = canonicalAuth();
    expect(assertCanonicalAuthSecretPlacement({
      authStore,
      preimageAuthStore: JSON.parse(JSON.stringify(authStore)),
      authProfileId: AUTH_PROFILE_ID,
      providerId: PROVIDER,
      secret: SECRET,
    })).toEqual({ occurrences: 1, preexistingAliases: 0 });
  });

  it('accepts removal of the canonical previous managed profile during a profile switch', () => {
    const authStore = canonicalAuth();
    const oldProvider = 'custom-rc-profile-old-profile';
    const oldAuthProfileId = `${oldProvider}:managed`;
    const preimageAuthStore = {
      version: 1,
      profiles: {
        [oldAuthProfileId]: { type: 'api_key', provider: oldProvider, key: SECRET },
        'user-provider:manual': {
          type: 'api_key', provider: 'user-provider', key: 'UNRELATED_USER_KEY',
        },
      },
    };

    expect(assertCanonicalAuthSecretPlacement({
      authStore,
      preimageAuthStore,
      retiredAuthProfileId: oldAuthProfileId,
      authProfileId: AUTH_PROFILE_ID,
      providerId: PROVIDER,
      secret: SECRET,
    })).toEqual({
      occurrences: 1,
      preexistingAliases: 0,
      retiredManagedProfiles: 1,
    });
  });

  it('rejects removal of an unbound managed-looking profile from the preimage', () => {
    const oldProvider = 'custom-rc-profile-unowned';
    const oldAuthProfileId = `${oldProvider}:managed`;
    expect(() => assertCanonicalAuthSecretPlacement({
      authStore: canonicalAuth(),
      preimageAuthStore: {
        version: 1,
        profiles: {
          [oldAuthProfileId]: { type: 'api_key', provider: oldProvider, key: SECRET },
        },
      },
      retiredAuthProfileId: 'custom-rc-profile-different:managed',
      authProfileId: AUTH_PROFILE_ID,
      providerId: PROVIDER,
      secret: SECRET,
    })).toThrow(expect.objectContaining({ code: 'SECRET_COPY_DETECTED' }));
  });

  it.each([
    ['a new post-stage alias', (current: any) => {
      current.profiles['late-provider:manual'] = {
        type: 'api_key', provider: 'late-provider', key: SECRET,
      };
    }],
    ['a changed preexisting alias', (current: any) => {
      current.profiles['deepseek:manual'].metadata = 'changed';
    }],
    ['a deleted preexisting alias', (current: any) => {
      delete current.profiles['deepseek:manual'];
    }],
    ['the key in auth metadata', (current: any) => {
      current.metadata = { copiedKey: SECRET };
    }],
  ] as const)('rejects %s', (_label, mutate) => {
    const manualProfile = { type: 'api_key', provider: 'deepseek', key: SECRET };
    const preimageAuthStore = {
      version: 1,
      profiles: { 'deepseek:manual': manualProfile },
    };
    const authStore = canonicalAuth() as any;
    authStore.profiles['deepseek:manual'] = { ...manualProfile };
    mutate(authStore);

    expect(() => assertCanonicalAuthSecretPlacement({
      authStore,
      preimageAuthStore,
      authProfileId: AUTH_PROFILE_ID,
      providerId: PROVIDER,
      secret: SECRET,
    })).toThrow(expect.objectContaining({ code: 'SECRET_COPY_DETECTED' }));
  });

  it.each([
    ['missing canonical profile', (auth: any) => { delete auth.profiles[AUTH_PROFILE_ID]; }],
    ['wrong credential type', (auth: any) => { auth.profiles[AUTH_PROFILE_ID].type = 'token'; }],
    ['wrong provider', (auth: any) => { auth.profiles[AUTH_PROFILE_ID].provider = 'user-provider'; }],
    ['extra canonical field', (auth: any) => { auth.profiles[AUTH_PROFILE_ID].copy = SECRET; }],
    ['duplicate JSON value', (auth: any) => { auth.metadata = { copiedKey: SECRET }; }],
  ] as const)('rejects %s without exposing the key', (_label, mutate) => {
    const auth = canonicalAuth();
    mutate(auth);
    let caught: any;
    try {
      assertCanonicalAuthSecretPlacement({
        authStore: auth,
        preimageAuthStore: { version: 1, profiles: {} },
        authProfileId: AUTH_PROFILE_ID,
        providerId: PROVIDER,
        secret: SECRET,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'SECRET_COPY_DETECTED' });
    expect(String(caught?.message)).not.toContain(SECRET);
  });

  it('fails closed when the credential store itself is not the OpenClaw v1 shape', () => {
    const auth = canonicalAuth() as any;
    auth.version = 2;
    expect(() => assertCanonicalAuthSecretPlacement({
      authStore: auth,
      preimageAuthStore: { version: 1, profiles: {} },
      authProfileId: AUTH_PROFILE_ID,
      providerId: PROVIDER,
      secret: SECRET,
    })).toThrow(expect.objectContaining({ code: 'SECRET_SCAN_FAILED' }));
  });
});

describe('bounded raw secret-copy scan', () => {
  it.each(['a', 'common-word', '密钥'])('rejects an invalid sub-16-byte secret instead of substring scanning %j', (secret) => {
    const root = makeStateRoot();
    fs.writeFileSync(path.join(root, 'ordinary.txt'), `ordinary text contains ${secret}\n`, { mode: 0o600 });
    expect(() => assertNoUnexpectedStateSecretCopies({ stateDir: root, secret }))
      .toThrow(expect.objectContaining({ code: 'SECRET_SCAN_FAILED' }));
  });

  it('rejects a secret above the existing 16 KiB wire limit before scanning', () => {
    const root = makeStateRoot();
    expect(() => assertNoUnexpectedStateSecretCopies({
      stateDir: root,
      secret: 'x'.repeat((16 * 1024) + 1),
    })).toThrow(expect.objectContaining({ code: 'SECRET_SCAN_FAILED' }));
  });

  it('does not flag ordinary text when the complete validated key is absent', () => {
    const root = makeStateRoot();
    const ordinary = 'RC_SCAN appears in prose, and KEY_1234 appears elsewhere, but not the complete key.\n';
    fs.writeFileSync(
      path.join(root, 'ordinary.txt'),
      ordinary,
      { mode: 0o600 },
    );
    expect(assertNoUnexpectedStateSecretCopies({ stateDir: root, secret: SECRET }))
      .toEqual({ filesScanned: 1, bytesScanned: Buffer.byteLength(ordinary) });
  });

  it.skipIf(process.platform === 'win32')(
    'accepts but never follows OpenClaw-owned top-level plugin-skill symlinks',
    () => {
      const root = makeStateRoot();
      const external = makeStateRoot();
      fs.writeFileSync(path.join(external, 'SKILL.md'), 'ordinary external Skill\n', { mode: 0o600 });
      const generated = path.join(root, 'plugin-skills');
      fs.mkdirSync(generated, { mode: 0o700 });
      fs.symlinkSync(external, path.join(generated, 'browser-automation'));

      expect(assertNoUnexpectedStateSecretCopies({ stateDir: root, secret: SECRET }))
        .toEqual({ filesScanned: 0, bytesScanned: Buffer.byteLength(external) });
    },
  );

  it.skipIf(process.platform === 'win32')('still fails closed on symlinks outside plugin-skills', () => {
    const root = makeStateRoot();
    const external = makeStateRoot();
    fs.symlinkSync(external, path.join(root, 'unexpected-link'));
    expect(() => assertNoUnexpectedStateSecretCopies({ stateDir: root, secret: SECRET }))
      .toThrow(expect.objectContaining({ code: 'SECRET_SCAN_FAILED' }));
  });

  it.skipIf(process.platform === 'win32')('rejects a generated symlink target string containing the key', () => {
    const root = makeStateRoot();
    const generated = path.join(root, 'plugin-skills');
    fs.mkdirSync(generated, { mode: 0o700 });
    fs.symlinkSync(`/fixture/${SECRET}`, path.join(generated, 'leaking-skill'));
    expect(() => assertNoUnexpectedStateSecretCopies({ stateDir: root, secret: SECRET }))
      .toThrow(expect.objectContaining({ code: 'SECRET_COPY_DETECTED' }));
  });

  it('detects the complete key across a 64 KiB chunk boundary', () => {
    const root = makeStateRoot();
    const prefix = Buffer.alloc(CHUNK_BYTES - 7, 0x78);
    fs.writeFileSync(
      path.join(root, 'boundary.bin'),
      Buffer.concat([prefix, Buffer.from(SECRET), Buffer.from('tail')]),
      { mode: 0o600 },
    );
    expect(() => assertNoUnexpectedStateSecretCopies({ stateDir: root, secret: SECRET }))
      .toThrow(expect.objectContaining({ code: 'SECRET_COPY_DETECTED' }));
  });

  it('detects an exact JSON string value even when JSON escaping hides the raw bytes', () => {
    const root = makeStateRoot();
    const escapedKey = 'RC_SECRET_\nVALUE_123';
    fs.writeFileSync(
      path.join(root, 'escaped.json'), `${JSON.stringify({ nested: { key: escapedKey } })}\n`,
      { mode: 0o600 },
    );
    expect(() => assertNoUnexpectedStateSecretCopies({ stateDir: root, secret: escapedKey }))
      .toThrow(expect.objectContaining({ code: 'SECRET_COPY_DETECTED' }));
  });

  it('uses UTF-8 byte length and scans a validated multibyte key shorter than 16 code units', () => {
    const root = makeStateRoot();
    const multibyteKey = '密钥安全密钥安全'; // 24 UTF-8 bytes, 8 code units.
    fs.writeFileSync(path.join(root, 'multibyte.bin'), Buffer.from(`before${multibyteKey}after`), {
      mode: 0o600,
    });
    expect(() => assertNoUnexpectedStateSecretCopies({ stateDir: root, secret: multibyteKey }))
      .toThrow(expect.objectContaining({ code: 'SECRET_COPY_DETECTED' }));
  });

  it('fails before reading a file that exceeds the 512 MiB aggregate byte budget', () => {
    const root = makeStateRoot();
    const sparse = path.join(root, 'oversize.bin');
    const descriptor = fs.openSync(sparse, 'w', 0o600);
    try {
      fs.ftruncateSync(descriptor, MAX_TOTAL_BYTES + 1);
    } finally {
      fs.closeSync(descriptor);
    }
    expect(() => assertNoUnexpectedStateSecretCopies({ stateDir: root, secret: SECRET }))
      .toThrow(expect.objectContaining({ code: 'SECRET_SCAN_LIMIT_EXCEEDED' }));
  });
});
