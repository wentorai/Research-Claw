import JSZip, { type JSZipObject } from 'jszip';
import { parse as parseYaml } from 'yaml';

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 5_000;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_SKILLS_PER_ARCHIVE = 100;
const MAX_FILES_PER_SKILL = 2_000;
const MAX_UNCOMPRESSED_BYTES_PER_SKILL = 32 * 1024 * 1024;
const MAX_ARCHIVE_PATH_DEPTH = 16;
const MAX_COMPRESSION_RATIO = 200;
// OC's base64 protocol field allows ~5.3 MiB; 3 MiB raw chunks stay below it.
const UPLOAD_CHUNK_BYTES = 3 * 1024 * 1024;
const VALID_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export type GatewayRequester = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
};

export type SkillInstallCapabilities = {
  clawhub: true;
  uploadedArchives: boolean;
  multiSkillStrategy: 'client-split-native-upload';
  /** OC 2026.6.1 scans during install but has no scan-only preview RPC. */
  preInstallSecurityVerdicts: false;
  /** OC 2026.6.1 exposes declared requirements, not an install-plan RPC. */
  dependencyInstallPlan: false;
};

export type ClawHubSearchResult = {
  score: number;
  slug: string;
  displayName: string;
  summary?: string;
  version?: string;
  updatedAt?: number;
};

export type ClawHubSkillDetail = {
  skill: {
    slug: string;
    displayName: string;
    summary?: string;
    tags?: Record<string, string>;
    createdAt: number;
    updatedAt: number;
  } | null;
  latestVersion?: {
    version: string;
    createdAt: number;
    changelog?: string;
  } | null;
  metadata?: {
    os?: string[] | null;
    systems?: string[] | null;
  } | null;
  owner?: {
    handle?: string | null;
    displayName?: string | null;
    image?: string | null;
  } | null;
};

export type SkillInstallRpcResult = {
  ok: boolean;
  message?: string;
  slug?: string;
  version?: string;
  targetDir?: string;
  sha256?: string;
  stdout?: string;
  stderr?: string;
  code?: number;
};

export type DeclaredSkillRequirements = {
  bins: string[];
  anyBins: string[];
  env: string[];
  config: string[];
  os: string[];
};

export type ArchiveIssue = {
  severity: 'warning' | 'blocked';
  code:
    | 'invalid-path'
    | 'symlink'
    | 'suspicious-file'
    | 'invalid-frontmatter'
    | 'invalid-slug'
    | 'duplicate-slug'
    | 'nested-skill-root'
    | 'python-bytecode'
    | 'compression-ratio'
    | 'too-many-files'
    | 'too-large';
  message: string;
};

export type ExistingSkillIdentity = {
  skillKey: string;
  baseDir: string;
};

export type LocalSkillCandidate = {
  id: string;
  slug: string;
  displayName: string;
  description?: string;
  rootPath: string;
  requirements: DeclaredSkillRequirements;
  conflict:
    | { kind: 'none' }
    | { kind: 'existing'; existingSkillKey: string };
  localScan: 'pass' | 'warning' | 'blocked';
  issues: ArchiveIssue[];
  /** Repacked as one native OC skill archive with SKILL.md at its root. */
  archiveBytes: Uint8Array;
};

export type LocalArchivePreflight = {
  schema: 'research-claw.skills.local-preflight.v1';
  fileName: string;
  sizeBytes: number;
  sha256: string;
  kind: 'single-skill' | 'multi-skill';
  candidates: LocalSkillCandidate[];
  issues: ArchiveIssue[];
  securityContract: {
    localStructureScan: 'complete';
    gatewaySecurityScan: 'runs-during-install';
    preInstallVerdictAvailable: false;
  };
};

export type LocalInstallProgress = {
  id: string;
  slug: string;
  status: 'queued' | 'uploading' | 'installing' | 'installed' | 'failed';
  message?: string;
};

export type LocalSkillInstallResult = LocalInstallProgress & {
  targetDir?: string;
  sha256?: string;
};

export class SkillArchiveValidationError extends Error {
  readonly issues: ArchiveIssue[];

  constructor(message: string, issues: ArchiveIssue[] = []) {
    super(message);
    this.name = 'SkillArchiveValidationError';
    this.issues = issues;
  }
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function emptyRequirements(): DeclaredSkillRequirements {
  return { bins: [], anyBins: [], env: [], config: [], os: [] };
}

function parseSkillFrontmatter(content: string): {
  name?: string;
  description?: string;
  requirements: DeclaredSkillRequirements;
  error?: string;
} {
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return {
      requirements: emptyRequirements(),
      error: 'SKILL.md is missing YAML frontmatter',
    };
  }
  try {
    const document = getRecord(parseYaml(match[1]));
    const metadata = getRecord(document?.metadata);
    const openclaw = getRecord(metadata?.openclaw);
    const requirements = getRecord(openclaw?.requires) ?? getRecord(metadata?.requires);
    return {
      name: typeof document?.name === 'string' ? document.name.trim() : undefined,
      description:
        typeof document?.description === 'string' ? document.description.trim() : undefined,
      requirements: {
        bins: stringList(requirements?.bins),
        anyBins: stringList(requirements?.anyBins),
        env: stringList(requirements?.env),
        config: stringList(requirements?.config),
        // `os` is a sibling of `requires` in OpenClaw Skill metadata.
        os: stringList(openclaw?.os ?? requirements?.os),
      },
    };
  } catch (error) {
    return {
      requirements: emptyRequirements(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeArchivePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
}

function pathIsUnsafe(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return (
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split('/').some((part) => part === '..')
  );
}

function archiveEntrySizes(entry: JSZipObject): {
  compressed?: number;
  uncompressed?: number;
} {
  const data = (entry as JSZipObject & {
    _data?: { compressedSize?: number; uncompressedSize?: number };
  })._data;
  return {
    compressed:
      typeof data?.compressedSize === 'number' && data.compressedSize >= 0
        ? data.compressedSize
        : undefined,
    uncompressed:
      typeof data?.uncompressedSize === 'number' && data.uncompressedSize >= 0
        ? data.uncompressedSize
        : undefined,
  };
}

export type SkillArchiveBudgetEntry = {
  name: string;
  dir: boolean;
  compressedBytes?: number;
  uncompressedBytes?: number;
};

/**
 * Inspect ZIP metadata before inflating any payload.
 *
 * This is deliberately independent of JSZip so the entry-count, total expanded
 * size, and compression-ratio limits can be tested without allocating a
 * hundreds-of-megabytes archive in the test process.
 */
export function inspectSkillArchiveBudget(
  entries: readonly SkillArchiveBudgetEntry[],
): ArchiveIssue[] {
  const issues: ArchiveIssue[] = [];
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    issues.push({
      severity: 'blocked',
      code: 'too-many-files',
      message: `Archive entry count exceeds ${MAX_ARCHIVE_ENTRIES}`,
    });
  }

  let declaredUncompressedBytes = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    if (entry.uncompressedBytes !== undefined) {
      declaredUncompressedBytes += entry.uncompressedBytes;
    }
    if (
      entry.uncompressedBytes !== undefined &&
      entry.compressedBytes !== undefined &&
      entry.uncompressedBytes > 1024 * 1024 &&
      entry.uncompressedBytes / Math.max(1, entry.compressedBytes) > MAX_COMPRESSION_RATIO
    ) {
      issues.push({
        severity: 'blocked',
        code: 'compression-ratio',
        message: `Suspicious compression ratio for ${entry.name}`,
      });
    }
  }
  if (declaredUncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
    issues.push({
      severity: 'blocked',
      code: 'too-large',
      message: `Archive expands beyond ${MAX_TOTAL_UNCOMPRESSED_BYTES} bytes`,
    });
  }
  return issues;
}

function isSymlink(entry: JSZipObject): boolean {
  const permissions = entry.unixPermissions;
  if (permissions === null || permissions === undefined) return false;
  const mode = typeof permissions === 'string' ? Number.parseInt(permissions, 8) : permissions;
  return Number.isFinite(mode) && (mode & 0o170000) === 0o120000;
}

function deriveSlug(rootPath: string, declaredName?: string): string {
  const rootName = rootPath.split('/').filter(Boolean).at(-1)?.toLowerCase() ?? '';
  if (VALID_SLUG.test(rootName)) return rootName;
  const slug = (declaredName ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return VALID_SLUG.test(slug) ? slug : '';
}

function existingConflict(
  slug: string,
  existingSkills: ExistingSkillIdentity[],
): LocalSkillCandidate['conflict'] {
  const existing = existingSkills.find((skill) => {
    const baseName = normalizeArchivePath(skill.baseDir).replace(/\/+$/, '').split('/').at(-1);
    return skill.skillKey.toLowerCase() === slug || baseName?.toLowerCase() === slug;
  });
  return existing
    ? { kind: 'existing', existingSkillKey: existing.skillKey }
    : { kind: 'none' };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const ownedBuffer = Uint8Array.from(bytes).buffer;
  const digest = await crypto.subtle.digest('SHA-256', ownedBuffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function candidateEntries(zip: JSZip, rootPath: string): JSZipObject[] {
  const prefix = rootPath ? `${rootPath.replace(/\/+$/, '')}/` : '';
  return Object.values(zip.files).filter((entry) => {
    const path = normalizeArchivePath(entry.name);
    return !entry.dir && (prefix ? path.startsWith(prefix) : true);
  });
}

async function repackCandidate(zip: JSZip, rootPath: string): Promise<{
  archiveBytes: Uint8Array;
  issues: ArchiveIssue[];
  expandedBytes: number;
}> {
  const output = new JSZip();
  const prefix = rootPath ? `${rootPath.replace(/\/+$/, '')}/` : '';
  const entries = candidateEntries(zip, rootPath);
  const issues: ArchiveIssue[] = [];
  if (entries.length > MAX_FILES_PER_SKILL) {
    issues.push({
      severity: 'blocked',
      code: 'too-many-files',
      message: `Skill contains ${entries.length} files; limit is ${MAX_FILES_PER_SKILL}`,
    });
  }

  let uncompressedBytes = 0;
  for (const entry of entries) {
    const relativePath = normalizeArchivePath(entry.name).slice(prefix.length);
    if (!relativePath || pathIsUnsafe(relativePath)) {
      issues.push({
        severity: 'blocked',
        code: 'invalid-path',
        message: `Unsafe archive path: ${entry.name}`,
      });
      continue;
    }
    if (
      relativePath.split('/').length > MAX_ARCHIVE_PATH_DEPTH ||
      relativePath.length > 512
    ) {
      issues.push({
        severity: 'blocked',
        code: 'invalid-path',
        message: `Archive path is too deep or long: ${entry.name}`,
      });
      continue;
    }
    if (isSymlink(entry)) {
      issues.push({
        severity: 'blocked',
        code: 'symlink',
        message: `Symbolic links are not accepted: ${entry.name}`,
      });
      continue;
    }
    if (
      /(?:^|\/)__pycache__(?:\/|$)/i.test(relativePath) ||
      /\.(?:pyc|pyo)$/i.test(relativePath)
    ) {
      issues.push({
        severity: 'blocked',
        code: 'python-bytecode',
        message: `Compiled Python bytecode is not accepted: ${relativePath}`,
      });
      continue;
    }
    if (/\.(?:exe|dll|dylib|so|app|msi)$/i.test(relativePath)) {
      issues.push({
        severity: 'warning',
        code: 'suspicious-file',
        message: `Executable payload requires gateway security review: ${relativePath}`,
      });
    }
    const data = await entry.async('uint8array');
    uncompressedBytes += data.byteLength;
    if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES_PER_SKILL) {
      issues.push({
        severity: 'blocked',
        code: 'too-large',
        message: `Expanded Skill exceeds ${MAX_UNCOMPRESSED_BYTES_PER_SKILL} bytes`,
      });
      break;
    }
    output.file(relativePath, data);
  }

  return {
    archiveBytes: await output.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    }),
    issues,
    expandedBytes: uncompressedBytes,
  };
}

async function preflightLocalArchive(
  file: File,
  existingSkills: ExistingSkillIdentity[],
): Promise<LocalArchivePreflight> {
  if (!file.name.toLowerCase().endsWith('.zip')) {
    throw new SkillArchiveValidationError('Only .zip Skill archives are supported');
  }
  if (file.size < 1 || file.size > MAX_ARCHIVE_BYTES) {
    throw new SkillArchiveValidationError(
      `Archive size must be between 1 and ${MAX_ARCHIVE_BYTES} bytes`,
    );
  }

  const archiveBytes = new Uint8Array(await file.arrayBuffer());
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(archiveBytes, { createFolders: true });
  } catch (error) {
    throw new SkillArchiveValidationError(
      `Unable to read ZIP: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const globalIssues: ArchiveIssue[] = [];
  const archiveEntries = Object.values(zip.files);
  const budgetIssues = inspectSkillArchiveBudget(
    archiveEntries.map((entry) => {
      const sizes = archiveEntrySizes(entry);
      return {
        name: entry.name,
        dir: entry.dir,
        compressedBytes: sizes.compressed,
        uncompressedBytes: sizes.uncompressed,
      };
    }),
  );
  if (budgetIssues.some((issue) => issue.code === 'too-many-files')) {
    throw new SkillArchiveValidationError(
      `Archive contains ${archiveEntries.length} entries; limit is ${MAX_ARCHIVE_ENTRIES}`,
      budgetIssues,
    );
  }
  globalIssues.push(...budgetIssues);
  for (const entry of archiveEntries) {
    const unsafeOriginalName = (entry as JSZipObject & { unsafeOriginalName?: string })
      .unsafeOriginalName;
    const normalizedPath = normalizeArchivePath(entry.name);
    if (
      pathIsUnsafe(entry.name) ||
      (unsafeOriginalName !== undefined && pathIsUnsafe(unsafeOriginalName))
    ) {
      globalIssues.push({
        severity: 'blocked',
        code: 'invalid-path',
        message: `Unsafe archive path: ${unsafeOriginalName ?? entry.name}`,
      });
    }
    if (
      normalizedPath.split('/').filter(Boolean).length > MAX_ARCHIVE_PATH_DEPTH ||
      normalizedPath.length > 512
    ) {
      globalIssues.push({
        severity: 'blocked',
        code: 'invalid-path',
        message: `Archive path is too deep or long: ${entry.name}`,
      });
    }
  }
  if (globalIssues.some((issue) => issue.severity === 'blocked')) {
    throw new SkillArchiveValidationError('Archive failed local structure preflight', globalIssues);
  }

  const skillFiles = archiveEntries
    .filter((entry) => !entry.dir && normalizeArchivePath(entry.name).split('/').at(-1) === 'SKILL.md');
  if (skillFiles.length === 0) {
    throw new SkillArchiveValidationError('Archive does not contain a SKILL.md');
  }
  if (skillFiles.length > MAX_SKILLS_PER_ARCHIVE) {
    throw new SkillArchiveValidationError(
      `Archive contains ${skillFiles.length} Skills; limit is ${MAX_SKILLS_PER_ARCHIVE}`,
    );
  }
  const skillRoots = skillFiles.map((skillFile) =>
    normalizeArchivePath(skillFile.name).split('/').slice(0, -1).join('/'));
  const nestedRoots = skillRoots.find((candidate, index) =>
    skillRoots.some(
      (other, otherIndex) =>
        index !== otherIndex &&
        (other === '' || candidate.startsWith(`${other}/`)),
    ));
  if (nestedRoots !== undefined) {
    throw new SkillArchiveValidationError(
      'Nested Skill roots are not supported',
      [{
        severity: 'blocked',
        code: 'nested-skill-root',
        message: `Nested Skill root would cross archive boundaries: ${nestedRoots || '.'}`,
      }],
    );
  }

  const candidates: LocalSkillCandidate[] = [];
  const usedSlugs = new Set<string>();
  let actualUncompressedBytes = 0;
  for (const skillFile of skillFiles) {
    const normalizedSkillPath = normalizeArchivePath(skillFile.name);
    const rootPath = normalizedSkillPath.split('/').slice(0, -1).join('/');
    const entries = candidateEntries(zip, rootPath);
    const declaredCandidateBytes = entries.reduce((total, entry) => {
      return total + (archiveEntrySizes(entry).uncompressed ?? 0);
    }, 0);
    const candidateTooLarge = declaredCandidateBytes > MAX_UNCOMPRESSED_BYTES_PER_SKILL;
    // Never inflate or parse a declared-over-limit SKILL.md just to render its
    // metadata. The candidate remains visible and blocked, while sibling Skills
    // in a multi-Skill bundle can still proceed.
    const frontmatter = candidateTooLarge
      ? { requirements: emptyRequirements() }
      : parseSkillFrontmatter(await skillFile.async('string'));
    const slug = deriveSlug(rootPath, frontmatter.name);
    const issues: ArchiveIssue[] = candidateTooLarge
      ? [{
          severity: 'blocked',
          code: 'too-large',
          message: `Expanded Skill exceeds ${MAX_UNCOMPRESSED_BYTES_PER_SKILL} bytes`,
        }]
      : [];
    if (frontmatter.error) {
      issues.push({
        severity: 'warning',
        code: 'invalid-frontmatter',
        message: frontmatter.error,
      });
    }
    if (!slug) {
      issues.push({
        severity: 'blocked',
        code: 'invalid-slug',
        message: `Cannot derive an ASCII Skill slug from ${rootPath || file.name}`,
      });
    } else if (usedSlugs.has(slug)) {
      issues.push({
        severity: 'blocked',
        code: 'duplicate-slug',
        message: `Duplicate Skill slug: ${slug}`,
      });
    } else {
      usedSlugs.add(slug);
    }

    const repacked = candidateTooLarge
      ? {
          archiveBytes: new Uint8Array(),
          issues: [] as ArchiveIssue[],
          expandedBytes: declaredCandidateBytes,
        }
      : await repackCandidate(zip, rootPath);
    actualUncompressedBytes += repacked.expandedBytes;
    if (actualUncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new SkillArchiveValidationError(
        `Archive expands beyond ${MAX_TOTAL_UNCOMPRESSED_BYTES} bytes`,
        [{
          severity: 'blocked',
          code: 'too-large',
          message: `Total expanded archive size exceeds ${MAX_TOTAL_UNCOMPRESSED_BYTES} bytes`,
        }],
      );
    }
    issues.push(...repacked.issues);
    const localScan = issues.some((issue) => issue.severity === 'blocked')
      ? 'blocked'
      : issues.length > 0
        ? 'warning'
        : 'pass';
    candidates.push({
      id: `${rootPath || '.'}:${slug || candidates.length}`,
      slug,
      displayName: frontmatter.name || slug || rootPath || file.name,
      description: frontmatter.description,
      rootPath,
      requirements: frontmatter.requirements,
      conflict: slug ? existingConflict(slug, existingSkills) : { kind: 'none' },
      localScan,
      issues,
      archiveBytes: repacked.archiveBytes,
    });
  }

  return {
    schema: 'research-claw.skills.local-preflight.v1',
    fileName: file.name,
    sizeBytes: file.size,
    sha256: await sha256(archiveBytes),
    kind: candidates.length === 1 ? 'single-skill' : 'multi-skill',
    candidates,
    issues: globalIssues,
    securityContract: {
      localStructureScan: 'complete',
      gatewaySecurityScan: 'runs-during-install',
      preInstallVerdictAvailable: false,
    },
  };
}

async function uploadAndInstallCandidate(
  gateway: GatewayRequester,
  candidate: LocalSkillCandidate,
  force: boolean,
  onProgress?: (progress: LocalInstallProgress) => void,
): Promise<LocalSkillInstallResult> {
  const digest = await sha256(candidate.archiveBytes);
  const base = { id: candidate.id, slug: candidate.slug };
  onProgress?.({ ...base, status: 'uploading' });
  const begin = await gateway.request<{
    uploadId: string;
    receivedBytes?: number;
    expiresAt?: number;
  }>('skills.upload.begin', {
    kind: 'skill-archive',
    slug: candidate.slug,
    sizeBytes: candidate.archiveBytes.byteLength,
    sha256: digest,
    force,
    idempotencyKey: `${digest}:${candidate.slug}:${force ? 'force' : 'install'}`,
  });
  if (!begin?.uploadId) throw new Error('Gateway did not return an uploadId');
  const receivedBytes = begin.receivedBytes ?? 0;
  if (
    !Number.isSafeInteger(receivedBytes) ||
    receivedBytes < 0 ||
    receivedBytes > candidate.archiveBytes.byteLength
  ) {
    throw new Error('Gateway returned an invalid upload offset');
  }

  for (
    let offset = receivedBytes;
    offset < candidate.archiveBytes.length;
    offset += UPLOAD_CHUNK_BYTES
  ) {
    await gateway.request('skills.upload.chunk', {
      uploadId: begin.uploadId,
      offset,
      dataBase64: bytesToBase64(
        candidate.archiveBytes.subarray(offset, offset + UPLOAD_CHUNK_BYTES),
      ),
    });
  }
  await gateway.request('skills.upload.commit', {
    uploadId: begin.uploadId,
    sha256: digest,
  });
  onProgress?.({ ...base, status: 'installing' });
  const installed = await gateway.request<SkillInstallRpcResult>('skills.install', {
    source: 'upload',
    uploadId: begin.uploadId,
    slug: candidate.slug,
    force,
    sha256: digest,
    timeoutMs: 120_000,
  });
  return {
    ...base,
    status: 'installed',
    message: installed.message,
    targetDir: installed.targetDir,
    sha256: installed.sha256 ?? digest,
  };
}

export function createSkillInstallAdapter(gateway: GatewayRequester) {
  return {
    async loadCapabilities(): Promise<SkillInstallCapabilities> {
      const snapshot = await gateway.request<{
        config?: Record<string, unknown>;
        resolved?: Record<string, unknown>;
      }>('config.get', {});
      const config = snapshot.config ?? snapshot.resolved ?? {};
      const skills = getRecord(config.skills);
      const install = getRecord(skills?.install);
      return {
        clawhub: true,
        uploadedArchives: install?.allowUploadedArchives === true,
        multiSkillStrategy: 'client-split-native-upload',
        preInstallSecurityVerdicts: false,
        dependencyInstallPlan: false,
      };
    },

    async searchClawHub(query: string): Promise<ClawHubSearchResult[]> {
      const result = await gateway.request<{ results: ClawHubSearchResult[] }>('skills.search', {
        query: query.trim(),
        limit: 20,
      });
      return result.results ?? [];
    },

    loadClawHubDetail(slug: string): Promise<ClawHubSkillDetail> {
      return gateway.request<ClawHubSkillDetail>('skills.detail', { slug });
    },

    installFromClawHub(params: {
      slug: string;
      version?: string;
      force?: boolean;
    }): Promise<SkillInstallRpcResult> {
      return gateway.request<SkillInstallRpcResult>('skills.install', {
        source: 'clawhub',
        slug: params.slug,
        ...(params.version ? { version: params.version } : {}),
        force: params.force ?? false,
      });
    },

    preflightLocalArchive,

    async installLocalCandidates(
      preflight: LocalArchivePreflight,
      options: {
        selectedIds: Iterable<string>;
        forceIds?: Iterable<string>;
        onProgress?: (progress: LocalInstallProgress) => void;
      },
    ): Promise<LocalSkillInstallResult[]> {
      const selectedIds = new Set(options.selectedIds);
      const forceIds = new Set(options.forceIds ?? []);
      const results: LocalSkillInstallResult[] = [];
      for (const candidate of preflight.candidates.filter((entry) => selectedIds.has(entry.id))) {
        const base = { id: candidate.id, slug: candidate.slug };
        options.onProgress?.({ ...base, status: 'queued' });
        if (!candidate.slug || candidate.localScan === 'blocked') {
          const result: LocalSkillInstallResult = {
            ...base,
            status: 'failed',
            message: 'Local archive preflight blocked this Skill',
          };
          results.push(result);
          options.onProgress?.(result);
          continue;
        }
        if (candidate.conflict.kind === 'existing' && !forceIds.has(candidate.id)) {
          const result: LocalSkillInstallResult = {
            ...base,
            status: 'failed',
            message: 'Skill already exists; explicit overwrite confirmation is required',
          };
          results.push(result);
          options.onProgress?.(result);
          continue;
        }
        try {
          const result = await uploadAndInstallCandidate(
            gateway,
            candidate,
            forceIds.has(candidate.id),
            options.onProgress,
          );
          results.push(result);
          options.onProgress?.(result);
        } catch (error) {
          const result: LocalSkillInstallResult = {
            ...base,
            status: 'failed',
            message: error instanceof Error ? error.message : String(error),
          };
          results.push(result);
          options.onProgress?.(result);
        }
      }
      return results;
    },
  };
}

export type SkillInstallAdapter = ReturnType<typeof createSkillInstallAdapter>;
