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
  /**
   * Best-effort check of the strict metadata.openclaw requires/os subset used
   * by this preflight. It is not OpenClaw's canonical Skill eligibility result.
   */
  runtimeReady: boolean;
  blockReason?: string;
  findings: SkillInstallFinding[];
  dependencies: SkillDependencyPreflight;
  pythonFiles: string[];
  scriptFiles: string[];
  promptFiles: string[];
  nativeFiles: string[];
  scannedFiles: number;
  scannedEntries: number;
  totalBytes: number;
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
  getConfig?: () => Record<string, unknown>;
  hasBinary?: (binary: string) => boolean | Promise<boolean>;
}

interface CollectedSkillFiles {
  files: Array<{ absolutePath: string; relativePath: string; size: number; mode: number }>;
  findings: SkillInstallFinding[];
  scannedFiles: number;
  scannedEntries: number;
  totalBytes: number;
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

type ScriptRule = Omit<PythonRule, 'source'>;
type PromptRule = Omit<PythonRule, 'source'>;

const MAX_SCAN_FILES = 1_000;
const MAX_SCAN_ENTRIES = 2_000;
const MAX_SCAN_DIRECTORIES = 1_000;
const MAX_SCAN_DEPTH = 16;
const MAX_SKILL_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_PYTHON_FILE_BYTES = 1024 * 1024;
const MAX_SCRIPT_FILE_BYTES = 1024 * 1024;
const MAX_OPENCLAW_CODE_FILE_BYTES = 1024 * 1024;
const MAX_PROMPT_FILE_BYTES = 1024 * 1024;
const MAX_SKILL_CARD_BYTES = 256 * 1024;
const SKILL_CARD_NAMES = ['SKILL.md', 'skill.md', 'skills.md', 'SKILL.MD'] as const;
const PYTHON_RUNTIME_PATTERN = /^(?:python(?:\d+(?:\.\d+)*)?|uv)$/i;
const DANGEROUS_PYTHON_MODULES = [
  'builtins',
  'pickle',
  'dill',
  'cloudpickle',
  'marshal',
  'yaml',
  'ctypes',
  'importlib',
  'os',
  'subprocess',
  'asyncio',
] as const;
const NETWORK_PYTHON_MODULES = [
  'requests',
  'httpx',
  'urllib.request',
  'socket',
  'aiohttp',
  'http.client',
] as const;
const SCRIPT_EXTENSIONS = new Set([
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ksh',
  '.command',
  '.ps1',
  '.psm1',
  '.bat',
  '.cmd',
]);
/**
 * These formats can be executed explicitly by runtimes available on our
 * supported desktop platforms, but do not yet have a parser-backed scanner.
 * Treating a missing executable bit as safety is incorrect (especially after
 * ZIP extraction on Windows), so external installs fail closed.
 */
const UNSUPPORTED_EXECUTABLE_EXTENSIONS = new Set([
  '.vbs',
  '.vbe',
  '.wsf',
  '.wsc',
  '.hta',
  '.reg',
  '.scpt',
  '.applescript',
  '.ipynb',
  '.r',
  '.rmd',
  '.qmd',
  '.lua',
  '.rb',
  '.pl',
  '.php',
  '.jl',
  '.m',
  '.do',
  '.sas',
]);
const UNSUPPORTED_EXECUTABLE_BASENAMES = new Set([
  'makefile',
  'gnumakefile',
  'justfile',
]);
const OPENCLAW_SCANNABLE_CODE_EXTENSIONS = new Set([
  '.js',
  '.ts',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.jsx',
  '.tsx',
]);
const PROMPT_TEXT_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.txt',
  '.rst',
  '.adoc',
  '.org',
]);
const NATIVE_OR_EXECUTABLE_EXTENSIONS = new Set([
  '.exe',
  '.dll',
  '.dylib',
  '.so',
  '.node',
  '.o',
  '.obj',
  '.a',
  '.lib',
  '.msi',
  '.msix',
  '.appx',
  '.com',
  '.scr',
  '.sys',
  '.lnk',
  '.url',
  '.pkg',
  '.dmg',
  '.xip',
  '.jar',
  '.class',
  '.wasm',
  '.apk',
  '.dex',
  '.whl',
]);
const NESTED_ARCHIVE_EXTENSIONS = new Set([
  '.zip',
  '.tar',
  '.tgz',
  '.gz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.pyz',
]);
const NATIVE_BUNDLE_EXTENSIONS = new Set(['.app']);
const FORBIDDEN_DIRECTORY_NAMES = new Set(['node_modules', '.git', '.hg', '.svn']);
const PYTHON_IDENTIFIER_SOURCE = String.raw`(?:_|\p{XID_Start})(?:_|\p{XID_Continue})*`;

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

const SCRIPT_RULES: ScriptRule[] = [
  {
    ruleId: 'rc-script-download-exec',
    severity: 'critical',
    message: 'Downloaded content is piped to or immediately launched by a shell',
    patterns: [
      /\b(?:curl|wget)\b[^\r\n|]{0,1000}\|\s*(?:[^\s|]*\/)?(?:sh|bash|zsh|dash|fish|ksh)\b/i,
      /\b(?:Invoke-WebRequest|iwr|curl)\b[^\r\n|]{0,1000}\|\s*(?:Invoke-Expression|iex)\b/i,
      /\b(?:curl|wget)\b[\s\S]{0,1000}(?:chmod\s+\+x\s+\S+|\.\s*\/\S+|(?:sh|bash|zsh|dash|fish|ksh)\s+\S+)/i,
    ],
  },
  {
    ruleId: 'rc-script-dynamic-exec',
    severity: 'critical',
    message: 'Dynamic shell or PowerShell expression execution detected',
    patterns: [
      /(^|[;&|]\s*)eval\s+/im,
      /\b(?:Invoke-Expression|iex)\b/i,
    ],
  },
  {
    ruleId: 'rc-script-encoded-command',
    severity: 'critical',
    message: 'Encoded PowerShell command execution detected',
    patterns: [
      /\b(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]{0,500}-(?:EncodedCommand|enc)\b/i,
    ],
  },
  {
    ruleId: 'rc-script-shell-launcher',
    severity: 'critical',
    message: 'Nested command-shell launcher detected',
    patterns: [
      /\b(?:sh|bash|zsh|dash|fish|ksh)\b[^\r\n]{0,200}\s-(?:c|lc|ic)\b/i,
      /\bcmd(?:\.exe)?\b[^\r\n]{0,200}\/c\b/i,
      /\b(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]{0,200}-(?:Command|c)\b/i,
    ],
  },
  {
    ruleId: 'rc-script-destructive-command',
    severity: 'critical',
    message: 'Destructive filesystem or disk command detected',
    patterns: [
      /\brm\b[^\r\n]{0,120}-(?:[A-Za-z]*r[A-Za-z]*f|[A-Za-z]*f[A-Za-z]*r)[^\r\n]{0,120}(?:\/(?:\s|$)|~(?:\/|\s|$)|\.\.(?:\/|\s|$))/i,
      /\bRemove-Item\b[^\r\n]{0,300}-Recurse\b[^\r\n]{0,300}-Force\b/i,
      /\b(?:mkfs(?:\.\w+)?|shred|diskpart)\b/i,
      /\bdd\b[^\r\n]{0,200}\bof\s*=\s*\/dev\//i,
    ],
  },
  {
    ruleId: 'rc-script-persistence',
    severity: 'critical',
    message: 'System persistence command detected',
    patterns: [
      /\bcrontab\b/i,
      /\blaunchctl\b[^\r\n]{0,200}\b(?:load|bootstrap|enable)\b/i,
      /\bschtasks(?:\.exe)?\b[^\r\n]{0,200}\/create\b/i,
      /\breg(?:\.exe)?\b[^\r\n]{0,300}\badd\b[^\r\n]{0,300}\\Run(?:Once)?\b/i,
    ],
  },
];

const PROMPT_RULES: PromptRule[] = [
  {
    ruleId: 'rc-prompt-injection-ignore-instructions',
    severity: 'critical',
    message: 'Prompt-injection wording attempts to override higher-priority instructions',
    patterns: [
      /\bignore\s+(?:all|any|previous|above|prior)\s+instructions\b/i,
      /(?:忽略|无视|覆盖|绕过|替换).{0,20}(?:此前|之前|以上|上面|先前|所有).{0,20}(?:指令|指示|规则|要求)/u,
    ],
  },
  {
    ruleId: 'rc-prompt-injection-hidden-layer',
    severity: 'critical',
    message: 'Skill text attempts to access or override hidden prompt layers',
    patterns: [
      /\b(?:reveal|show|print|display|expose|disclose|extract|access|read|override|replace|change|modify|leak)\b.{0,80}\b(?:system prompt|developer message|hidden instructions)\b/i,
      /\b(?:system prompt|developer message|hidden instructions)\b.{0,80}\b(?:reveal|show|print|display|expose|disclose|extract|access|read|override|replace|change|modify|leak)\b/i,
      /(?:输出|泄露|显示|揭示|打印|暴露|提取|读取|访问|覆盖|替换|修改).{0,40}(?:系统提示词|系统提示|开发者消息|开发者指令|隐藏指令)/u,
      /(?:系统提示词|系统提示|开发者消息|开发者指令|隐藏指令).{0,40}(?:输出|泄露|显示|揭示|打印|暴露|提取|读取|访问|覆盖|替换|修改)/u,
    ],
  },
  {
    ruleId: 'rc-prompt-injection-tool-bypass',
    severity: 'critical',
    message: 'Skill text encourages bypassing tool approval',
    patterns: [
      /\b(?:run|execute|invoke|call)\b.{0,50}\btool\b.{0,50}\bwithout\b.{0,30}\b(?:permission|approval)\b/i,
      /(?:未经|无需|不经|绕过).{0,15}(?:许可|批准|授权|确认).{0,30}(?:调用|运行|执行|使用).{0,20}(?:工具|tool)/iu,
      /(?:调用|运行|执行|使用).{0,20}(?:工具|tool).{0,30}(?:无需|不需|不用|绕过).{0,15}(?:许可|批准|授权|确认)/iu,
    ],
  },
  {
    ruleId: 'rc-prompt-shell-pipe',
    severity: 'critical',
    message: 'Skill text includes a pipe-to-shell execution pattern',
    patterns: [/\b(?:curl|wget)\b[^|\n]{0,120}\|\s*(?:sh|bash|zsh)\b/i],
  },
  {
    ruleId: 'rc-prompt-secret-exfiltration',
    severity: 'critical',
    message: 'Skill text may exfiltrate environment variables',
    patterns: [/\b(?:process\.env|env)\b.{0,80}\b(?:fetch|curl|wget|http|https)\b/i],
  },
  {
    ruleId: 'rc-prompt-destructive-delete',
    severity: 'warn',
    message: 'Skill text contains a broad destructive delete command',
    patterns: [/\brm\s+-rf\s+(?:\/|\$HOME|~|\.)/i],
  },
  {
    ruleId: 'rc-prompt-unsafe-permissions',
    severity: 'warn',
    message: 'Skill text contains an unsafe permission change',
    patterns: [/\bchmod\s+(?:-R\s+)?777\b/i],
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

/**
 * Python evaluates expressions inside f-string braces. The general string
 * masker intentionally hides literal text, then this overlay restores only
 * brace expressions at their original offsets so dangerous calls remain
 * visible without treating ordinary prose as code.
 */
function preservePythonFStringExpressions(source: string, masked: string): string {
  const output = masked.split('');
  const prefixPattern = /^(?:[fF][rR]?|[rR][fF])("""|'''|"|')/;

  for (let index = 0; index < source.length; index += 1) {
    if (index > 0 && /[_\p{XID_Continue}]/u.test(source[index - 1] ?? '')) continue;
    if (masked[index] !== source[index]) continue;
    const match = prefixPattern.exec(source.slice(index));
    if (!match) continue;
    const quote = match[1]!;
    const bodyStart = index + match[0].length;
    let cursor = bodyStart;
    while (cursor < source.length) {
      if (source.startsWith(quote, cursor)) {
        cursor += quote.length;
        break;
      }
      if (source[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (source.startsWith('{{', cursor) || source.startsWith('}}', cursor)) {
        cursor += 2;
        continue;
      }
      if (source[cursor] !== '{') {
        cursor += 1;
        continue;
      }

      let depth = 1;
      const expressionStart = cursor + 1;
      cursor += 1;
      while (cursor < source.length && depth > 0) {
        if (source[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (source[cursor] === '{') depth += 1;
        else if (source[cursor] === '}') depth -= 1;
        cursor += 1;
      }
      if (depth !== 0) break;
      const expressionEnd = cursor - 1;
      for (
        let expressionIndex = expressionStart;
        expressionIndex < expressionEnd;
        expressionIndex += 1
      ) {
        output[expressionIndex] = source[expressionIndex]!;
      }
    }
    index = Math.max(index, cursor - 1);
  }

  return output.join('');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function moduleAliases(source: string, moduleName: string): string[] {
  const aliases = new Set<string>();
  const importPattern = /\bimport\s+([^\n;]+)/gu;
  const importMemberPattern = new RegExp(
    `^([A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*)(?:\\s+as\\s+(${PYTHON_IDENTIFIER_SOURCE}))?$`,
    'u',
  );
  for (const match of source.matchAll(importPattern)) {
    for (const part of (match[1] ?? '').split(',')) {
      const parsed = importMemberPattern.exec(part.trim());
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
    'gu',
  );
  const importedMemberPattern = new RegExp(
    `^([A-Za-z_]\\w*)(?:\\s+as\\s+(${PYTHON_IDENTIFIER_SOURCE}))?$`,
    'u',
  );
  for (const match of source.matchAll(importPattern)) {
    const importedNames = (match[1] ?? '')
      .replace(/^\s*\(/, '')
      .replace(/\)\s*$/, '')
      .replace(/\\\r?\n/g, ' ');
    for (const part of importedNames.split(',')) {
      const parsed = importedMemberPattern.exec(part.trim());
      if (parsed && allowedNames.includes(parsed[1])) names.add(parsed[2] ?? parsed[1]);
    }
  }
  return [...names];
}

function wildcardImport(
  source: string,
  moduleNames: readonly string[],
): { index: number; moduleName: string } | undefined {
  let first: { index: number; moduleName: string } | undefined;
  for (const moduleName of moduleNames) {
    const pattern = new RegExp(
      `\\bfrom\\s+${escapeRegExp(moduleName)}\\s+import\\s+(?:\\(\\s*)?\\*`,
    );
    const match = pattern.exec(source);
    if (match && (!first || match.index < first.index)) {
      first = { index: match.index, moduleName };
    }
  }
  return first;
}

function memberCallPattern(aliases: string[], members: readonly string[]): RegExp | undefined {
  if (aliases.length === 0) return undefined;
  return new RegExp(
    `(?<![_\\p{XID_Continue}])(?:${aliases.map(escapeRegExp).join('|')})\\.(?:${members.map(escapeRegExp).join('|')})\\s*\\(`,
    'u',
  );
}

function directCallPattern(names: string[]): RegExp | undefined {
  if (names.length === 0) return undefined;
  return new RegExp(
    `(?<![._\\p{XID_Continue}])(?:${names.map(escapeRegExp).join('|')})\\s*\\(`,
    'u',
  );
}

function assignedMemberCallNames(
  source: string,
  aliases: string[],
  members: readonly string[],
): string[] {
  if (aliases.length === 0 || members.length === 0) return [];
  const aliasAlternation = aliases.map(escapeRegExp).join('|');
  const memberAlternation = members.map(escapeRegExp).join('|');
  const pattern = new RegExp(
    `(?<![_\\p{XID_Continue}])(${PYTHON_IDENTIFIER_SOURCE})\\s*=\\s*(?:(?:${aliasAlternation})\\.(?:${memberAlternation})|getattr\\s*\\(\\s*(?:${aliasAlternation})\\s*,\\s*["'](?:${memberAlternation})["']\\s*\\))`,
    'gu',
  );
  return [...source.matchAll(pattern)].map((match) => match[1]!).filter(Boolean);
}

function getattrCallPattern(
  aliases: string[],
  members: readonly string[],
): RegExp | undefined {
  if (aliases.length === 0 || members.length === 0) return undefined;
  return new RegExp(
    `\\bgetattr\\s*\\(\\s*(?:${aliases.map(escapeRegExp).join('|')})\\s*,\\s*["'](?:${members.map(escapeRegExp).join('|')})["']\\s*\\)\\s*\\(`,
    'u',
  );
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

function slicePythonCallExpression(source: string, callIndex: number): string {
  const openingIndex = source.indexOf('(', callIndex);
  if (openingIndex < 0) return source.slice(callIndex, callIndex + 800);
  const scanLimit = Math.min(source.length, openingIndex + 64 * 1024);
  let depth = 0;
  let quote: "'" | '"' | undefined;
  let triple = false;
  let escaped = false;

  for (let index = openingIndex; index < scanLimit; index += 1) {
    const char = source[index];
    if (quote) {
      if (triple && source.slice(index, index + 3) === quote.repeat(3)) {
        index += 2;
        quote = undefined;
        triple = false;
        escaped = false;
        continue;
      }
      if (!triple && char === quote && !escaped) {
        quote = undefined;
        escaped = false;
        continue;
      }
      if (char === '\\' && !escaped) escaped = true;
      else escaped = false;
      continue;
    }
    if (char === '#') {
      while (index < scanLimit && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      triple = source.slice(index, index + 3) === char.repeat(3);
      if (triple) index += 2;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(callIndex, index + 1);
    }
  }

  return source.slice(callIndex, scanLimit);
}

function isExplicitShellLauncher(source: string, callIndex: number): boolean {
  const call = slicePythonCallExpression(source, callIndex);
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

function maskScriptComments(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line, index) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('#!') && index === 0) return line;
      if (
        trimmed.startsWith('#')
        || /^(?:rem(?:\s|$)|::)/i.test(trimmed)
      ) {
        return ' '.repeat(line.length);
      }
      return line;
    })
    .join('\n');
}

function scanScriptSource(source: string, relativePath: string): SkillInstallFinding[] {
  const code = maskScriptComments(source);
  const findings: SkillInstallFinding[] = [];
  for (const rule of SCRIPT_RULES) {
    const match = firstMatch(code, rule.patterns);
    if (!match) continue;
    findings.push(
      createFinding(
        rule.ruleId,
        rule.severity,
        relativePath,
        lineNumberAt(code, match.index),
        rule.message,
      ),
    );
  }
  const networkMatch = firstMatch(code, [
    /\b(?:curl|wget|Invoke-WebRequest|iwr|Start-BitsTransfer)\b/i,
  ]);
  if (networkMatch) {
    findings.push(
      createFinding(
        'rc-script-network',
        'warn',
        relativePath,
        lineNumberAt(code, networkMatch.index),
        'Script network access requires review',
      ),
    );
  }
  return findings;
}

function scanPromptSource(source: string, relativePath: string): SkillInstallFinding[] {
  const findings: SkillInstallFinding[] = [];
  for (const rule of PROMPT_RULES) {
    const match = firstMatch(source, rule.patterns);
    if (!match) continue;
    findings.push(
      createFinding(
        rule.ruleId,
        rule.severity,
        relativePath,
        lineNumberAt(source, match.index),
        rule.message,
      ),
    );
  }
  return findings;
}

async function inspectPromptPayloads(
  files: CollectedSkillFiles['files'],
): Promise<{ findings: SkillInstallFinding[]; promptFiles: string[] }> {
  const findings: SkillInstallFinding[] = [];
  const promptFiles: string[] = [];

  for (const file of files) {
    const extension = path.extname(file.relativePath).toLowerCase();
    if (!PROMPT_TEXT_EXTENSIONS.has(extension)) continue;
    promptFiles.push(file.relativePath);
    if (file.size > MAX_PROMPT_FILE_BYTES) {
      findings.push(
        createFinding(
          'rc-prompt-file-too-large',
          'critical',
          file.relativePath,
          1,
          `Instruction-bearing text exceeds the ${MAX_PROMPT_FILE_BYTES}-byte prompt scan limit`,
        ),
      );
      continue;
    }
    try {
      const source = await fs.readFile(file.absolutePath, 'utf8');
      if (source.includes('\0')) {
        findings.push(
          createFinding(
            'rc-prompt-binary-content',
            'critical',
            file.relativePath,
            1,
            'Instruction-bearing text contains binary data and cannot be reviewed safely',
          ),
        );
        continue;
      }
      findings.push(...scanPromptSource(source, file.relativePath));
    } catch (error) {
      findings.push(
        createFinding(
          'rc-skill-scan-failed',
          'critical',
          file.relativePath,
          1,
          `Unable to scan instruction-bearing text: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  return { findings, promptFiles };
}

function nativeMagicName(prefix: Uint8Array): string | undefined {
  if (
    prefix.length >= 4
    && prefix[0] === 0x7f
    && prefix[1] === 0x45
    && prefix[2] === 0x4c
    && prefix[3] === 0x46
  ) return 'ELF';
  if (prefix.length >= 2 && prefix[0] === 0x4d && prefix[1] === 0x5a) return 'PE';
  if (prefix.length < 4) return undefined;
  const signature = Array.from(prefix.slice(0, 4))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const signatures: Record<string, string> = {
    feedface: 'Mach-O',
    feedfacf: 'Mach-O',
    cefaedfe: 'Mach-O',
    cffaedfe: 'Mach-O',
    cafebabe: 'fat Mach-O or Java class',
    cafebabf: 'fat Mach-O',
    bebafeca: 'fat Mach-O',
    bfbafeca: 'fat Mach-O',
    '0061736d': 'WebAssembly',
  };
  return signatures[signature];
}

async function readFilePrefix(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function hasShellShebang(prefix: Uint8Array): boolean {
  const firstLine = Buffer.from(prefix).toString('utf8').split(/\r?\n/, 1)[0] ?? '';
  return /^#!.*\b(?:sh|bash|zsh|dash|fish|ksh|pwsh|powershell)(?:\s|$)/i.test(firstLine);
}

function hasPythonShebang(prefix: Uint8Array): boolean {
  const firstLine = Buffer.from(prefix).toString('utf8').split(/\r?\n/, 1)[0] ?? '';
  return /^#!.*\b(?:python(?:\d+(?:\.\d+)*)?|uv)(?:\s|$)/i.test(firstLine);
}

function hasAnyShebang(prefix: Uint8Array): boolean {
  return prefix.length >= 2 && prefix[0] === 0x23 && prefix[1] === 0x21;
}

async function packageManifestDeclaresScripts(filePath: string): Promise<boolean> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > MAX_SCRIPT_FILE_BYTES) return true;
    const parsed = JSON.parse(content) as { scripts?: unknown };
    return Boolean(
      parsed
      && typeof parsed === 'object'
      && parsed.scripts
      && typeof parsed.scripts === 'object'
      && Object.keys(parsed.scripts).length > 0,
    );
  } catch {
    // A package manifest that cannot be inspected must not silently cross the
    // same execution boundary as a reviewed script.
    return true;
  }
}

function scanPythonSource(source: string, relativePath: string): SkillInstallFinding[] {
  const code = preservePythonFStringExpressions(
    source,
    maskPythonCommentsAndStrings(source),
  );
  const findings: SkillInstallFinding[] = [];

  const addRuleFinding = (
    rule: Omit<PythonRule, 'source' | 'patterns'>,
    patterns: RegExp[],
    scannedSource = code,
  ) => {
    if (findings.some((entry) => entry.ruleId === rule.ruleId)) return;
    const match = firstMatch(scannedSource, patterns);
    if (!match) return;
    findings.push(
      createFinding(
        rule.ruleId,
        rule.severity,
        relativePath,
        lineNumberAt(scannedSource, match.index),
        rule.message,
      ),
    );
  };

  for (const rule of PYTHON_RULES) {
    addRuleFinding(
      rule,
      rule.patterns,
      rule.source === 'code' ? code : source,
    );
  }

  const dynamicExecMembers = ['eval', 'exec', 'compile', '__import__'] as const;
  const builtinsAliases = moduleAliases(code, 'builtins');
  addRuleFinding(
    {
      ruleId: 'rc-python-dynamic-exec',
      severity: 'critical',
      message: 'Dynamic Python code execution detected',
    },
    [
      memberCallPattern(builtinsAliases, dynamicExecMembers),
      directCallPattern(importedCallNames(code, 'builtins', dynamicExecMembers)),
      directCallPattern(
        assignedMemberCallNames(code, builtinsAliases, dynamicExecMembers),
      ),
      getattrCallPattern(builtinsAliases, dynamicExecMembers),
      memberCallPattern(moduleAliases(code, 'importlib'), ['import_module', 'reload']),
      directCallPattern(importedCallNames(code, 'importlib', ['import_module', 'reload'])),
    ].filter((pattern): pattern is RegExp => Boolean(pattern)),
  );
  addRuleFinding(
    {
      ruleId: 'rc-python-dynamic-exec',
      severity: 'critical',
      message: 'Dynamic Python code execution detected',
    },
    [getattrCallPattern(builtinsAliases, dynamicExecMembers)].filter(
      (pattern): pattern is RegExp => Boolean(pattern),
    ),
    source,
  );

  const deserializationPatterns: RegExp[] = [];
  for (const moduleName of ['pickle', 'dill', 'cloudpickle', 'marshal'] as const) {
    deserializationPatterns.push(
      ...[
        memberCallPattern(moduleAliases(code, moduleName), ['load', 'loads']),
        directCallPattern(importedCallNames(code, moduleName, ['load', 'loads'])),
      ].filter((pattern): pattern is RegExp => Boolean(pattern)),
    );
  }
  deserializationPatterns.push(
    ...[
      memberCallPattern(moduleAliases(code, 'yaml'), ['load', 'unsafe_load', 'unsafe_load_all']),
      directCallPattern(importedCallNames(
        code,
        'yaml',
        ['load', 'unsafe_load', 'unsafe_load_all'],
      )),
    ].filter((pattern): pattern is RegExp => Boolean(pattern)),
  );
  addRuleFinding(
    {
      ruleId: 'rc-python-unsafe-deserialization',
      severity: 'critical',
      message: 'Unsafe Python deserialization detected',
    },
    deserializationPatterns,
  );

  addRuleFinding(
    {
      ruleId: 'rc-python-native-library-load',
      severity: 'critical',
      message: 'Dynamic native-library loading detected',
    },
    [
      memberCallPattern(
        moduleAliases(code, 'ctypes'),
        ['CDLL', 'PyDLL', 'WinDLL', 'OleDLL'],
      ),
      directCallPattern(importedCallNames(
        code,
        'ctypes',
        ['CDLL', 'PyDLL', 'WinDLL', 'OleDLL'],
      )),
    ].filter((pattern): pattern is RegExp => Boolean(pattern)),
  );

  const dangerousWildcard = wildcardImport(code, DANGEROUS_PYTHON_MODULES);
  if (dangerousWildcard) {
    findings.push(
      createFinding(
        'rc-python-wildcard-dangerous-import',
        'critical',
        relativePath,
        lineNumberAt(code, dangerousWildcard.index),
        `Wildcard import from dangerous capability module "${dangerousWildcard.moduleName}" detected`,
      ),
    );
  }
  const networkWildcard = wildcardImport(code, NETWORK_PYTHON_MODULES);
  if (networkWildcard) {
    findings.push(
      createFinding(
        'rc-python-wildcard-network-import',
        'warn',
        relativePath,
        lineNumberAt(code, networkWildcard.index),
        `Wildcard import from network-capable module "${networkWildcard.moduleName}" requires review`,
      ),
    );
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

async function inspectExecutablePayloads(
  files: CollectedSkillFiles['files'],
): Promise<{
  findings: SkillInstallFinding[];
  pythonFiles: string[];
  scriptFiles: string[];
  nativeFiles: string[];
}> {
  const findings: SkillInstallFinding[] = [];
  const pythonFiles: string[] = [];
  const scriptFiles: string[] = [];
  const nativeFiles: string[] = [];

  for (const file of files) {
    const extension = path.extname(file.relativePath).toLowerCase();
    let prefix: Buffer;
    try {
      prefix = await readFilePrefix(file.absolutePath, Math.min(file.size, 4096));
    } catch (error) {
      findings.push(
        createFinding(
          'rc-skill-scan-failed',
          'critical',
          file.relativePath,
          1,
          `Unable to inspect executable payload signature: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
      continue;
    }

    const magic = nativeMagicName(prefix);
    if (NATIVE_OR_EXECUTABLE_EXTENSIONS.has(extension) || magic) {
      nativeFiles.push(file.relativePath);
      findings.push(
        createFinding(
          'rc-native-compiled-artifact',
          'critical',
          file.relativePath,
          1,
          magic
            ? `${magic} executable or compiled payloads are not allowed in externally installed skills`
            : `Executable or compiled ${extension || 'native'} payloads are not allowed in externally installed skills`,
        ),
      );
      continue;
    }

    if (
      OPENCLAW_SCANNABLE_CODE_EXTENSIONS.has(extension)
      && file.size > MAX_OPENCLAW_CODE_FILE_BYTES
    ) {
      findings.push(
        createFinding(
          'rc-code-file-too-large',
          'critical',
          file.relativePath,
          1,
          `JavaScript/TypeScript file exceeds the ${MAX_OPENCLAW_CODE_FILE_BYTES}-byte OpenClaw scanner limit`,
        ),
      );
      continue;
    }

    if (NESTED_ARCHIVE_EXTENSIONS.has(extension)) {
      findings.push(
        createFinding(
          'rc-nested-archive',
          'critical',
          file.relativePath,
          1,
          `Opaque nested archive ${extension} cannot be fully reviewed during installation`,
        ),
      );
      continue;
    }

    const executableBasename = path.basename(file.relativePath).toLowerCase();
    if (
      UNSUPPORTED_EXECUTABLE_EXTENSIONS.has(extension)
      || UNSUPPORTED_EXECUTABLE_BASENAMES.has(executableBasename)
      || (
        executableBasename === 'package.json'
        && await packageManifestDeclaresScripts(file.absolutePath)
      )
    ) {
      scriptFiles.push(file.relativePath);
      findings.push(
        createFinding(
          'rc-unsupported-executable',
          'critical',
          file.relativePath,
          1,
          'Executable file uses a language or manifest without a supported security scanner',
        ),
      );
      continue;
    }

    if (extension === '.py' || extension === '.pyw' || hasPythonShebang(prefix)) {
      pythonFiles.push(file.relativePath);
      continue;
    }

    if (SCRIPT_EXTENSIONS.has(extension) || hasShellShebang(prefix)) {
      scriptFiles.push(file.relativePath);
      if (file.size > MAX_SCRIPT_FILE_BYTES) {
        findings.push(
          createFinding(
            'rc-script-file-too-large',
            'critical',
            file.relativePath,
            1,
            `Executable script exceeds the ${MAX_SCRIPT_FILE_BYTES}-byte scan limit`,
          ),
        );
        continue;
      }
      try {
        const source = await fs.readFile(file.absolutePath, 'utf8');
        if (source.includes('\0')) {
          findings.push(
            createFinding(
              'rc-script-binary-content',
              'critical',
              file.relativePath,
              1,
              'Executable script contains binary data and cannot be reviewed safely',
            ),
          );
          continue;
        }
        findings.push(...scanScriptSource(source, file.relativePath));
      } catch (error) {
        findings.push(
          createFinding(
            'rc-skill-scan-failed',
            'critical',
            file.relativePath,
            1,
            `Unable to scan executable script: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
      continue;
    }

    const markedExecutable = (file.mode & 0o111) !== 0;
    if (
      (markedExecutable || hasAnyShebang(prefix))
      && !OPENCLAW_SCANNABLE_CODE_EXTENSIONS.has(extension)
    ) {
      findings.push(
        createFinding(
          'rc-unsupported-executable',
          'critical',
          file.relativePath,
          1,
          'Executable file uses a language or format without a supported security scanner',
        ),
      );
    }
  }

  return { findings, pythonFiles, scriptFiles, nativeFiles };
}

async function collectSkillFiles(sourcePath: string): Promise<CollectedSkillFiles> {
  const root = path.resolve(sourcePath);
  const files: CollectedSkillFiles['files'] = [];
  const findings: SkillInstallFinding[] = [];
  const queue: Array<{ absolutePath: string; relativePath: string; depth: number }> = [
    { absolutePath: root, relativePath: '', depth: 0 },
  ];
  let scannedFiles = 0;
  let scannedEntries = 0;
  let scannedDirectories = 0;
  let totalBytes = 0;
  let truncated = false;

  while (queue.length > 0 && !truncated) {
    const current = queue.shift();
    if (!current) break;
    try {
      const currentStat = await fs.lstat(current.absolutePath);
      if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
        findings.push(
          createFinding(
            currentStat.isSymbolicLink() ? 'rc-skill-symlink' : 'rc-skill-special-file',
            'critical',
            current.relativePath || '.',
            1,
            currentStat.isSymbolicLink()
              ? 'Symbolic links are not allowed in externally installed skills'
              : 'Skill directory changed type while it was being scanned',
          ),
        );
        continue;
      }
    } catch (error) {
      findings.push(
        createFinding(
          'rc-skill-scan-failed',
          'critical',
          current.relativePath || '.',
          1,
          `Unable to inspect skill directory: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      continue;
    }
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

      scannedEntries += 1;
      if (scannedEntries > MAX_SCAN_ENTRIES) {
        findings.push(
          createFinding(
            'rc-skill-entry-limit',
            'critical',
            relativePath,
            1,
            `Skill package exceeds the ${MAX_SCAN_ENTRIES}-entry scan limit`,
          ),
        );
        truncated = true;
        break;
      }

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
        scannedDirectories += 1;
        if (scannedDirectories > MAX_SCAN_DIRECTORIES) {
          findings.push(
            createFinding(
              'rc-skill-directory-limit',
              'critical',
              relativePath,
              1,
              `Skill package exceeds the ${MAX_SCAN_DIRECTORIES}-directory scan limit`,
            ),
          );
          truncated = true;
          break;
        }
        if (FORBIDDEN_DIRECTORY_NAMES.has(entry.name.toLowerCase())) {
          findings.push(
            createFinding(
              'rc-skill-vendored-tree',
              'critical',
              relativePath,
              1,
              `Vendored dependency or repository directory "${entry.name}" is not allowed in externally installed skills`,
            ),
          );
          continue;
        }
        if (NATIVE_BUNDLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          findings.push(
            createFinding(
              'rc-native-compiled-artifact',
              'critical',
              relativePath,
              1,
              'Native application bundles are not allowed in externally installed skills',
            ),
          );
        }
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

      let stat: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        stat = await fs.lstat(absolutePath);
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
      if (stat.isSymbolicLink() || !stat.isFile()) {
        findings.push(
          createFinding(
            stat.isSymbolicLink() ? 'rc-skill-symlink' : 'rc-skill-special-file',
            'critical',
            relativePath,
            1,
            stat.isSymbolicLink()
              ? 'Symbolic links are not allowed in externally installed skills'
              : 'Skill file changed type while it was being scanned',
          ),
        );
        continue;
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
        findings.push(
          createFinding(
            'rc-skill-total-bytes',
            'critical',
            relativePath,
            1,
            `Skill package exceeds the ${MAX_SKILL_TOTAL_BYTES}-byte total size limit`,
          ),
        );
        truncated = true;
        break;
      }
      files.push({
        absolutePath,
        relativePath: normalizedPath,
        size: stat.size,
        mode: stat.mode,
      });

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

  return { files, findings, scannedFiles, scannedEntries, totalBytes };
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
  const executablePayloads = await inspectExecutablePayloads(collected.files);
  findings.push(...executablePayloads.findings);
  const promptPayloads = await inspectPromptPayloads(collected.files);
  findings.push(...promptPayloads.findings);
  const parsed = await parseSkillMetadata(collected.files);
  findings.push(...parsed.findings);

  const pythonFiles = executablePayloads.pythonFiles;

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
  if (
    executablePayloads.scriptFiles.length > 0
    && !metadata?.requiresDeclared
  ) {
    findings.push(
      createFinding(
        'rc-skill-runtime-undeclared',
        'warn',
        cardPath,
        requirementsLine,
        'Executable script-bearing skills must declare metadata.openclaw.requires',
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
  const scriptRuntimeDeclared =
    executablePayloads.scriptFiles.length === 0 || Boolean(metadata?.requiresDeclared);
  const runtimeReady =
    installAllowed &&
    pythonRuntimeDeclared &&
    scriptRuntimeDeclared &&
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
    scriptFiles: executablePayloads.scriptFiles,
    promptFiles: promptPayloads.promptFiles,
    nativeFiles: executablePayloads.nativeFiles,
    scannedFiles: collected.scannedFiles,
    scannedEntries: collected.scannedEntries,
    totalBytes: collected.totalBytes,
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
    const config = dependencies.getConfig
      ? dependencies.getConfig()
      : dependencies.config;
    const preflight = await preflightSkillInstall({
      sourcePath: event.sourcePath,
      env: dependencies.env,
      platform: dependencies.platform,
      config,
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
