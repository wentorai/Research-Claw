import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { parseDocument } from 'yaml';

export type SkillInstallFindingSeverity = 'info' | 'warn' | 'critical';

export interface SkillInstallFinding {
  ruleId: string;
  severity: SkillInstallFindingSeverity;
  file: string;
  line: number;
  message: string;
}

export interface SkillDependencyPreflight {
  declared: boolean;
  bins: string[];
  anyBins: string[];
  env: string[];
  config: string[];
  os: string[];
  missingBins: string[];
  anyBinSatisfied: boolean;
  missingEnv: string[];
  missingConfig: string[];
  osSupported: boolean;
}

export interface SkillInstallPreflight {
  /** Security approval only. This does not imply that runtime dependencies exist. */
  installAllowed: boolean;
  /** True only when every declared runtime gate is currently satisfied. */
  runtimeReady: boolean;
  blockReason?: string;
  findings: SkillInstallFinding[];
  dependencies: SkillDependencyPreflight;
  pythonFiles: string[];
  scannedFiles: number;
}

export interface SkillBeforeInstallEvent {
  targetType?: string;
  targetName?: string;
  sourcePath?: string;
  sourcePathKind?: string;
}

export interface SkillBeforeInstallResult {
  findings?: SkillInstallFinding[];
  block?: boolean;
  blockReason?: string;
}

interface SkillPreflightOptions {
  sourcePath: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  config?: Record<string, unknown>;
  hasBinary?: (binary: string) => boolean | Promise<boolean>;
}

interface SkillBeforeInstallDependencies {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  config?: Record<string, unknown>;
  hasBinary?: (binary: string) => boolean | Promise<boolean>;
}

interface CollectedSkillFiles {
  files: Array<{ absolutePath: string; relativePath: string; size: number }>;
  findings: SkillInstallFinding[];
  scannedFiles: number;
}

interface OpenClawRequirements {
  bins: string[];
  anyBins: string[];
  env: string[];
  config: string[];
}

interface ParsedSkillMetadata {
  cardPath: string;
  cardContent: string;
  requiresLine: number;
  requiresDeclared: boolean;
  requires: OpenClawRequirements;
  os: string[];
}

type PythonRule = {
  ruleId: string;
  severity: SkillInstallFindingSeverity;
  message: string;
  source: 'code' | 'raw';
  patterns: RegExp[];
};

const MAX_SCAN_FILES = 1_000;
const MAX_SCAN_DEPTH = 16;
const MAX_PYTHON_FILE_BYTES = 1024 * 1024;
const MAX_SKILL_CARD_BYTES = 256 * 1024;
const SKILL_CARD_NAMES = ['SKILL.md', 'skill.md', 'skills.md', 'SKILL.MD'] as const;
const PYTHON_RUNTIME_PATTERN = /^(?:python(?:\d+(?:\.\d+)*)?|uv)$/i;

const PYTHON_RULES: PythonRule[] = [
  {
    ruleId: 'rc-python-dynamic-exec',
    severity: 'critical',
    message: 'Dynamic Python code execution detected',
    source: 'code',
    patterns: [
      /(?<![\w.])(?:eval|exec|compile|__import__)\s*\(/,
      /\bgetattr\s*\(\s*__builtins__\s*,/,
      /\bimportlib\.(?:import_module|reload)\s*\(/,
    ],
  },
  {
    ruleId: 'rc-python-unsafe-deserialization',
    severity: 'critical',
    message: 'Unsafe Python deserialization detected',
    source: 'code',
    patterns: [
      /\b(?:pickle|dill|cloudpickle|marshal)\.(?:load|loads)\s*\(/,
      /\byaml\.(?:unsafe_load|unsafe_load_all)\s*\(/,
      /\byaml\.load\s*\([^)]*(?:Loader\s*=\s*yaml\.(?:Loader|FullLoader)|Loader\s*=\s*(?:Loader|FullLoader))/,
    ],
  },
  {
    ruleId: 'rc-python-native-library-load',
    severity: 'critical',
    message: 'Dynamic native-library loading detected',
    source: 'code',
    patterns: [/\bctypes\.(?:CDLL|PyDLL|WinDLL|OleDLL)\s*\(/],
  },
  {
    ruleId: 'rc-python-obfuscation',
    severity: 'critical',
    message: 'Encoded or obfuscated Python payload detected',
    source: 'raw',
    patterns: [
      /(?:base64\.)?(?:b64decode|decodebytes)\s*\(\s*(?:b|br|rb|r)?["'][A-Za-z0-9+/=\s]{200,}/i,
      /(?:\\x[0-9a-fA-F]{2}){16,}/,
      /\bcodecs\.decode\s*\([^)]{0,300}["'](?:rot[-_]?13|hex|base64)["']/i,
    ],
  },
];

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join('/');
}

function createFinding(
  ruleId: string,
  severity: SkillInstallFindingSeverity,
  file: string,
  line: number,
  message: string,
): SkillInstallFinding {
  return { ruleId, severity, file: normalizeRelativePath(file), line, message };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asRecordFromYamlValue(value: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function lineNumberAt(source: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function firstMatch(source: string, patterns: RegExp[]): { index: number; pattern: RegExp } | undefined {
  let first: { index: number; pattern: RegExp } | undefined;
  for (const pattern of patterns) {
    const flags = pattern.flags.replaceAll('g', '');
    const match = new RegExp(pattern.source, flags).exec(source);
    if (match && (!first || match.index < first.index)) {
      first = { index: match.index, pattern };
    }
  }
  return first;
}

/**
 * Masks comments and string contents while preserving offsets and newlines.
 * Call/import rules therefore ignore examples in comments and docstrings.
 */
function maskPythonCommentsAndStrings(source: string): string {
  const output = source.split('');
  let quote: "'" | '"' | undefined;
  let triple = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (quote) {
      if (char === '\n') {
        output[index] = '\n';
        if (!triple) {
          quote = undefined;
          escaped = false;
        }
        continue;
      }
      if (triple && source.slice(index, index + 3) === quote.repeat(3)) {
        output[index] = output[index + 1] = output[index + 2] = ' ';
        index += 2;
        quote = undefined;
        triple = false;
        escaped = false;
        continue;
      }
      output[index] = ' ';
      if (!triple && char === quote && !escaped) {
        quote = undefined;
      }
      if (char === '\\' && !escaped) {
        escaped = true;
      } else {
        escaped = false;
      }
      continue;
    }

    if (char === '#') {
      while (index < source.length && source[index] !== '\n') {
        output[index] = ' ';
        index += 1;
      }
      if (index < source.length) output[index] = '\n';
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      triple = source.slice(index, index + 3) === char.repeat(3);
      output[index] = ' ';
      if (triple) {
        output[index + 1] = output[index + 2] = ' ';
        index += 2;
      }
      escaped = false;
    }
  }

  return output.join('');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function moduleAliases(source: string, moduleName: string): string[] {
  const aliases = new Set<string>();
  const importPattern = /\bimport\s+([^\n;]+)/g;
  for (const match of source.matchAll(importPattern)) {
    for (const part of (match[1] ?? '').split(',')) {
      const parsed =
        /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(
          part.trim(),
        );
      if (!parsed) continue;
      const importedModule = parsed[1];
      if (
        importedModule !== moduleName &&
        !importedModule.startsWith(`${moduleName}.`)
      ) {
        continue;
      }
      // `import urllib.request` binds `urllib.request` for member access, while
      // `import urllib.request as request` binds only the explicit alias.
      aliases.add(parsed[2] ?? moduleName);
    }
  }
  return [...aliases];
}

function importedCallNames(
  source: string,
  moduleName: string,
  allowedNames: readonly string[],
): string[] {
  const names = new Set<string>();
  const importPattern = new RegExp(
    `\\bfrom\\s+${escapeRegExp(moduleName)}\\s+import\\s+(\\([\\s\\S]{0,2000}?\\)|[^\\n;]+)`,
    'g',
  );
  for (const match of source.matchAll(importPattern)) {
    const importedNames = (match[1] ?? '')
      .replace(/^\s*\(/, '')
      .replace(/\)\s*$/, '')
      .replace(/\\\r?\n/g, ' ');
    for (const part of importedNames.split(',')) {
      const parsed = /^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(part.trim());
      if (parsed && allowedNames.includes(parsed[1])) names.add(parsed[2] ?? parsed[1]);
    }
  }
  return [...names];
}

function memberCallPattern(aliases: string[], members: readonly string[]): RegExp | undefined {
  if (aliases.length === 0) return undefined;
  return new RegExp(
    `\\b(?:${aliases.map(escapeRegExp).join('|')})\\.(?:${members.map(escapeRegExp).join('|')})\\s*\\(`,
  );
}

function directCallPattern(names: string[]): RegExp | undefined {
  if (names.length === 0) return undefined;
  return new RegExp(`(?<![\\w.])(?:${names.map(escapeRegExp).join('|')})\\s*\\(`);
}

function allMatchIndexes(source: string, patterns: RegExp[]): number[] {
  const indexes = new Set<number>();
  for (const pattern of patterns) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const matcher = new RegExp(pattern.source, flags);
    for (const match of source.matchAll(matcher)) indexes.add(match.index);
  }
  return [...indexes].sort((left, right) => left - right);
}

function isExplicitShellLauncher(source: string, callIndex: number): boolean {
  const call = source.slice(callIndex, callIndex + 800);
  const stringPrefix = String.raw`(?:[rRuUbBfF]{0,2})?["']`;
  const listPrefix = String.raw`\(\s*[\[(]\s*`;
  const executablePath = String.raw`(?:[^"'\r\n]*[\\/])?`;
  const posixShell = `${executablePath}(?:sh|bash|zsh|dash|fish)`;
  const windowsShell = `${executablePath}cmd(?:\\.exe)?`;
  const powerShell = `${executablePath}(?:powershell|pwsh)(?:\\.exe)?`;
  const patterns = [
    new RegExp(
      `${listPrefix}${stringPrefix}${posixShell}["']\\s*,\\s*${stringPrefix}-(?:c|lc|ic)["']`,
      'i',
    ),
    new RegExp(
      `${listPrefix}${stringPrefix}${windowsShell}["']\\s*,\\s*${stringPrefix}/c["']`,
      'i',
    ),
    new RegExp(
      `${listPrefix}${stringPrefix}${powerShell}["']\\s*,\\s*${stringPrefix}-(?:command|encodedcommand|c)["']`,
      'i',
    ),
    new RegExp(
      `${listPrefix}${stringPrefix}${executablePath}env["']\\s*,\\s*${stringPrefix}${posixShell}["']\\s*,\\s*${stringPrefix}-(?:c|lc|ic)["']`,
      'i',
    ),
  ];
  return patterns.some((pattern) => pattern.test(call));
}

function scanPythonSource(source: string, relativePath: string): SkillInstallFinding[] {
  const code = maskPythonCommentsAndStrings(source);
  const findings: SkillInstallFinding[] = [];

  for (const rule of PYTHON_RULES) {
    const scannedSource = rule.source === 'code' ? code : source;
    const match = firstMatch(scannedSource, rule.patterns);
    if (match) {
      findings.push(
        createFinding(
          rule.ruleId,
          rule.severity,
          relativePath,
          lineNumberAt(scannedSource, match.index),
          rule.message,
        ),
      );
    }
  }

  const osAliases = moduleAliases(code, 'os');
  const osDirectCalls = importedCallNames(code, 'os', ['system', 'popen']);
  const osExecMembers = [
    'execl',
    'execle',
    'execlp',
    'execlpe',
    'execv',
    'execve',
    'execvp',
    'execvpe',
  ];
  const osDirectExecCalls = importedCallNames(code, 'os', osExecMembers);
  const subprocessMembers = ['run', 'Popen', 'call', 'check_call', 'check_output'];
  const subprocessAliases = moduleAliases(code, 'subprocess');
  const subprocessDirectCalls = importedCallNames(code, 'subprocess', subprocessMembers);
  const subprocessPatterns = [
    memberCallPattern(subprocessAliases, subprocessMembers),
    directCallPattern(subprocessDirectCalls),
  ].filter((pattern): pattern is RegExp => Boolean(pattern));
  const subprocessShellPatterns = [
    ...subprocessAliases.map(
      (alias) =>
        new RegExp(
          `\\b${escapeRegExp(alias)}\\.(?:${subprocessMembers.join('|')})\\s*\\([\\s\\S]{0,500}?\\bshell\\s*=\\s*True\\b`,
        ),
    ),
    ...subprocessDirectCalls.map(
      (callName) =>
        new RegExp(
          `(?<![\\w.])${escapeRegExp(callName)}\\s*\\([\\s\\S]{0,500}?\\bshell\\s*=\\s*True\\b`,
        ),
    ),
  ];
  const asyncioAliases = moduleAliases(code, 'asyncio');
  const asyncioShellCalls = importedCallNames(code, 'asyncio', [
    'create_subprocess_shell',
  ]);
  const alwaysShellPatterns = [
    memberCallPattern(osAliases, ['system', 'popen']),
    directCallPattern(osDirectCalls),
    memberCallPattern(osAliases, osExecMembers),
    directCallPattern(osDirectExecCalls),
    memberCallPattern(asyncioAliases, ['create_subprocess_shell']),
    directCallPattern(asyncioShellCalls),
    ...subprocessShellPatterns,
  ].filter((pattern): pattern is RegExp => Boolean(pattern));
  const explicitShellIndex = allMatchIndexes(code, subprocessPatterns).find((index) =>
    isExplicitShellLauncher(source, index),
  );
  const alwaysShellMatch = firstMatch(code, alwaysShellPatterns);
  const shellIndex = Math.min(
    alwaysShellMatch?.index ?? Number.POSITIVE_INFINITY,
    explicitShellIndex ?? Number.POSITIVE_INFINITY,
  );
  if (Number.isFinite(shellIndex)) {
    findings.push(
      createFinding(
        'rc-python-shell-exec',
        'critical',
        relativePath,
        lineNumberAt(code, shellIndex),
        'Python shell execution detected',
      ),
    );
  }

  const subprocessMatch = firstMatch(code, subprocessPatterns);
  if (subprocessMatch) {
    findings.push(
      createFinding(
        'rc-python-subprocess',
        'warn',
        relativePath,
        lineNumberAt(code, subprocessMatch.index),
        'Python subprocess invocation requires review',
      ),
    );
  }

  const requestMembers = ['get', 'post', 'put', 'patch', 'delete', 'request', 'stream'];
  const networkPatterns = [
    memberCallPattern(moduleAliases(code, 'requests'), requestMembers),
    directCallPattern(importedCallNames(code, 'requests', requestMembers)),
    memberCallPattern(moduleAliases(code, 'httpx'), requestMembers),
    directCallPattern(importedCallNames(code, 'httpx', requestMembers)),
    memberCallPattern(moduleAliases(code, 'urllib.request'), ['urlopen', 'urlretrieve']),
    directCallPattern(importedCallNames(code, 'urllib.request', ['urlopen', 'urlretrieve'])),
    memberCallPattern(moduleAliases(code, 'socket'), ['socket', 'create_connection']),
    directCallPattern(importedCallNames(code, 'socket', ['socket', 'create_connection'])),
    /\baiohttp\.(?:ClientSession|request)\s*\(/,
    /\bhttp\.client\.(?:HTTPConnection|HTTPSConnection)\s*\(/,
  ].filter((pattern): pattern is RegExp => Boolean(pattern));
  const networkMatch = firstMatch(code, networkPatterns);
  if (networkMatch) {
    findings.push(
      createFinding(
        'rc-python-network',
        'warn',
        relativePath,
        lineNumberAt(code, networkMatch.index),
        'Python network access requires review',
      ),
    );
  }

  if (
    networkMatch &&
    (new RegExp(
      `\\b(?:${osAliases.map(escapeRegExp).join('|') || 'os'})\\.(?:environ|getenv)\\b`,
    ).test(code) ||
      /\b(?:environ\.get|dotenv_values|load_dotenv)\b/.test(code))
  ) {
    findings.push(
      createFinding(
        'rc-python-potential-exfiltration',
        'warn',
        relativePath,
        lineNumberAt(code, networkMatch.index),
        'Environment access combined with network activity may expose credentials',
      ),
    );
  }

  return findings;
}

async function collectSkillFiles(sourcePath: string): Promise<CollectedSkillFiles> {
  const root = path.resolve(sourcePath);
  const files: CollectedSkillFiles['files'] = [];
  const findings: SkillInstallFinding[] = [];
  const queue: Array<{ absolutePath: string; relativePath: string; depth: number }> = [
    { absolutePath: root, relativePath: '', depth: 0 },
  ];
  let scannedFiles = 0;
  let truncated = false;

  while (queue.length > 0 && !truncated) {
    const current = queue.shift();
    if (!current) break;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current.absolutePath, { withFileTypes: true });
    } catch (error) {
      findings.push(
        createFinding(
          'rc-skill-scan-failed',
          'critical',
          current.relativePath || '.',
          1,
          `Unable to read skill directory: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      continue;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = current.relativePath
        ? path.join(current.relativePath, entry.name)
        : entry.name;
      const absolutePath = path.join(current.absolutePath, entry.name);
      const normalizedPath = normalizeRelativePath(relativePath);

      if (entry.isSymbolicLink()) {
        findings.push(
          createFinding(
            'rc-skill-symlink',
            'critical',
            relativePath,
            1,
            'Symbolic links are not allowed in externally installed skills',
          ),
        );
        continue;
      }

      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() === '__pycache__') {
          findings.push(
            createFinding(
              'rc-python-compiled-artifact',
              'critical',
              relativePath,
              1,
              'Python __pycache__ directory is not allowed in a skill package',
            ),
          );
        }
        if (current.depth + 1 > MAX_SCAN_DEPTH) {
          findings.push(
            createFinding(
              'rc-skill-scan-depth',
              'critical',
              relativePath,
              1,
              `Skill directory exceeds the ${MAX_SCAN_DEPTH}-level scan limit`,
            ),
          );
          continue;
        }
        queue.push({
          absolutePath,
          relativePath,
          depth: current.depth + 1,
        });
        continue;
      }

      if (!entry.isFile()) {
        findings.push(
          createFinding(
            'rc-skill-special-file',
            'critical',
            relativePath,
            1,
            'Special filesystem entries are not allowed in a skill package',
          ),
        );
        continue;
      }

      scannedFiles += 1;
      if (scannedFiles > MAX_SCAN_FILES) {
        findings.push(
          createFinding(
            'rc-skill-scan-limit',
            'critical',
            relativePath,
            1,
            `Skill package exceeds the ${MAX_SCAN_FILES}-file scan limit`,
          ),
        );
        truncated = true;
        break;
      }

      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(absolutePath);
      } catch (error) {
        findings.push(
          createFinding(
            'rc-skill-scan-failed',
            'critical',
            relativePath,
            1,
            `Unable to inspect skill file: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        continue;
      }
      files.push({ absolutePath, relativePath: normalizedPath, size: stat.size });

      const extension = path.extname(entry.name).toLowerCase();
      const inPycache = normalizedPath
        .split('/')
        .some((segment) => segment.toLowerCase() === '__pycache__');
      if (extension === '.pyc' || extension === '.pyo' || inPycache) {
        findings.push(
          createFinding(
            'rc-python-compiled-artifact',
            'critical',
            relativePath,
            1,
            'Compiled Python artifacts are not allowed in a skill package',
          ),
        );
      }
    }
  }

  return { files, findings, scannedFiles };
}

function extractFrontmatter(content: string): string | undefined {
  const normalized = content.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---')) return undefined;
  const firstLineEnd = normalized.indexOf('\n');
  if (firstLineEnd < 0 || normalized.slice(0, firstLineEnd).trim() !== '---') return undefined;
  const lines = normalized.slice(firstLineEnd + 1).split('\n');
  const closingIndex = lines.findIndex((line) => line.trim() === '---');
  if (closingIndex < 0) return undefined;
  return lines.slice(0, closingIndex).join('\n');
}

async function parseSkillMetadata(files: CollectedSkillFiles['files']): Promise<{
  metadata?: ParsedSkillMetadata;
  findings: SkillInstallFinding[];
}> {
  const findings: SkillInstallFinding[] = [];
  const card = files.find((file) => SKILL_CARD_NAMES.includes(path.basename(file.relativePath) as never));
  if (!card) {
    findings.push(
      createFinding(
        'rc-skill-card-missing',
        'critical',
        'SKILL.md',
        1,
        'Skill package is missing a root skill card',
      ),
    );
    return { findings };
  }
  if (path.dirname(card.relativePath) !== '.') {
    findings.push(
      createFinding(
        'rc-skill-card-missing',
        'critical',
        card.relativePath,
        1,
        'Skill card must be located at the package root',
      ),
    );
    return { findings };
  }
  if (card.size > MAX_SKILL_CARD_BYTES) {
    findings.push(
      createFinding(
        'rc-skill-card-too-large',
        'critical',
        card.relativePath,
        1,
        `Skill card exceeds the ${MAX_SKILL_CARD_BYTES}-byte scan limit`,
      ),
    );
    return { findings };
  }

  let cardContent: string;
  try {
    cardContent = await fs.readFile(card.absolutePath, 'utf8');
  } catch (error) {
    findings.push(
      createFinding(
        'rc-skill-card-unreadable',
        'critical',
        card.relativePath,
        1,
        `Unable to read skill card: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return { findings };
  }

  const frontmatter = extractFrontmatter(cardContent);
  if (frontmatter === undefined) {
    findings.push(
      createFinding(
        'rc-skill-frontmatter-invalid',
        'critical',
        card.relativePath,
        1,
        'Skill card is missing a complete YAML frontmatter block',
      ),
    );
    return { findings };
  }

  let parsed: Record<string, unknown>;
  try {
    const document = parseDocument(frontmatter, {
      prettyErrors: false,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) {
      throw new Error(document.errors.map((error) => error.message).join('; '));
    }
    parsed = asRecord(document.toJS({ maxAliasCount: 20 })) ?? {};
  } catch (error) {
    findings.push(
      createFinding(
        'rc-skill-frontmatter-invalid',
        'critical',
        card.relativePath,
        1,
        `Unable to parse skill frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return { findings };
  }

  const metadata = asRecordFromYamlValue(parsed.metadata);
  const openclaw = asRecordFromYamlValue(metadata?.openclaw);
  const requiresPresent = Boolean(
    openclaw && Object.prototype.hasOwnProperty.call(openclaw, 'requires'),
  );
  const requiresRecord = asRecordFromYamlValue(openclaw?.requires);
  if (requiresPresent && !requiresRecord) {
    findings.push(
      createFinding(
        'rc-skill-requires-invalid',
        'critical',
        card.relativePath,
        lineNumberAt(cardContent, Math.max(0, cardContent.search(/\brequires\s*:/))),
        'metadata.openclaw.requires must be an object',
      ),
    );
  }

  return {
    metadata: {
      cardPath: card.relativePath,
      cardContent,
      requiresLine: lineNumberAt(
        cardContent,
        Math.max(0, cardContent.search(/\brequires\s*:/)),
      ),
      requiresDeclared: requiresPresent && Boolean(requiresRecord),
      requires: {
        bins: stringList(requiresRecord?.bins),
        anyBins: stringList(requiresRecord?.anyBins),
        env: stringList(requiresRecord?.env),
        config: stringList(requiresRecord?.config),
      },
      os: stringList(openclaw?.os),
    },
    findings,
  };
}

function resolveConfigValue(config: Record<string, unknown>, dottedPath: string): unknown {
  let current: unknown = config;
  for (const segment of dottedPath.split('.')) {
    const record = asRecord(current);
    if (!record || !Object.prototype.hasOwnProperty.call(record, segment)) return undefined;
    current = record[segment];
  }
  return current;
}

async function defaultHasBinary(binary: string): Promise<boolean> {
  if (!binary.trim()) return false;
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${binary}${extension}`);
      try {
        await fs.access(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        return true;
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return false;
}

function hasDeclaredPythonRuntime(requires: OpenClawRequirements): boolean {
  return [...requires.bins, ...requires.anyBins].some((binary) =>
    PYTHON_RUNTIME_PATTERN.test(binary),
  );
}

function formatBlockReason(findings: SkillInstallFinding[]): string {
  const details = findings
    .filter((finding) => finding.severity === 'critical')
    .slice(0, 6)
    .map((finding) => `${finding.message} (${finding.file}:${finding.line}, ${finding.ruleId})`)
    .join('; ');
  return `Skill installation blocked by Research-Claw security preflight: ${details}`;
}

export async function preflightSkillInstall(
  options: SkillPreflightOptions,
): Promise<SkillInstallPreflight> {
  const collected = await collectSkillFiles(options.sourcePath);
  const findings = [...collected.findings];
  const parsed = await parseSkillMetadata(collected.files);
  findings.push(...parsed.findings);

  const pythonFiles = collected.files
    .filter((file) => path.extname(file.relativePath).toLowerCase() === '.py')
    .map((file) => file.relativePath);

  for (const relativePath of pythonFiles) {
    const file = collected.files.find((candidate) => candidate.relativePath === relativePath);
    if (!file) continue;
    if (file.size > MAX_PYTHON_FILE_BYTES) {
      findings.push(
        createFinding(
          'rc-python-file-too-large',
          'critical',
          relativePath,
          1,
          `Python file exceeds the ${MAX_PYTHON_FILE_BYTES}-byte scan limit`,
        ),
      );
      continue;
    }
    try {
      const source = await fs.readFile(file.absolutePath, 'utf8');
      findings.push(...scanPythonSource(source, relativePath));
    } catch (error) {
      findings.push(
        createFinding(
          'rc-skill-scan-failed',
          'critical',
          relativePath,
          1,
          `Unable to scan Python source: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  const metadata = parsed.metadata;
  const requires = metadata?.requires ?? { bins: [], anyBins: [], env: [], config: [] };
  const requirementsLine = metadata?.requiresLine ?? 1;
  const cardPath = metadata?.cardPath ?? 'SKILL.md';
  if (pythonFiles.length > 0 && !metadata?.requiresDeclared) {
    findings.push(
      createFinding(
        'rc-skill-runtime-undeclared',
        'warn',
        cardPath,
        requirementsLine,
        'Python-bearing skills must declare metadata.openclaw.requires',
      ),
    );
  } else if (pythonFiles.length > 0 && !hasDeclaredPythonRuntime(requires)) {
    findings.push(
      createFinding(
        'rc-skill-python-runtime-undeclared',
        'warn',
        cardPath,
        requirementsLine,
        'Python-bearing skills must declare python, python3, or uv in requires.bins/anyBins',
      ),
    );
  }

  const hasBinary = options.hasBinary ?? defaultHasBinary;
  const binStates = await Promise.all(
    requires.bins.map(async (binary) => ({ binary, present: await hasBinary(binary) })),
  );
  const anyBinStates = await Promise.all(
    requires.anyBins.map(async (binary) => ({ binary, present: await hasBinary(binary) })),
  );
  const missingBins = binStates.filter((entry) => !entry.present).map((entry) => entry.binary);
  const anyBinSatisfied =
    requires.anyBins.length === 0 || anyBinStates.some((entry) => entry.present);
  const environment = options.env ?? process.env;
  const missingEnv = requires.env.filter((name) => !environment[name]?.trim());
  const config = options.config ?? {};
  const missingConfig = requires.config.filter((key) => !resolveConfigValue(config, key));
  const platform = options.platform ?? process.platform;
  const os = metadata?.os ?? [];
  const osSupported = os.length === 0 || os.includes(platform);

  if (missingBins.length > 0) {
    findings.push(
      createFinding(
        'rc-skill-bin-missing',
        'warn',
        cardPath,
        requirementsLine,
        `Declared binaries are unavailable: ${missingBins.join(', ')}`,
      ),
    );
  }
  if (!anyBinSatisfied) {
    findings.push(
      createFinding(
        'rc-skill-any-bin-missing',
        'warn',
        cardPath,
        requirementsLine,
        `None of the alternative binaries are available: ${requires.anyBins.join(', ')}`,
      ),
    );
  }
  if (missingEnv.length > 0) {
    findings.push(
      createFinding(
        'rc-skill-env-missing',
        'warn',
        cardPath,
        requirementsLine,
        `Declared environment variables are unavailable: ${missingEnv.join(', ')}`,
      ),
    );
  }
  if (missingConfig.length > 0) {
    findings.push(
      createFinding(
        'rc-skill-config-missing',
        'warn',
        cardPath,
        requirementsLine,
        `Declared OpenClaw config values are unavailable: ${missingConfig.join(', ')}`,
      ),
    );
  }
  if (!osSupported) {
    findings.push(
      createFinding(
        'rc-skill-os-mismatch',
        'warn',
        cardPath,
        requirementsLine,
        `Skill supports ${os.join(', ')}, but the current host is ${platform}`,
      ),
    );
  }

  const dependencies: SkillDependencyPreflight = {
    declared: metadata?.requiresDeclared ?? false,
    bins: requires.bins,
    anyBins: requires.anyBins,
    env: requires.env,
    config: requires.config,
    os,
    missingBins,
    anyBinSatisfied,
    missingEnv,
    missingConfig,
    osSupported,
  };
  const installAllowed = !findings.some((finding) => finding.severity === 'critical');
  const pythonRuntimeDeclared =
    pythonFiles.length === 0 ||
    (Boolean(metadata?.requiresDeclared) && hasDeclaredPythonRuntime(requires));
  const runtimeReady =
    installAllowed &&
    pythonRuntimeDeclared &&
    missingBins.length === 0 &&
    anyBinSatisfied &&
    missingEnv.length === 0 &&
    missingConfig.length === 0 &&
    osSupported;

  return {
    installAllowed,
    runtimeReady,
    ...(installAllowed ? {} : { blockReason: formatBlockReason(findings) }),
    findings,
    dependencies,
    pythonFiles,
    scannedFiles: collected.scannedFiles,
  };
}

/**
 * OpenClaw swallows before_install hook exceptions. This adapter therefore
 * fails closed and always returns a terminal result when its own scan fails.
 */
export async function runSkillBeforeInstall(
  event: SkillBeforeInstallEvent,
  dependencies: SkillBeforeInstallDependencies = {},
): Promise<SkillBeforeInstallResult> {
  if (event.targetType !== 'skill') return {};
  if (event.sourcePathKind !== 'directory' || !event.sourcePath) {
    const finding = createFinding(
      'rc-skill-source-unscannable',
      'critical',
      event.sourcePath ?? '.',
      1,
      'Skill install source is not a scannable directory',
    );
    return {
      findings: [finding],
      block: true,
      blockReason: formatBlockReason([finding]),
    };
  }

  try {
    const preflight = await preflightSkillInstall({
      sourcePath: event.sourcePath,
      env: dependencies.env,
      platform: dependencies.platform,
      config: dependencies.config,
      hasBinary: dependencies.hasBinary,
    });
    return {
      ...(preflight.findings.length > 0 ? { findings: preflight.findings } : {}),
      ...(preflight.installAllowed
        ? {}
        : { block: true, blockReason: preflight.blockReason ?? 'Skill install blocked' }),
    };
  } catch (error) {
    const finding = createFinding(
      'rc-skill-preflight-failed',
      'critical',
      event.sourcePath,
      1,
      `Research-Claw skill preflight failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      findings: [finding],
      block: true,
      blockReason: formatBlockReason([finding]),
    };
  }
}
