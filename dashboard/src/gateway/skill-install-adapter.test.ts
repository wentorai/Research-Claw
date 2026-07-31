import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIG_GET_RESPONSE,
  CONFIG_GET_UPLOAD_ENABLED_RESPONSE,
  SKILLS_CLAWHUB_INSTALL_RESPONSE,
  SKILLS_DETAIL_RESPONSE,
  SKILLS_SEARCH_RESPONSE,
} from '../__fixtures__/gateway-payloads/extensions-responses';
import {
  SkillArchiveValidationError,
  createSkillInstallAdapter,
  inspectSkillArchiveBudget,
} from './skill-install-adapter';

const request = vi.fn();

async function makeMedicalBundle(): Promise<File> {
  const zip = new JSZip();
  zip.file(
    'clinical-trial-review/SKILL.md',
    [
      '---',
      'name: Clinical Trial Review',
      'description: Review clinical trial evidence',
      'metadata:',
      '  openclaw:',
      '    os: [darwin]',
      '    requires:',
      '      bins: [python3]',
      '      env: [NCBI_API_KEY]',
      '---',
      '# Clinical Trial Review',
    ].join('\n'),
  );
  zip.file('clinical-trial-review/references/checklist.md', '# Checklist');
  zip.file(
    'medical-literature-map/SKILL.md',
    [
      '---',
      'name: Medical Literature Map',
      'description: Build a biomedical evidence map',
      '---',
      '# Medical Literature Map',
    ].join('\n'),
  );
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return new File(
    [Uint8Array.from(bytes).buffer],
    'medical-skills.zip',
    { type: 'application/zip' },
  );
}

beforeEach(() => {
  request.mockReset();
});

describe('SkillInstallAdapter — OpenClaw 2026.6.1 parity', () => {
  it('reads the archive-upload feature gate from config.get without inventing support', async () => {
    request
      .mockResolvedValueOnce(CONFIG_GET_RESPONSE)
      .mockResolvedValueOnce(CONFIG_GET_UPLOAD_ENABLED_RESPONSE);
    const adapter = createSkillInstallAdapter({ request });

    await expect(adapter.loadCapabilities()).resolves.toEqual(expect.objectContaining({
      clawhub: true,
      uploadedArchives: false,
      multiSkillStrategy: 'client-split-native-upload',
    }));
    await expect(adapter.loadCapabilities()).resolves.toEqual(expect.objectContaining({
      uploadedArchives: true,
    }));
  });

  it('maps ClawHub search, detail, and install to native RPC payloads', async () => {
    request
      .mockResolvedValueOnce(SKILLS_SEARCH_RESPONSE)
      .mockResolvedValueOnce(SKILLS_DETAIL_RESPONSE)
      .mockResolvedValueOnce(SKILLS_CLAWHUB_INSTALL_RESPONSE);
    const adapter = createSkillInstallAdapter({ request });

    await expect(adapter.searchClawHub('pubmed')).resolves.toEqual(SKILLS_SEARCH_RESPONSE.results);
    await expect(adapter.loadClawHubDetail('pubmed-research')).resolves.toEqual(SKILLS_DETAIL_RESPONSE);
    await expect(
      adapter.installFromClawHub({ slug: 'pubmed-research', version: '1.2.3' }),
    ).resolves.toEqual(SKILLS_CLAWHUB_INSTALL_RESPONSE);

    expect(request).toHaveBeenNthCalledWith(1, 'skills.search', {
      query: 'pubmed',
      limit: 20,
    });
    expect(request).toHaveBeenNthCalledWith(2, 'skills.detail', {
      slug: 'pubmed-research',
    });
    expect(request).toHaveBeenNthCalledWith(3, 'skills.install', {
      source: 'clawhub',
      slug: 'pubmed-research',
      version: '1.2.3',
      force: false,
    });
  });

  it('preflights a multi-Skill ZIP locally with selection, conflicts, scan, and dependencies', async () => {
    const adapter = createSkillInstallAdapter({ request });
    const preflight = await adapter.preflightLocalArchive(
      await makeMedicalBundle(),
      [{ skillKey: 'clinical-trial-review', baseDir: '/workspace/skills/clinical-trial-review' }],
    );

    expect(preflight.kind).toBe('multi-skill');
    expect(preflight.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(preflight.candidates).toHaveLength(2);
    expect(preflight.issues).toEqual([]);
    expect(preflight.candidates[0]).toEqual(expect.objectContaining({
      slug: 'clinical-trial-review',
      displayName: 'Clinical Trial Review',
      rootPath: 'clinical-trial-review',
      conflict: {
        kind: 'existing',
        existingSkillKey: 'clinical-trial-review',
      },
      localScan: 'pass',
      requirements: expect.objectContaining({
        bins: ['python3'],
        env: ['NCBI_API_KEY'],
        os: ['darwin'],
      }),
    }));
    expect(preflight.candidates[1]).toEqual(expect.objectContaining({
      slug: 'medical-literature-map',
      conflict: { kind: 'none' },
      localScan: 'pass',
    }));
  });

  it('splits selected bundle entries and installs each through native staged upload RPCs', async () => {
    const adapter = createSkillInstallAdapter({ request });
    const preflight = await adapter.preflightLocalArchive(await makeMedicalBundle(), []);
    let uploadCounter = 0;
    request.mockImplementation((method: string, params: Record<string, unknown>) => {
      if (method === 'skills.upload.begin') {
        uploadCounter += 1;
        return Promise.resolve({ uploadId: `upload-${uploadCounter}` });
      }
      if (method === 'skills.upload.chunk') return Promise.resolve({ ok: true });
      if (method === 'skills.upload.commit') {
        return Promise.resolve({ uploadId: params.uploadId, sha256: params.sha256 });
      }
      if (method === 'skills.install') {
        return Promise.resolve({
          ok: true,
          slug: params.slug,
          targetDir: `/workspace/skills/${params.slug}`,
          sha256: params.sha256,
        });
      }
      throw new Error(`unexpected RPC ${method}`);
    });
    const progress = vi.fn();

    const results = await adapter.installLocalCandidates(preflight, {
      selectedIds: preflight.candidates.map((candidate) => candidate.id),
      forceIds: [],
      onProgress: progress,
    });

    expect(results).toEqual([
      expect.objectContaining({ slug: 'clinical-trial-review', status: 'installed' }),
      expect.objectContaining({ slug: 'medical-literature-map', status: 'installed' }),
    ]);
    expect(request.mock.calls.filter(([method]) => method === 'skills.upload.begin')).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === 'skills.upload.commit')).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === 'skills.install')).toHaveLength(2);
    expect(request).toHaveBeenCalledWith('skills.install', expect.objectContaining({
      source: 'upload',
      uploadId: 'upload-1',
      slug: 'clinical-trial-review',
      force: false,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({
      slug: 'clinical-trial-review',
      status: 'uploading',
    }));
  });

  it('resumes a native idempotent upload from the Gateway receivedBytes offset', async () => {
    const adapter = createSkillInstallAdapter({ request });
    const preflight = await adapter.preflightLocalArchive(await makeMedicalBundle(), []);
    const candidate = preflight.candidates[0];
    request.mockImplementation((method: string, params: Record<string, unknown>) => {
      if (method === 'skills.upload.begin') {
        return Promise.resolve({
          uploadId: 'resumed-upload',
          // Simulates retrying a fully uploaded/committed idempotent request.
          receivedBytes: candidate.archiveBytes.byteLength,
          expiresAt: Date.now() + 60_000,
        });
      }
      if (method === 'skills.upload.commit') return Promise.resolve({ ok: true });
      if (method === 'skills.install') {
        return Promise.resolve({ ok: true, slug: params.slug });
      }
      throw new Error(`unexpected RPC ${method}`);
    });

    await expect(
      adapter.installLocalCandidates(preflight, {
        selectedIds: [candidate.id],
      }),
    ).resolves.toEqual([
      expect.objectContaining({ slug: candidate.slug, status: 'installed' }),
    ]);
    expect(request).not.toHaveBeenCalledWith('skills.upload.chunk', expect.anything());
    expect(request).toHaveBeenCalledWith('skills.upload.commit', {
      uploadId: 'resumed-upload',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('rejects a ZIP with no SKILL.md before any mutating RPC', async () => {
    const zip = new JSZip();
    zip.file('README.md', 'not a skill');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const file = new File(
      [Uint8Array.from(bytes).buffer],
      'not-a-skill.zip',
      { type: 'application/zip' },
    );
    const adapter = createSkillInstallAdapter({ request });

    await expect(adapter.preflightLocalArchive(file, [])).rejects.toBeInstanceOf(
      SkillArchiveValidationError,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('blocks suspicious compression ratios before inflating a zip bomb payload', async () => {
    const zip = new JSZip();
    zip.file(
      'zip-bomb/SKILL.md',
      `---\nname: Zip Bomb\ndescription: test\n---\n${'A'.repeat(2 * 1024 * 1024)}`,
    );
    const bytes = await zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });
    const file = new File([Uint8Array.from(bytes).buffer], 'zip-bomb.zip');
    const adapter = createSkillInstallAdapter({ request });

    await expect(adapter.preflightLocalArchive(file, [])).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'compression-ratio', severity: 'blocked' })],
    });
  });

  it('enforces whole-archive entry-count and total-expanded-byte budgets', () => {
    expect(
      inspectSkillArchiveBudget(
        Array.from({ length: 5_001 }, (_, index) => ({
          name: `entry-${index}`,
          dir: false,
          compressedBytes: 1,
          uncompressedBytes: 1,
        })),
      ),
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'too-many-files', severity: 'blocked' }),
    ]));

    expect(
      inspectSkillArchiveBudget([
        {
          name: 'declared-large.bin',
          dir: false,
          // A realistic ratio avoids conflating the total-size assertion with
          // the independent compression-ratio guard.
          compressedBytes: 129 * 1024 * 1024,
          uncompressedBytes: 129 * 1024 * 1024,
        },
      ]),
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'too-large', severity: 'blocked' }),
    ]));
  });

  it('rejects traversal, absolute, Windows absolute, NUL, and over-deep paths', async () => {
    const unsafePaths = [
      '../traversal/SKILL.md',
      '/absolute/SKILL.md',
      'C:/windows/SKILL.md',
      `nul\u0000byte/SKILL.md`,
      `${Array.from({ length: 18 }, (_, index) => `d${index}`).join('/')}/SKILL.md`,
    ];
    const adapter = createSkillInstallAdapter({ request });

    for (const [index, unsafePath] of unsafePaths.entries()) {
      const zip = new JSZip();
      zip.file(unsafePath, '---\nname: Unsafe\ndescription: test\n---\n');
      const bytes = await zip.generateAsync({ type: 'uint8array' });
      const file = new File([Uint8Array.from(bytes).buffer], `unsafe-${index}.zip`);
      await expect(adapter.preflightLocalArchive(file, [])).rejects.toMatchObject({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'invalid-path', severity: 'blocked' }),
        ]),
      });
    }
  });

  it('blocks only the affected Skill for symlinks and compiled Python bytecode', async () => {
    const adapter = createSkillInstallAdapter({ request });

    const symlinkZip = new JSZip();
    symlinkZip.file('linked/SKILL.md', '---\nname: Linked\ndescription: test\n---\n');
    symlinkZip.file('linked/tool-link', 'tool.py', { unixPermissions: 0o120777 });
    const symlinkBytes = await symlinkZip.generateAsync({
      type: 'uint8array',
      platform: 'UNIX',
    });
    const symlinkPreflight = await adapter.preflightLocalArchive(
      new File([Uint8Array.from(symlinkBytes).buffer], 'symlink.zip'),
      [],
    );
    expect(symlinkPreflight.candidates[0]).toMatchObject({
      localScan: 'blocked',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'symlink', severity: 'blocked' }),
      ]),
    });

    const bytecodeZip = new JSZip();
    bytecodeZip.file('bytecode/SKILL.md', '---\nname: Bytecode\ndescription: test\n---\n');
    bytecodeZip.file('bytecode/__pycache__/tool.cpython-313.pyc', 'compiled');
    bytecodeZip.file('clean/SKILL.md', '---\nname: Clean\ndescription: test\n---\n');
    const mixedBytecodeBytes = await bytecodeZip.generateAsync({ type: 'uint8array' });
    const bytecodePreflight = await adapter.preflightLocalArchive(
      new File([Uint8Array.from(mixedBytecodeBytes).buffer], 'bytecode.zip'),
      [],
    );
    expect(bytecodePreflight.candidates).toEqual([
      expect.objectContaining({
        slug: 'bytecode',
        localScan: 'blocked',
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'python-bytecode', severity: 'blocked' }),
        ]),
      }),
      expect.objectContaining({
        slug: 'clean',
        localScan: 'pass',
        issues: [],
      }),
    ]);
    request.mockImplementation((method: string, params: Record<string, unknown>) => {
      if (method === 'skills.upload.begin') return Promise.resolve({ uploadId: 'clean-upload' });
      if (method === 'skills.upload.chunk' || method === 'skills.upload.commit') {
        return Promise.resolve({ ok: true });
      }
      if (method === 'skills.install') {
        return Promise.resolve({
          ok: true,
          slug: params.slug,
          targetDir: `/workspace/skills/${params.slug}`,
        });
      }
      throw new Error(`unexpected RPC ${method}`);
    });
    await expect(
      adapter.installLocalCandidates(bytecodePreflight, {
        selectedIds: bytecodePreflight.candidates.map((candidate) => candidate.id),
      }),
    ).resolves.toEqual([
      expect.objectContaining({ slug: 'bytecode', status: 'failed' }),
      expect.objectContaining({ slug: 'clean', status: 'installed' }),
    ]);
    expect(request).toHaveBeenCalledWith('skills.upload.begin', expect.objectContaining({
      slug: 'clean',
    }));
    expect(request).not.toHaveBeenCalledWith('skills.upload.begin', expect.objectContaining({
      slug: 'bytecode',
    }));
  });

  it('rejects nested Skill roots instead of repacking one Skill into another', async () => {
    const zip = new JSZip();
    zip.file('parent/SKILL.md', '---\nname: Parent\ndescription: test\n---\n');
    zip.file('parent/child/SKILL.md', '---\nname: Child\ndescription: test\n---\n');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const adapter = createSkillInstallAdapter({ request });

    await expect(
      adapter.preflightLocalArchive(
        new File([Uint8Array.from(bytes).buffer], 'nested.zip'),
        [],
      ),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'nested-skill-root', severity: 'blocked' })],
    });
  });

  it('reports partial success per Skill and continues after an atomic item fails', async () => {
    const adapter = createSkillInstallAdapter({ request });
    const preflight = await adapter.preflightLocalArchive(await makeMedicalBundle(), []);
    let uploadCounter = 0;
    request.mockImplementation((method: string, params: Record<string, unknown>) => {
      if (method === 'skills.upload.begin') {
        uploadCounter += 1;
        return Promise.resolve({ uploadId: `upload-${uploadCounter}` });
      }
      if (method === 'skills.upload.chunk' || method === 'skills.upload.commit') {
        return Promise.resolve({ ok: true });
      }
      if (method === 'skills.install' && params.slug === 'clinical-trial-review') {
        return Promise.reject(new Error('gateway security scan blocked this Skill'));
      }
      if (method === 'skills.install') {
        return Promise.resolve({
          ok: true,
          slug: params.slug,
          targetDir: `/workspace/skills/${params.slug}`,
        });
      }
      throw new Error(`unexpected RPC ${method}`);
    });

    const results = await adapter.installLocalCandidates(preflight, {
      selectedIds: preflight.candidates.map((candidate) => candidate.id),
    });

    expect(results).toEqual([
      expect.objectContaining({
        slug: 'clinical-trial-review',
        status: 'failed',
        message: 'gateway security scan blocked this Skill',
      }),
      expect.objectContaining({
        slug: 'medical-literature-map',
        status: 'installed',
      }),
    ]);
  });
});
