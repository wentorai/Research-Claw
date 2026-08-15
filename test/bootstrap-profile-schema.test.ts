import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(
  ROOT,
  'profiles/fixtures/thermoelectric-user-a/capsule.json',
);
const WIRE_CORPUS = path.join(
  ROOT,
  'test/fixtures/rc-bootstrap-wire-corpus-v1.json',
);
const WIRE_CORPUS_SHA256 = '9963576e9dd4d2f5376a73c41a5e5fef4913e6713732dea7e5ceefc78eb372af';
const WIRE_CORPUS_RAW = fs.readFileSync(WIRE_CORPUS);
const WIRE_CORPUS_VALUE = JSON.parse(WIRE_CORPUS_RAW.toString('utf8'));
const UNICODE15_ASSIGNED_TABLE = path.join(
  ROOT,
  'scripts/bootstrap-profile/unicode-15.0-assigned-ranges.json',
);
const UNICODE15_ASSIGNED_TABLE_SHA256 = '174ed15ca3e96cf8f93c97d0967db49bf2a603f84d1aaebc2d96f5d3c15842af';
const UNICODE15_ASSIGNED_TABLE_RAW = fs.readFileSync(UNICODE15_ASSIGNED_TABLE);
const UNICODE15_ASSIGNED_TABLE_VALUE = JSON.parse(
  UNICODE15_ASSIGNED_TABLE_RAW.toString('utf8'),
);
const require = createRequire(import.meta.url);

type ValidatedCapsule = {
  capsule: Record<string, any>;
  digest: string;
  authProfileId: string;
  skillFiles: number;
  skillBytes: number;
};

const schemaModule: {
  validateCapsuleBytes(raw: Buffer, options: { rcVersion: string }): ValidatedCapsule;
  __test: {
    unicode15ScalarIsAssigned(codePoint: number): boolean;
    unicode15CaseKey(value: string): string;
  };
} = require('../scripts/bootstrap-profile/schema.cjs');

function expectCapsuleError(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error(`expected Bootstrap Capsule validation error ${code}`);
  } catch (error) {
    expect(error).toMatchObject({
      name: 'BootstrapCapsuleValidationError',
      code,
    });
  }
}

function canonical(): Record<string, any> {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

function encode(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

function setFirstReferencePath(value: Record<string, any>, nextPath: string): void {
  const item = value.skills.items[0];
  const root = item.files.find((file: any) => file.path === 'SKILL.md');
  const reference = item.files.find((file: any) => file.path !== 'SKILL.md');
  expect(root.content).toContain(reference.path);
  root.content = root.content.replaceAll(reference.path, nextPath);
  root.sha256 = crypto.createHash('sha256').update(root.content).digest('hex');
  reference.path = nextPath;
}

function wireCaseBytes(corpus: Record<string, any>, entry: Record<string, any>): Buffer {
  const value = structuredClone(corpus.canonical);
  const rawOperations: Record<string, any>[] = [];
  for (const operation of entry.operations) {
    if (operation.op === 'rawReplace') {
      rawOperations.push(operation);
      continue;
    }
    if (operation.op === 'skillReplace') {
      const file = value.skills.items[0].files.find((candidate: any) => candidate.path === 'SKILL.md');
      expect(file.content).toContain(operation.from);
      file.content = file.content.replace(operation.from, operation.to);
      file.sha256 = crypto.createHash('sha256').update(file.content).digest('hex');
      continue;
    }
    if (operation.op === 'setProfileIdentityRepeat') {
      const profileId = operation.value.repeat(operation.repeat);
      value.profile.id = profileId;
      value.model.providerId = `custom-rc-profile-${profileId}`;
      continue;
    }
    if (operation.op === 'setSkillSlugRepeat') {
      const slug = operation.value.repeat(operation.repeat);
      const item = value.skills.items[0];
      const file = item.files.find((candidate: any) => candidate.path === 'SKILL.md');
      file.content = file.content.replace(`name: ${item.slug}`, `name: ${slug}`);
      file.sha256 = crypto.createHash('sha256').update(file.content).digest('hex');
      item.slug = slug;
      continue;
    }
    if (operation.op === 'setProviderSuffixRepeat') {
      value.model.providerId = `custom-rc-profile-${operation.value.repeat(operation.repeat)}`;
      continue;
    }
    if (operation.op === 'setReferencePath'
        || operation.op === 'setReferenceBasenameRepeat'
        || operation.op === 'setReferencePathShape') {
      let nextPath;
      if (operation.op === 'setReferencePath') nextPath = operation.value;
      else if (operation.op === 'setReferenceBasenameRepeat') {
        nextPath = `references/${operation.value.repeat(operation.repeat)}${operation.suffix}`;
      } else {
        const component = operation.component.repeat(operation.componentRepeat);
        const basename = operation.basename.repeat(operation.basenameRepeat) + operation.suffix;
        nextPath = ['references', ...Array(operation.directories).fill(component), basename].join('/');
      }
      setFirstReferencePath(value, nextPath);
      continue;
    }
    if (operation.op === 'appendSkillFile') {
      const content = operation.content;
      value.skills.items[0].files.push({
        path: operation.path,
        encoding: 'utf8',
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
        content,
      });
      continue;
    }
    if (operation.op === 'setReferenceContentRepeat') {
      const file = value.skills.items[0].files.find(
        (candidate: any) => candidate.path !== 'SKILL.md',
      );
      file.content = operation.value.repeat(operation.repeat) + (operation.suffix ?? '');
      file.sha256 = crypto.createHash('sha256').update(file.content).digest('hex');
      continue;
    }
    let target = value;
    for (const segment of operation.path.slice(0, -1)) target = target[segment];
    const key = operation.path.at(-1);
    if (operation.op === 'set') target[key] = operation.value;
    else if (operation.op === 'setRepeat') target[key] = operation.value.repeat(operation.repeat);
    else if (operation.op === 'append') target[key] += operation.value;
    else throw new Error(`unknown wire corpus operation ${operation.op}`);
  }
  let raw = JSON.stringify(value);
  for (const operation of rawOperations) {
    expect(raw).toContain(operation.from);
    raw = raw.replace(operation.from, operation.to);
  }
  return Buffer.from(raw, 'utf8');
}

describe('Bootstrap Capsule v1 schema', () => {
  it('pins one immutable raw-byte acceptance corpus shared with the API issuer', () => {
    expect(crypto.createHash('sha256').update(WIRE_CORPUS_RAW).digest('hex'))
      .toBe(WIRE_CORPUS_SHA256);
    expect(WIRE_CORPUS_VALUE.schemaVersion).toBe(1);
    expect(new Set(WIRE_CORPUS_VALUE.cases.map((entry: any) => entry.id)).size)
      .toBe(WIRE_CORPUS_VALUE.cases.length);
  });

  it('pins the Unicode 15 assigned-scalar table and normalization boundaries', () => {
    expect(crypto.createHash('sha256').update(UNICODE15_ASSIGNED_TABLE_RAW).digest('hex'))
      .toBe(UNICODE15_ASSIGNED_TABLE_SHA256);
    expect(UNICODE15_ASSIGNED_TABLE_VALUE.unicodeVersion).toBe('15.0.0');
    expect(UNICODE15_ASSIGNED_TABLE_VALUE.ranges).toHaveLength(707);
    for (const [codePoint, expected] of [
      [0x0377, true],
      [0x0378, false],
      [0xd7fb, true],
      [0xd7ff, false],
      [0xd800, false],
      [0xdfff, false],
      [0xe000, true],
      [0xf8ff, true],
      [0xf0000, true],
      [0xffffd, true],
      [0xffffe, false],
      [0x100000, true],
      [0x10fffd, true],
      [0x10fffe, false],
      [0x1c89, false],
      [0x11382, false],
      [0x113c9, false],
    ] as const) {
      expect(schemaModule.__test.unicode15ScalarIsAssigned(codePoint)).toBe(expected);
    }
    expect(schemaModule.__test.unicode15CaseKey('E\u0301Σ')).toBe('éς');
  });

  it.each(WIRE_CORPUS_VALUE.cases)('matches shared wire case $id', (entry: any) => {
    const raw = wireCaseBytes(WIRE_CORPUS_VALUE, entry);
    if (entry.expected === 'accept') {
      expect(() => schemaModule.validateCapsuleBytes(raw, { rcVersion: '0.8.3' }))
        .not.toThrow();
    } else {
      expect(() => schemaModule.validateCapsuleBytes(raw, { rcVersion: '0.8.3' }))
        .toThrowError(expect.objectContaining({
          name: 'BootstrapCapsuleValidationError',
        }));
    }
  });

  it('strictly validates the canonical raw bytes and derives only non-secret identities', () => {
    const raw = fs.readFileSync(FIXTURE);
    const result = schemaModule.validateCapsuleBytes(raw, { rcVersion: '0.8.3' });

    expect(result.digest).toBe(crypto.createHash('sha256').update(raw).digest('hex'));
    expect(result.authProfileId).toBe(
      'custom-rc-profile-thermoelectric-user-a:managed',
    );
    expect(result.skillFiles).toBe(12);
    expect(result.skillBytes).toBe(45_653);
    expect(JSON.stringify({
      digest: result.digest,
      authProfileId: result.authProfileId,
      skillFiles: result.skillFiles,
      skillBytes: result.skillBytes,
    })).not.toContain(result.capsule.secrets.modelApiKey);
  });

  it.each([
    ['unknown top-level field', 'UNKNOWN_FIELD', (c: any) => { c.extra = true; }],
    ['unknown nested field', 'UNKNOWN_FIELD', (c: any) => { c.profile.extra = true; }],
    ['wrong RC candidate version', 'RC_VERSION_MISMATCH', (c: any) => { c.profile.requiredRcVersion = '0.8.2'; }],
    ['unsafe revision', 'INVALID_REVISION', (c: any) => { c.profile.revision = 9_007_199_254_740_992; }],
    ['non-profile provider', 'INVALID_PROVIDER_ID', (c: any) => { c.model.providerId = 'openai'; }],
    ['non-HTTPS provider', 'INVALID_BASE_URL', (c: any) => { c.model.baseUrl = 'http://provider.example/v1'; }],
    ['provider URL userinfo', 'INVALID_BASE_URL', (c: any) => { c.model.baseUrl = 'https://user@provider.example/v1'; }],
    ['provider URL fragment', 'INVALID_BASE_URL', (c: any) => { c.model.baseUrl = 'https://provider.example/v1#x'; }],
    ['provider URL invalid port', 'INVALID_BASE_URL', (c: any) => { c.model.baseUrl = 'https://provider.example:bad/v1'; }],
    ['provider URL ASCII host space', 'INVALID_BASE_URL', (c: any) => { c.model.baseUrl = 'https://provider invalid/v1'; }],
    ['provider URL ASCII path space', 'INVALID_BASE_URL', (c: any) => { c.model.baseUrl = 'https://provider.invalid/a b'; }],
    ['provider URL backslash normalization', 'INVALID_BASE_URL', (c: any) => { c.model.baseUrl = 'https://provider.invalid\\v1'; }],
    ['provider URL backslash authority', 'INVALID_BASE_URL', (c: any) => { c.model.baseUrl = 'https:\\provider.invalid\\v1'; }],
    ['provider URL empty username', 'INVALID_BASE_URL', (c: any) => { c.model.baseUrl = 'https://@provider.invalid/v1'; }],
    ['provider URL empty userinfo', 'INVALID_BASE_URL', (c: any) => { c.model.baseUrl = 'https://:@provider.invalid/v1'; }],
    ['provider URL empty authority', 'INVALID_BASE_URL', (c: any) => { c.model.baseUrl = 'https:///provider.invalid'; }],
    ['provider URL non-ASCII host', 'INVALID_BASE_URL', (c: any) => { c.model.baseUrl = 'https://café.invalid/v1'; }],
    ['provider URL invalid host escape', 'INVALID_BASE_URL', (c: any) => { c.model.baseUrl = 'https://provider%zz.invalid/v1'; }],
    ['provider URL invalid path escape', 'INVALID_BASE_URL', (c: any) => { c.model.baseUrl = 'https://provider.invalid/%zz'; }],
    ['provider URL leading host hyphen', 'INVALID_BASE_URL', (c: any) => { c.model.baseUrl = 'https://-provider.invalid/v1'; }],
    ['provider URL trailing host hyphen', 'INVALID_BASE_URL', (c: any) => { c.model.baseUrl = 'https://provider-.invalid/v1'; }],
    ['provider URL empty host label', 'INVALID_BASE_URL', (c: any) => { c.model.baseUrl = 'https://provider..invalid/v1'; }],
    ['provider URL empty explicit port', 'INVALID_BASE_URL', (c: any) => { c.model.baseUrl = 'https://provider.invalid:/v1'; }],
    ['unsupported protocol', 'INVALID_PROTOCOL', (c: any) => { c.model.api = 'responses'; }],
    ['duplicate model input', 'INVALID_MODEL_INPUT', (c: any) => { c.model.model.input = ['text', 'text']; }],
    ['unsupported capability state', 'INVALID_POLICY', (c: any) => { c.policy.capabilities.settings = 'disabled'; }],
    ['empty model key', 'INVALID_MODEL_KEY', (c: any) => { c.secrets.modelApiKey = ''; }],
    ['duplicate skill slug', 'DUPLICATE_SKILL', (c: any) => { c.skills.items.push(c.skills.items[0]); }],
    ['path traversal', 'INVALID_SKILL_PATH', (c: any) => { c.skills.items[0].files[0].path = '../SKILL.md'; }],
    ['backslash path', 'INVALID_SKILL_PATH', (c: any) => { c.skills.items[0].files[0].path = 'references\\x.md'; }],
    ['duplicate file path', 'DUPLICATE_SKILL_FILE', (c: any) => { c.skills.items[0].files.push(c.skills.items[0].files[0]); }],
    ['file hash mismatch', 'SKILL_HASH_MISMATCH', (c: any) => { c.skills.items[0].files[0].content += 'drift'; }],
    ['frontmatter name mismatch', 'INVALID_SKILL_FRONTMATTER', (c: any) => {
      const file = c.skills.items[0].files.find((item: any) => item.path === 'SKILL.md');
      file.content = file.content.replace(/^name:.*$/m, 'name: another-skill');
      file.sha256 = crypto.createHash('sha256').update(file.content).digest('hex');
    }],
    ['always skill', 'INVALID_SKILL_FRONTMATTER', (c: any) => {
      const file = c.skills.items[0].files.find((item: any) => item.path === 'SKILL.md');
      file.content = file.content.replace(/^description:.*$/m, '$&\nalways: true');
      file.sha256 = crypto.createHash('sha256').update(file.content).digest('hex');
    }],
    ['nested frontmatter quotes', 'INVALID_SKILL_FRONTMATTER', (c: any) => {
      const file = c.skills.items[0].files.find((item: any) => item.path === 'SKILL.md');
      file.content = file.content.replace(/^description:.*$/m, 'description: "\'nested but otherwise valid\'"');
      file.sha256 = crypto.createHash('sha256').update(file.content).digest('hex');
    }],
    ['frontmatter C0 line separator', 'INVALID_SKILL_FRONTMATTER', (c: any) => {
      const file = c.skills.items[0].files.find((item: any) => item.path === 'SKILL.md');
      file.content = file.content.replace(/^description:.*$/m, 'description: valid\fhidden: field');
      file.sha256 = crypto.createHash('sha256').update(file.content).digest('hex');
    }],
    ['frontmatter Unicode line separator', 'INVALID_SKILL_FRONTMATTER', (c: any) => {
      const file = c.skills.items[0].files.find((item: any) => item.path === 'SKILL.md');
      file.content = file.content.replace(/^description:.*$/m, 'description: valid\u2028hidden: field');
      file.sha256 = crypto.createHash('sha256').update(file.content).digest('hex');
    }],
    ['broken Markdown link', 'BROKEN_SKILL_LINK', (c: any) => {
      const file = c.skills.items[0].files.find((item: any) => item.path === 'SKILL.md');
      file.content += '\n[missing](references/not-present.md)\n';
      file.sha256 = crypto.createHash('sha256').update(file.content).digest('hex');
    }],
  ])('rejects %s with a stable reason', (_label, code, mutate) => {
    const capsule = canonical();
    mutate(capsule);
    expectCapsuleError(
      () => schemaModule.validateCapsuleBytes(encode(capsule), { rcVersion: '0.8.3' }),
      code,
    );
  });

  it('rejects every non-LF C0, DEL, and alternate line separator in frontmatter', () => {
    const codePoints = [
      ...Array.from({ length: 32 }, (_unused, codePoint) => codePoint)
        .filter((codePoint) => codePoint !== 0x0a),
      0x7f, 0x85, 0x2028, 0x2029,
    ];
    for (const codePoint of codePoints) {
      const value = canonical();
      const file = value.skills.items[0].files.find((item: any) => item.path === 'SKILL.md');
      file.content = file.content.replace(
        /^description:.*$/m,
        `description: valid${String.fromCodePoint(codePoint)}hidden: field`
      );
      file.sha256 = crypto.createHash('sha256').update(file.content).digest('hex');
      expectCapsuleError(
        () => schemaModule.validateCapsuleBytes(encode(value), { rcVersion: '0.8.3' }),
        'INVALID_SKILL_FRONTMATTER',
      );
    }
  });

  it('rejects the explicit JS/Python-union wire whitespace set at secret boundaries', () => {
    const codePoints = [
      ...Array.from({ length: 5 }, (_unused, index) => 0x09 + index),
      ...Array.from({ length: 5 }, (_unused, index) => 0x1c + index),
      0x85, 0xa0, 0x1680,
      ...Array.from({ length: 11 }, (_unused, index) => 0x2000 + index),
      0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
    ];
    for (const codePoint of codePoints) {
      for (const side of ['leading', 'trailing']) {
        const value = canonical();
        const whitespace = String.fromCodePoint(codePoint);
        value.secrets.modelApiKey = side === 'leading'
          ? `${whitespace}${value.secrets.modelApiKey}`
          : `${value.secrets.modelApiKey}${whitespace}`;
        expectCapsuleError(
          () => schemaModule.validateCapsuleBytes(encode(value), { rcVersion: '0.8.3' }),
          'INVALID_MODEL_KEY',
        );
      }
    }
  });

  it('rejects every Windows reserved basename, including mixed case and extensions', () => {
    const names = [
      'CON', 'PRN', 'AUX', 'NUL',
      ...Array.from({ length: 9 }, (_unused, index) => `COM${index + 1}`),
      ...Array.from({ length: 9 }, (_unused, index) => `LPT${index + 1}`),
    ];
    for (const name of names) {
      const value = canonical();
      setFirstReferencePath(value, `references/${name.toLowerCase()}.notes.md`);
      expectCapsuleError(
        () => schemaModule.validateCapsuleBytes(encode(value), { rcVersion: '0.8.3' }),
        'INVALID_SKILL_PATH',
      );
    }
  });

  it('rejects all explicitly dangerous format and bidi controls in path components', () => {
    const codePoints = [
      0x00ad, 0x061c, 0x180e,
      ...Array.from({ length: 5 }, (_unused, index) => 0x200b + index),
      ...Array.from({ length: 5 }, (_unused, index) => 0x202a + index),
      ...Array.from({ length: 16 }, (_unused, index) => 0x2060 + index),
      0xfeff,
    ];
    for (const codePoint of codePoints) {
      const value = canonical();
      setFirstReferencePath(
        value,
        `references/meth${String.fromCodePoint(codePoint)}od.md`,
      );
      expectCapsuleError(
        () => schemaModule.validateCapsuleBytes(encode(value), { rcVersion: '0.8.3' }),
        'INVALID_SKILL_PATH',
      );
    }
  });

  it('enforces the decoded Envelope and content ceilings before mutation', () => {
    expectCapsuleError(
      () => schemaModule.validateCapsuleBytes(Buffer.alloc(2 * 1024 * 1024 + 1), {
        rcVersion: '0.8.3',
      }),
      'CAPSULE_TOO_LARGE',
    );

    const key = canonical();
    key.secrets.modelApiKey = 'x'.repeat(16 * 1024 + 1);
    expectCapsuleError(
      () => schemaModule.validateCapsuleBytes(encode(key), { rcVersion: '0.8.3' }),
      'INVALID_MODEL_KEY',
    );

    const file = canonical();
    const target = file.skills.items[0].files[0];
    target.content = 'x'.repeat(256 * 1024 + 1);
    target.sha256 = crypto.createHash('sha256').update(target.content).digest('hex');
    expectCapsuleError(
      () => schemaModule.validateCapsuleBytes(encode(file), { rcVersion: '0.8.3' }),
      'SKILL_FILE_TOO_LARGE',
    );
  });

  it.each([
    'https://provider.invalid/v1',
    'https://provider.invalid:443/v1',
    'https://provider.invalid/a%20b',
    'https://127.0.0.1/v1',
    'https://[2001:db8::1]:443/v1',
    'https://provider.invalid./v1',
  ])('accepts canonical provider URL %s', (baseUrl) => {
    const capsule = canonical();
    capsule.model.baseUrl = baseUrl;
    expect(schemaModule.validateCapsuleBytes(encode(capsule), { rcVersion: '0.8.3' }).capsule.model.baseUrl)
      .toBe(baseUrl);
  });

  it('measures the DNS hostname limit without the optional root dot', () => {
    const label = 'a'.repeat(63);
    const host253 = [label, label, label, 'a'.repeat(61)].join('.');
    expect(host253).toHaveLength(253);
    const accepted = canonical();
    accepted.model.baseUrl = `https://${host253}./v1`;
    expect(schemaModule.validateCapsuleBytes(encode(accepted), { rcVersion: '0.8.3' }).capsule.model.baseUrl)
      .toBe(accepted.model.baseUrl);

    const rejected = canonical();
    rejected.model.baseUrl = `https://${host253}a./v1`;
    expectCapsuleError(
      () => schemaModule.validateCapsuleBytes(encode(rejected), { rcVersion: '0.8.3' }),
      'INVALID_BASE_URL',
    );
  });

  it('uses JavaScript UTF-16 code-unit limits and rejects escaped lone surrogates', () => {
    const accepted = canonical();
    accepted.model.model.id = '💩'.repeat(128);
    expect(schemaModule.validateCapsuleBytes(encode(accepted), { rcVersion: '0.8.3' }).capsule.model.model.id)
      .toHaveLength(256);

    const rejected = canonical();
    rejected.model.model.id = '💩'.repeat(129);
    expectCapsuleError(
      () => schemaModule.validateCapsuleBytes(encode(rejected), { rcVersion: '0.8.3' }),
      'INVALID_MODEL',
    );

    const raw = fs.readFileSync(FIXTURE, 'utf8').replace(
      'thermoelectric-fixture-model',
      '\\ud800',
    );
    expectCapsuleError(
      () => schemaModule.validateCapsuleBytes(Buffer.from(raw), { rcVersion: '0.8.3' }),
      'INVALID_JSON',
    );
  });

  it.each([
    ['"revision": 1', '"revision": 1.0'],
    ['"revision": 1', '"revision": 1e0'],
    ['"contextWindow": 128000', '"contextWindow": 128000.0'],
    ['"maxTokens": 8192', '"maxTokens": 8192e0'],
  ])('rejects non-integer JSON number lexeme %s', (before, after) => {
    const raw = fs.readFileSync(FIXTURE, 'utf8').replace(before, after);
    expect(raw).toContain(after);
    expectCapsuleError(
      () => schemaModule.validateCapsuleBytes(Buffer.from(raw), { rcVersion: '0.8.3' }),
      'INVALID_NUMBER_LEXEME',
    );
  });
});

describe('applier local-only boundary', () => {
  it('does not expose token/network arguments or import network clients', () => {
    const entry = fs.readFileSync(
      path.join(ROOT, 'scripts/apply-bootstrap-profile.cjs'),
      'utf8',
    );
    const modules = fs.readdirSync(path.join(ROOT, 'scripts/bootstrap-profile'))
      .filter((name) => /\.(?:cjs|mjs)$/.test(name))
      .map((name) => fs.readFileSync(path.join(ROOT, 'scripts/bootstrap-profile', name), 'utf8'))
      .join('\n');
    const source = `${entry}\n${modules}`;

    expect(source).not.toMatch(/--auth-token|setup[_-]?token|Authorization\s*:/i);
    expect(source).not.toMatch(/\bfetch\s*\(|axios|node:https|node:http|curl\b|wget\b/);
  });
});
