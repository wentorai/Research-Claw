/**
 * Skill Search — on-demand skill loading for Research-Claw.
 *
 * Loads the research-plugins catalog.json at startup, builds an in-memory
 * index of skill names/descriptions/keywords, and provides a fuzzy search
 * function that returns SKILL.md content for matching skills.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SkillIndexEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  subcategory: string;
  keywords: string[];
  path: string;          // relative path within research-plugins
  source?: string;
}

interface CatalogJson {
  version: string;
  stats: { skills: number; agent_tools: number; curated_lists: number; total: number };
  items: Array<{
    id: string;
    type: string;
    name: string;
    description: string;
    category: string;
    subcategory: string;
    keywords: string[];
    path: string;
    source?: string;
  }>;
}

let _skillIndex: SkillIndexEntry[] = [];
let _pluginRoot: string | null = null;

/**
 * Initialize the skill index from catalog.json.
 * Call this once at plugin startup.
 */
export function initSkillIndex(researchPluginsRoot: string): number {
  _pluginRoot = researchPluginsRoot;

  const catalogPath = path.join(researchPluginsRoot, 'catalog.json');
  if (!fs.existsSync(catalogPath)) {
    return 0;
  }

  try {
    const raw = fs.readFileSync(catalogPath, 'utf-8');
    const catalog: CatalogJson = JSON.parse(raw);

    _skillIndex = catalog.items
      .filter(item => item.type === 'skill')
      .map(item => ({
        id: item.id,
        name: item.name,
        description: item.description,
        category: item.category,
        subcategory: item.subcategory,
        keywords: item.keywords ?? [],
        path: item.path,
        source: item.source,
      }));

    return _skillIndex.length;
  } catch {
    return 0;
  }
}

/**
 * Search the skill index by query string.
 * Returns top N matches ranked by relevance.
 */
export function searchSkills(query: string, maxResults = 5): SkillIndexEntry[] {
  if (_skillIndex.length === 0) return [];

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const scored = _skillIndex.map(entry => {
    let score = 0;
    const nameL = entry.name.toLowerCase();
    const descL = entry.description.toLowerCase();
    const catL = entry.category.toLowerCase();
    const subL = entry.subcategory.toLowerCase();
    const kwL = entry.keywords.map(k => k.toLowerCase());

    for (const term of terms) {
      // Exact name match (highest)
      if (nameL === term) score += 100;
      // Name contains term
      else if (nameL.includes(term)) score += 40;
      // Category/subcategory match
      if (catL === term || subL === term) score += 30;
      else if (catL.includes(term) || subL.includes(term)) score += 15;
      // Keyword exact match
      if (kwL.some(k => k === term)) score += 25;
      // Keyword partial match
      else if (kwL.some(k => k.includes(term))) score += 10;
      // Description contains term
      if (descL.includes(term)) score += 5;
    }

    return { entry, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(s => s.entry);
}

/**
 * Read a skill's SKILL.md content.
 */
export function readSkillContent(entry: SkillIndexEntry): string | null {
  if (!_pluginRoot) return null;

  const skillDir = path.join(_pluginRoot, entry.path);
  // Guard against path traversal from catalog entries
  const resolved = path.resolve(skillDir);
  if (!resolved.startsWith(path.resolve(_pluginRoot) + path.sep)) return null;

  const skillMd = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) return null;

  try {
    return fs.readFileSync(skillMd, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Get a brief listing of all skills organized by category.
 */
export function getSkillCatalogSummary(): string {
  if (_skillIndex.length === 0) return 'No skills indexed.';

  const byCategory = new Map<string, Map<string, string[]>>();
  for (const entry of _skillIndex) {
    if (!byCategory.has(entry.category)) {
      byCategory.set(entry.category, new Map());
    }
    const subs = byCategory.get(entry.category)!;
    if (!subs.has(entry.subcategory)) {
      subs.set(entry.subcategory, []);
    }
    subs.get(entry.subcategory)!.push(entry.name);
  }

  const lines: string[] = [`Skill catalog: ${_skillIndex.length} skills\n`];
  for (const [cat, subs] of Array.from(byCategory.entries()).sort()) {
    lines.push(`## ${cat}`);
    for (const [sub, names] of Array.from(subs.entries()).sort()) {
      lines.push(`  ${sub}: ${names.join(', ')}`);
    }
  }
  return lines.join('\n');
}
