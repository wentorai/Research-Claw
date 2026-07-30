/**
 * Unified Skill Registry.
 *
 * Research-Plugins leaves are not visible to OpenClaw's one-level Skill loader,
 * while workspace/managed/bundled/plugin routers are.  The registry merges both
 * inventories without eagerly placing any SKILL.md body in the model context.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type SkillLifecycle = 'candidate' | 'selected' | 'loaded';
export type SkillKind = 'skill' | 'router' | 'leaf';
export type SkillSource =
  | 'research-plugins'
  | 'workspace'
  | 'managed'
  | 'bundled'
  | 'plugin'
  | 'agents-personal'
  | 'agents-project'
  | 'extra'
  | 'unknown';

export interface OpenClawSkillStatus {
  name: string;
  description: string;
  source: string;
  bundled?: boolean;
  eligible: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  blockedByAgentFilter: boolean;
  modelVisible: boolean;
  userInvocable: boolean;
  commandVisible: boolean;
  primaryEnv?: string;
  homepage?: string;
}

export interface OpenClawSkillInfo extends OpenClawSkillStatus {
  filePath: string;
  baseDir: string;
  skillKey: string;
  always?: boolean;
}

export interface OpenClawSkillStatusReport {
  workspaceDir: string;
  managedSkillsDir: string;
  skills: OpenClawSkillStatus[];
}

export interface OpenClawSkillStatusProvider {
  list(options?: { force?: boolean }): Promise<OpenClawSkillStatusReport>;
  info(name: string, options?: { force?: boolean }): Promise<OpenClawSkillInfo | null>;
}

export interface SkillProvenance {
  provider: 'research-plugins-catalog' | 'research-plugins-manifest' | 'openclaw-status';
  statusSource?: string;
  pluginId?: string;
  category?: string;
  subcategory?: string;
}

export interface RegistrySkillEntry {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  kind: SkillKind;
  aliases: string[];
  provenance: SkillProvenance;
  available: boolean;
  status?: {
    eligible: boolean;
    disabled: boolean;
    modelVisible: boolean;
    userInvocable: boolean;
    commandVisible: boolean;
  };
  /** Internal-only load target. Never included in search candidate metadata. */
  filePath?: string;
  /** Internal-only expected Skill directory used for realpath containment. */
  baseDir?: string;
  /** Internal-only source root which the real SKILL.md must remain inside. */
  trustedRoot?: string;
}

export interface SkillCandidate {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  kind: SkillKind;
  aliases: string[];
  provenance: SkillProvenance;
  available: boolean;
  lifecycle: SkillLifecycle;
}

export interface SkillSearchResult {
  query: string;
  candidates: SkillCandidate[];
  totalMatches: number;
}

export type SkillLoadResult =
  | {
      ok: true;
      selected: SkillCandidate;
      skill: SkillCandidate & {
        contentBytes: number;
        contentChars: number;
        maxContentBytes: number;
        contentLimitPolicy: 'utf8-bytes-reject-never-truncate';
      };
      content: string;
    }
  | {
      ok: false;
      error: 'empty_selector' | 'skill_not_found' | 'skill_ambiguous' | 'skill_unavailable'
        | 'skill_info_unavailable' | 'skill_path_invalid' | 'skill_too_large' | 'skill_read_failed';
      message: string;
      candidates?: SkillCandidate[];
    };

interface CatalogItem {
  id: string;
  type: string;
  name: string;
  description: string;
  category: string;
  subcategory: string;
  keywords?: string[];
  path: string;
  source?: string;
}

interface CatalogJson {
  items?: CatalogItem[];
}

interface PluginManifest {
  id?: string;
  skills?: string[];
}

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 8;
const DEFAULT_MAX_SKILL_BYTES = 40_000;
const MAX_PUBLIC_DESCRIPTION_CHARS = 220;
const MAX_PUBLIC_ALIASES = 8;

const CHINESE_QUERY_EXPANSIONS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['系统综述', ['systematic review', 'prisma', 'evidence synthesis']],
  ['范围综述', ['scoping review', 'evidence mapping']],
  ['文献综述', ['literature review', 'systematic review']],
  ['文献检索', ['literature search', 'paper search', 'database search']],
  ['临床试验', ['clinical trial', 'clinical research', 'consort']],
  ['观察性研究', ['observational study', 'strobe', 'clinical research', 'epidemiology']],
  ['队列研究', ['cohort study', 'strobe', 'epidemiology']],
  ['病例对照', ['case control study', 'strobe', 'epidemiology']],
  ['医学科研', ['medical research', 'biomedical', 'clinical research']],
  ['生物医学', ['biomedical', 'bioinformatics', 'medical research']],
  ['统计分析', ['statistics', 'statistical analysis', 'biostatistics']],
  ['科研写作', ['academic writing', 'scientific writing']],
  ['论文写作', ['academic writing', 'paper writing']],
  ['引用管理', ['citation management', 'references', 'bibliography']],
  ['数据可视化', ['data visualization', 'dataviz', 'plot']],
];

function normalize(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
}

function stablePart(value: string): string {
  const normalized = normalize(value)
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'unnamed';
}

function unique(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const key = normalize(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    try {
      return trimmed.startsWith('"') ? JSON.parse(trimmed) as string : trimmed.slice(1, -1).replaceAll("''", "'");
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function readSkillFrontmatter(filePath: string): { name: string; description: string } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  if (!raw.startsWith('---')) return null;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return null;
  const frontmatter = raw.slice(3, end);
  let name = '';
  let description = '';
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    if (match[1] === 'name') name = unquoteYamlScalar(match[2] ?? '');
    if (match[1] === 'description') description = unquoteYamlScalar(match[2] ?? '');
  }
  if (!name.trim()) return null;
  return { name: name.trim(), description: description.trim() || name.trim() };
}

function mapOpenClawSource(source: string): SkillSource {
  switch (source) {
    case 'openclaw-workspace':
      return 'workspace';
    case 'openclaw-managed':
      return 'managed';
    case 'openclaw-bundled':
      return 'bundled';
    case 'agents-skills-personal':
      return 'agents-personal';
    case 'agents-skills-project':
      return 'agents-project';
    case 'openclaw-extra':
      return 'extra';
    default:
      return 'unknown';
  }
}

function sourceIdPart(source: SkillSource): string {
  switch (source) {
    case 'agents-personal':
      return 'agents-personal';
    case 'agents-project':
      return 'agents-project';
    default:
      return source;
  }
}

function statusAvailable(status: OpenClawSkillStatus): boolean {
  return status.eligible
    && !status.disabled
    && !status.blockedByAllowlist
    && !status.blockedByAgentFilter
    && status.modelVisible;
}

function statusProjection(status: OpenClawSkillStatus): RegistrySkillEntry['status'] {
  return {
    eligible: status.eligible,
    disabled: status.disabled,
    modelVisible: status.modelVisible,
    userInvocable: status.userInvocable,
    commandVisible: status.commandVisible,
  };
}

function toCandidate(entry: RegistrySkillEntry, lifecycle: SkillLifecycle): SkillCandidate {
  const description = entry.description.length > MAX_PUBLIC_DESCRIPTION_CHARS
    ? `${entry.description.slice(0, MAX_PUBLIC_DESCRIPTION_CHARS - 1)}…`
    : entry.description;
  return {
    id: entry.id,
    name: entry.name,
    description,
    source: entry.source,
    kind: entry.kind,
    aliases: entry.aliases.slice(0, MAX_PUBLIC_ALIASES),
    provenance: { ...entry.provenance },
    available: entry.available,
    lifecycle,
  };
}

function searchTerms(query: string): string[] {
  const normalized = normalize(query);
  const expanded = [normalized];
  for (const [phrase, aliases] of CHINESE_QUERY_EXPANSIONS) {
    if (normalized.includes(normalize(phrase))) expanded.push(...aliases.map(normalize));
  }
  const tokens = expanded.flatMap((value) => [
    value,
    ...value.split(/[^\p{L}\p{N}._-]+/u).filter((token) => token.length >= 2),
  ]);
  return unique(tokens.map(normalize));
}

function scoreEntry(entry: RegistrySkillEntry, query: string, terms: string[]): number {
  const queryNormalized = normalize(query);
  const id = normalize(entry.id);
  const name = normalize(entry.name);
  const description = normalize(entry.description);
  const aliases = entry.aliases.map(normalize);
  const category = normalize(entry.provenance.category ?? '');
  const subcategory = normalize(entry.provenance.subcategory ?? '');

  let score = 0;
  if (id === queryNormalized) score += 2_000;
  if (name === queryNormalized) score += 1_500;
  if (aliases.includes(queryNormalized)) score += 1_100;

  for (const term of terms) {
    if (name === term) score += 700;
    else if (name.includes(term)) score += 260;
    if (aliases.some((alias) => alias === term)) score += 320;
    else if (aliases.some((alias) => alias.includes(term))) score += 130;
    if (category === term || subcategory === term) score += 180;
    else if (category.includes(term) || subcategory.includes(term)) score += 70;
    if (description.includes(term)) score += 45;
  }

  return score;
}

export class SkillRegistry {
  private entries: RegistrySkillEntry[] = [];

  constructor(private readonly options: {
    researchPluginsRoot?: string | null;
    openClaw: OpenClawSkillStatusProvider;
    maxSkillBytes?: number;
  }) {}

  async snapshot(options?: { force?: boolean }): Promise<RegistrySkillEntry[]> {
    await this.refresh(options);
    return this.entries.map((entry) => ({
      ...entry,
      aliases: [...entry.aliases],
      provenance: { ...entry.provenance },
      status: entry.status ? { ...entry.status } : undefined,
    }));
  }

  async search(
    query: string,
    options?: { maxResults?: number; force?: boolean },
  ): Promise<SkillSearchResult> {
    await this.refresh({ force: options?.force });
    const trimmed = query.trim();
    if (!trimmed) return { query, candidates: [], totalMatches: 0 };
    const terms = searchTerms(trimmed);
    const scored = this.entries
      .map((entry) => ({ entry, score: scoreEntry(entry, trimmed, terms) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => (
        right.score - left.score
        || Number(right.entry.available) - Number(left.entry.available)
        || Number(right.entry.source === 'workspace') - Number(left.entry.source === 'workspace')
        || left.entry.name.localeCompare(right.entry.name, 'en')
        || left.entry.id.localeCompare(right.entry.id, 'en')
      ));
    const maxResults = Math.min(
      MAX_RESULTS,
      Math.max(1, Math.floor(options?.maxResults ?? DEFAULT_MAX_RESULTS)),
    );
    return {
      query,
      totalMatches: scored.length,
      candidates: scored.slice(0, maxResults).map(({ entry }) => toCandidate(entry, 'candidate')),
    };
  }

  async catalogSummary(options?: { force?: boolean }): Promise<{
    total: number;
    bySource: Record<string, number>;
    byKind: Record<string, number>;
    researchPluginCategories: Record<string, number>;
  }> {
    await this.refresh(options);
    const bySource: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    const researchPluginCategories: Record<string, number> = {};
    for (const entry of this.entries) {
      bySource[entry.source] = (bySource[entry.source] ?? 0) + 1;
      byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
      const category = entry.provenance.category;
      if (entry.source === 'research-plugins' && category) {
        researchPluginCategories[category] = (researchPluginCategories[category] ?? 0) + 1;
      }
    }
    return { total: this.entries.length, bySource, byKind, researchPluginCategories };
  }

  async load(selector: string, options?: { force?: boolean }): Promise<SkillLoadResult> {
    await this.refresh({ force: options?.force });
    const raw = selector.trim();
    if (!raw) {
      return { ok: false, error: 'empty_selector', message: 'A stable Skill id is required.' };
    }
    const normalized = normalize(raw);
    let matches = this.entries.filter((entry) => normalize(entry.id) === normalized);
    if (matches.length === 0) {
      matches = this.entries.filter((entry) => (
        normalize(entry.name) === normalized
        || entry.aliases.some((alias) => normalize(alias) === normalized)
      ));
    }
    if (matches.length === 0) {
      return {
        ok: false,
        error: 'skill_not_found',
        message: `No exact Skill matches "${raw}". Run skill_search first and pass a stable id.`,
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        error: 'skill_ambiguous',
        message: `"${raw}" matches multiple Skills. Select one stable id.`,
        candidates: matches.map((entry) => toCandidate(entry, 'candidate')),
      };
    }

    const entry = matches[0]!;
    const selected = toCandidate(entry, 'selected');
    if (!entry.available) {
      return {
        ok: false,
        error: 'skill_unavailable',
        message: `Skill "${entry.name}" is disabled, blocked, ineligible, or hidden from the model.`,
        candidates: [selected],
      };
    }

    let filePath = entry.filePath;
    let baseDir = entry.baseDir;
    let trustedRoot = entry.trustedRoot;
    if (!filePath) {
      const info = await this.options.openClaw.info(entry.name, { force: options?.force });
      if (!info || normalize(info.name) !== normalize(entry.name)) {
        return {
          ok: false,
          error: 'skill_info_unavailable',
          message: `OpenClaw could not resolve current status details for "${entry.name}".`,
          candidates: [selected],
        };
      }
      if (!statusAvailable(info)) {
        return {
          ok: false,
          error: 'skill_unavailable',
          message: `Skill "${entry.name}" is no longer available to the agent.`,
          candidates: [selected],
        };
      }
      filePath = info.filePath;
      baseDir = info.baseDir;
      trustedRoot ??= info.baseDir;
    }

    if (
      !filePath
      || !baseDir
      || !trustedRoot
      || path.basename(filePath).toLocaleLowerCase('en-US') !== 'skill.md'
    ) {
      return {
        ok: false,
        error: 'skill_path_invalid',
        message: `Resolved path for "${entry.name}" is not a SKILL.md file.`,
        candidates: [selected],
      };
    }

    let realFilePath: string;
    try {
      const realTrustedRoot = fs.realpathSync(trustedRoot);
      const realBaseDir = fs.realpathSync(baseDir);
      realFilePath = fs.realpathSync(filePath);
      if (
        !isPathInside(realTrustedRoot, realFilePath)
        || !isPathInside(realTrustedRoot, realBaseDir)
        || path.dirname(realFilePath) !== realBaseDir
        || path.basename(realFilePath).toLocaleLowerCase('en-US') !== 'skill.md'
      ) {
        return {
          ok: false,
          error: 'skill_path_invalid',
          message: `Resolved path for "${entry.name}" escapes its trusted Skill root.`,
          candidates: [selected],
        };
      }
    } catch {
      return {
        ok: false,
        error: 'skill_path_invalid',
        message: `Resolved path for "${entry.name}" cannot be verified.`,
        candidates: [selected],
      };
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(realFilePath);
    } catch {
      return {
        ok: false,
        error: 'skill_read_failed',
        message: `SKILL.md for "${entry.name}" is not readable.`,
        candidates: [selected],
      };
    }
    const maxSkillBytes = Math.max(1, this.options.maxSkillBytes ?? DEFAULT_MAX_SKILL_BYTES);
    if (!stat.isFile()) {
      return {
        ok: false,
        error: 'skill_path_invalid',
        message: `Resolved path for "${entry.name}" is not a regular file.`,
        candidates: [selected],
      };
    }
    if (stat.size > maxSkillBytes) {
      return {
        ok: false,
        error: 'skill_too_large',
        message: `SKILL.md for "${entry.name}" exceeds the ${maxSkillBytes}-byte load limit.`,
        candidates: [selected],
      };
    }

    try {
      const content = fs.readFileSync(realFilePath, 'utf8');
      const contentBytes = Buffer.byteLength(content, 'utf8');
      if (contentBytes > maxSkillBytes) {
        return {
          ok: false,
          error: 'skill_too_large',
          message: `SKILL.md for "${entry.name}" exceeds the ${maxSkillBytes}-byte UTF-8 load limit.`,
          candidates: [selected],
        };
      }
      return {
        ok: true,
        selected,
        skill: {
          ...toCandidate(entry, 'loaded'),
          contentBytes,
          contentChars: content.length,
          maxContentBytes: maxSkillBytes,
          contentLimitPolicy: 'utf8-bytes-reject-never-truncate',
        },
        content,
      };
    } catch {
      return {
        ok: false,
        error: 'skill_read_failed',
        message: `SKILL.md for "${entry.name}" could not be read.`,
        candidates: [selected],
      };
    }
  }

  private async refresh(options?: { force?: boolean }): Promise<void> {
    const entries = this.loadResearchPluginEntries();
    const routerByName = new Map<string, RegistrySkillEntry>();
    for (const entry of entries) {
      if (entry.kind === 'router') routerByName.set(normalize(entry.name), entry);
    }

    const report = await this.options.openClaw.list({ force: options?.force });
    for (const status of report.skills) {
      if (!status?.name?.trim()) continue;
      const router = routerByName.get(normalize(status.name));
      if (router && status.source === 'openclaw-extra') {
        router.available = statusAvailable(status);
        router.status = statusProjection(status);
        router.provenance.statusSource = status.source;
        router.aliases = unique([...router.aliases, status.name]);
        continue;
      }
      const source = mapOpenClawSource(status.source);
      entries.push({
        id: `oc:${sourceIdPart(source)}:${stablePart(status.name)}`,
        name: status.name,
        description: status.description?.trim() || status.name,
        source,
        kind: 'skill',
        aliases: unique([status.name]),
        provenance: {
          provider: 'openclaw-status',
          statusSource: status.source,
        },
        available: statusAvailable(status),
        status: statusProjection(status),
        trustedRoot: source === 'workspace'
          ? report.workspaceDir
          : source === 'managed'
            ? report.managedSkillsDir
            : undefined,
      });
    }

    const deduped = new Map<string, RegistrySkillEntry>();
    for (const entry of entries) deduped.set(entry.id, entry);
    this.entries = [...deduped.values()].sort((left, right) => (
      left.id.localeCompare(right.id, 'en')
    ));
  }

  private loadResearchPluginEntries(): RegistrySkillEntry[] {
    const root = this.options.researchPluginsRoot;
    if (!root) return [];
    const resolvedRoot = path.resolve(root);
    const catalogPath = path.join(resolvedRoot, 'catalog.json');
    const manifestPath = path.join(resolvedRoot, 'openclaw.plugin.json');
    const entries: RegistrySkillEntry[] = [];

    try {
      const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as CatalogJson;
      for (const item of catalog.items ?? []) {
        if (item.type !== 'skill' || !item.id?.trim() || !item.name?.trim()) continue;
        const filePath = path.resolve(resolvedRoot, item.path, 'SKILL.md');
        if (!isPathInside(resolvedRoot, filePath)) continue;
        entries.push({
          id: `rp:${stablePart(item.id)}`,
          name: item.name,
          description: item.description?.trim() || item.name,
          source: 'research-plugins',
          kind: 'leaf',
          aliases: unique([
            item.name,
            item.id,
            item.category,
            item.subcategory,
            ...(item.keywords ?? []),
          ]),
          provenance: {
            provider: 'research-plugins-catalog',
            pluginId: 'research-plugins',
            category: item.category,
            subcategory: item.subcategory,
          },
          available: fs.existsSync(filePath),
          filePath,
          baseDir: path.dirname(filePath),
          trustedRoot: resolvedRoot,
        });
      }
    } catch {
      // A missing or malformed RP catalog must not hide OpenClaw-native Skills.
    }

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PluginManifest;
      const pluginId = manifest.id?.trim() || 'research-plugins';
      for (const rawRoot of manifest.skills ?? []) {
        const skillsRoot = path.resolve(resolvedRoot, rawRoot);
        if (!isPathInside(resolvedRoot, skillsRoot) || !fs.existsSync(skillsRoot)) continue;
        const directSkill = path.join(skillsRoot, 'SKILL.md');
        const candidates = fs.existsSync(directSkill)
          ? [directSkill]
          : fs.readdirSync(skillsRoot, { withFileTypes: true })
            .filter((item) => item.isDirectory() || item.isSymbolicLink())
            .map((item) => path.join(skillsRoot, item.name, 'SKILL.md'))
            .filter((candidate) => fs.existsSync(candidate))
            .sort();
        for (const filePath of candidates) {
          if (!isPathInside(resolvedRoot, filePath)) continue;
          const frontmatter = readSkillFrontmatter(filePath);
          if (!frontmatter) continue;
          const relative = path.relative(path.join(resolvedRoot, 'skills'), path.dirname(filePath));
          const [category = '', subcategory = ''] = relative.split(path.sep);
          entries.push({
            id: `rp-router:${stablePart(frontmatter.name)}`,
            name: frontmatter.name,
            description: frontmatter.description,
            source: 'research-plugins',
            kind: 'router',
            aliases: unique([frontmatter.name, category, subcategory]),
            provenance: {
              provider: 'research-plugins-manifest',
              pluginId,
              category,
              subcategory,
            },
            // Plugin routers are candidates only after the OpenClaw status
            // inventory confirms this exact router is active/visible. This
            // avoids bypassing a disabled or precedence-shadowed plugin root.
            available: false,
            filePath,
            baseDir: path.dirname(filePath),
            trustedRoot: resolvedRoot,
          });
        }
      }
    } catch {
      // Leaves remain searchable even if a third-party manifest is malformed.
    }
    return entries;
  }
}
