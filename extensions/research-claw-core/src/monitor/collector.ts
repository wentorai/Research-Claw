import { createHash } from 'node:crypto';
import type { Monitor } from './service.js';

export interface MonitorCandidate {
  title: string;
  url: string;
  source: string;
  fingerprint: string;
  published_at?: string;
  summary?: string;
  raw?: Record<string, unknown>;
}

export interface MonitorCollectorResult {
  monitor_id: string;
  source_type: string;
  target: string;
  collected_at: string;
  strategy: string;
  candidates: MonitorCandidate[];
  errors: string[];
}

export interface MonitorCollectorOptions {
  limit?: number;
  timeoutMs?: number;
}

const DEFAULT_LIMIT = 25;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BODY_CHARS = 1_000_000;

export async function collectMonitorCandidates(
  monitor: Monitor,
  opts: MonitorCollectorOptions = {},
): Promise<MonitorCollectorResult> {
  const limit = clampLimit(opts.limit);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const errors: string[] = [];

  try {
    const candidates = await collectBySourceType(monitor, { limit, timeoutMs });
    return {
      monitor_id: monitor.id,
      source_type: monitor.source_type,
      target: monitor.target,
      collected_at: new Date().toISOString(),
      strategy: strategyFor(monitor.source_type),
      candidates: candidates.slice(0, limit),
      errors,
    };
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    return {
      monitor_id: monitor.id,
      source_type: monitor.source_type,
      target: monitor.target,
      collected_at: new Date().toISOString(),
      strategy: strategyFor(monitor.source_type),
      candidates: [],
      errors,
    };
  }
}

async function collectBySourceType(
  monitor: Monitor,
  opts: Required<Pick<MonitorCollectorOptions, 'limit' | 'timeoutMs'>>,
): Promise<MonitorCandidate[]> {
  const type = monitor.source_type.toLowerCase();
  if (type === 'feed' || type === 'rss' || type === 'atom') return collectFeed(monitor, opts);
  if (type === 'api') return collectApi(monitor, opts);
  if (type === 'github' || type === 'code') return collectGithub(monitor, opts);
  if (type === 'web' || type === 'webpage') return collectWeb(monitor, opts);
  if (isUrl(monitor.target)) return collectWeb(monitor, opts);
  return [];
}

function strategyFor(sourceType: string): string {
  const type = sourceType.toLowerCase();
  if (type === 'feed' || type === 'rss' || type === 'atom') return 'rss';
  if (type === 'api') return 'api';
  if (type === 'github' || type === 'code') return 'github';
  if (type === 'web' || type === 'webpage') return 'web';
  return 'fallback';
}

async function collectFeed(
  monitor: Monitor,
  opts: Required<Pick<MonitorCollectorOptions, 'limit' | 'timeoutMs'>>,
): Promise<MonitorCandidate[]> {
  if (!isUrl(monitor.target)) return [];
  const body = await fetchText(monitor.target, opts.timeoutMs);
  const items = parseFeedItems(body).map((item) => ({
    title: item.title || item.link || 'Untitled feed item',
    url: item.link || monitor.target,
    source: hostOf(monitor.target),
    published_at: item.published_at,
    summary: item.summary,
    fingerprint: fingerprint('rss', item.guid || item.link || item.title || ''),
    raw: { guid: item.guid },
  }));
  return filterByKeywords(items, monitor.filters).slice(0, opts.limit);
}

async function collectApi(
  monitor: Monitor,
  opts: Required<Pick<MonitorCollectorOptions, 'limit' | 'timeoutMs'>>,
): Promise<MonitorCandidate[]> {
  if (!isUrl(monitor.target)) return [];
  const json = await fetchJson(monitor.target, opts.timeoutMs);
  const rows = Array.isArray(json)
    ? json
    : json && typeof json === 'object'
      ? Object.values(json as Record<string, unknown>).find(Array.isArray) ?? []
      : [];

  const candidates = rows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
    .map((row) => normalizeApiRow(row, monitor.target));
  return filterByKeywords(candidates, monitor.filters).slice(0, opts.limit);
}

async function collectGithub(
  monitor: Monitor,
  opts: Required<Pick<MonitorCollectorOptions, 'limit' | 'timeoutMs'>>,
): Promise<MonitorCandidate[]> {
  const repo = parseGithubRepo(monitor.target);
  if (!repo) {
    if (isUrl(monitor.target)) return collectWeb(monitor, opts);
    return [];
  }

  const [owner, name] = repo.split('/');
  const url = `https://api.github.com/repos/${owner}/${name}/releases?per_page=${Math.min(opts.limit, 50)}`;
  const rows = await fetchJson(url, opts.timeoutMs);
  if (!Array.isArray(rows)) return [];

  return rows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
    .map((row) => {
      const tag = stringField(row, 'tag_name') || stringField(row, 'name');
      const htmlUrl = stringField(row, 'html_url') || `https://github.com/${repo}/releases`;
      return {
        title: stringField(row, 'name') || tag || `${repo} release`,
        url: htmlUrl,
        source: `github:${repo}`,
        published_at: stringField(row, 'published_at') || stringField(row, 'created_at') || undefined,
        summary: stringField(row, 'body')?.slice(0, 1000),
        fingerprint: fingerprint('gh', `${repo}:release:${tag || htmlUrl}`),
        raw: { tag_name: tag },
      };
    })
    .slice(0, opts.limit);
}

async function collectWeb(
  monitor: Monitor,
  opts: Required<Pick<MonitorCollectorOptions, 'limit' | 'timeoutMs'>>,
): Promise<MonitorCandidate[]> {
  if (!isUrl(monitor.target)) return [];
  const body = await fetchText(monitor.target, opts.timeoutMs);
  const links = parseHtmlLinks(body, monitor.target);
  const dynamic = parseDynamicHtmlCandidates(body, monitor.target);
  const merged = mergeCandidates([...links, ...dynamic]);
  const challenge = detectDynamicPageChallenge(body);
  if (challenge && merged.length === 0) {
    throw new Error(`browser_fallback_required: ${challenge}`);
  }

  const filtered = filterByKeywords(merged, monitor.filters);
  if (filtered.length > 0) return filtered.slice(0, opts.limit);

  const title = extractTitle(body) || monitor.name;
  const text = stripHtml(body).slice(0, 1200);
  if (isWeakWebText(text)) {
    throw new Error(`browser_fallback_required: static fetch returned weak content for ${hostOf(monitor.target)}`);
  }

  return [{
    title,
    url: monitor.target,
    source: hostOf(monitor.target),
    summary: text,
    fingerprint: fingerprint('web', `${monitor.target}:${hash(text)}`),
  }];
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'Research-Claw-Monitor/0.7' },
    });
    if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
    return (await res.text()).slice(0, MAX_BODY_CHARS);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const text = await fetchText(url, timeoutMs);
  return JSON.parse(text) as unknown;
}

function parseFeedItems(xml: string): Array<{ title: string; link: string; guid: string; published_at?: string; summary?: string }> {
  const itemBlocks = matchBlocks(xml, 'item');
  const entryBlocks = matchBlocks(xml, 'entry');
  const blocks = itemBlocks.length > 0 ? itemBlocks : entryBlocks;

  return blocks.map((block) => {
    const atomLink = /<link\b[^>]*href=["']([^"']+)["'][^>]*>/i.exec(block)?.[1] ?? '';
    return {
      title: decodeEntities(tagText(block, 'title')),
      link: decodeEntities(tagText(block, 'link') || atomLink),
      guid: decodeEntities(tagText(block, 'guid') || tagText(block, 'id')),
      published_at: decodeEntities(tagText(block, 'pubDate') || tagText(block, 'published') || tagText(block, 'updated')) || undefined,
      summary: decodeEntities(tagText(block, 'description') || tagText(block, 'summary') || tagText(block, 'content')) || undefined,
    };
  });
}

function matchBlocks(text: string, tag: string): string[] {
  return [...text.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi'))].map((m) => m[1] ?? '');
}

function tagText(text: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(text);
  return stripCdata(match?.[1] ?? '').trim();
}

function parseHtmlLinks(html: string, baseUrl: string): MonitorCandidate[] {
  const anchors = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const seen = new Set<string>();
  const candidates: MonitorCandidate[] = [];

  for (const match of anchors) {
    const href = canonicalizeUrl(absolutize(match[1] ?? '', baseUrl));
    const title = stripHtml(match[2] ?? '').trim();
    if (!href || !title || seen.has(href)) continue;
    seen.add(href);
    candidates.push({
      title: decodeEntities(title).slice(0, 240),
      url: href,
      source: hostOf(baseUrl),
      fingerprint: fingerprint('web', href),
    });
  }

  return candidates;
}

function parseDynamicHtmlCandidates(html: string, baseUrl: string): MonitorCandidate[] {
  const candidates: MonitorCandidate[] = [];
  for (const text of extractScriptPayloads(html)) {
    candidates.push(...extractCandidatesFromJsonPayload(text, baseUrl));
    candidates.push(...extractCandidatesFromText(text, baseUrl));
  }

  const metaDescription = metaContent(html, 'description');
  const ogTitle = metaContent(html, 'og:title') || extractTitle(html);
  const ogUrl = canonicalizeUrl(metaContent(html, 'og:url') || baseUrl);
  if (ogTitle && metaDescription) {
    candidates.push({
      title: decodeEntities(ogTitle).slice(0, 240),
      url: ogUrl,
      source: hostOf(baseUrl),
      summary: decodeEntities(metaDescription).slice(0, 1000),
      fingerprint: fingerprint('web', ogUrl),
      raw: { source: 'meta' },
    });
  }

  return mergeCandidates(candidates);
}

function extractCandidatesFromJsonPayload(text: string, baseUrl: string): MonitorCandidate[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    const rows: Record<string, unknown>[] = [];
    collectCandidateObjects(parsed, rows);
    return rows.map((row) => {
      const url = canonicalizeUrl(
        stringField(row, 'url')
        || stringField(row, 'link')
        || stringField(row, 'href')
        || stringField(row, 'html_url')
        || baseUrl,
      );
      return {
        title: stringField(row, 'title')
          || stringField(row, 'name')
          || stringField(row, 'headline')
          || inferTitleFromUrl(url)
          || 'Untitled web item',
        url,
        source: hostOf(baseUrl),
        published_at: stringField(row, 'published_at') || stringField(row, 'datePublished') || stringField(row, 'created_at') || undefined,
        summary: stringField(row, 'summary') || stringField(row, 'description') || stringField(row, 'content') || undefined,
        fingerprint: fingerprint('web', url),
        raw: { source: 'json-script' },
      };
    });
  } catch {
    return [];
  }
}

function collectCandidateObjects(value: unknown, rows: Record<string, unknown>[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectCandidateObjects(item, rows);
    return;
  }

  const row = value as Record<string, unknown>;
  const hasTitle = ['title', 'name', 'headline'].some((key) => stringField(row, key));
  const hasUrl = ['url', 'link', 'href', 'html_url'].some((key) => stringField(row, key));
  if (hasTitle && hasUrl) rows.push(row);

  for (const nested of Object.values(row)) {
    collectCandidateObjects(nested, rows);
  }
}

function extractScriptPayloads(html: string): string[] {
  const payloads: string[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = match[1] ?? '';
    const body = (match[2] ?? '').trim();
    if (!body) continue;
    if (/application\/ld\+json|application\/json|__NEXT_DATA__/i.test(attrs) || looksLikeUsefulScriptData(body)) {
      payloads.push(decodeEntities(stripCdata(body)));
    }
  }
  return payloads;
}

function looksLikeUsefulScriptData(text: string): boolean {
  return /https?:\\?\//i.test(text) && /title|name|summary|description|url|href/i.test(text);
}

function extractCandidatesFromText(text: string, baseUrl: string): MonitorCandidate[] {
  const candidates: MonitorCandidate[] = [];
  const urls = [...text.matchAll(/https?:\\?\/\\?\/[^"'\s<>)]+/gi)]
    .map((m) => normalizeEscapedUrl(m[0] ?? ''))
    .filter(Boolean)
    .slice(0, 100);

  for (const url of urls) {
    const title = nearbyJsonString(text, url, ['title', 'name', 'headline']) || inferTitleFromUrl(url);
    if (!title) continue;
    candidates.push({
      title: decodeEntities(title).slice(0, 240),
      url: canonicalizeUrl(url),
      source: hostOf(baseUrl),
      summary: nearbyJsonString(text, url, ['summary', 'description', 'content'])?.slice(0, 1000),
      fingerprint: fingerprint('web', canonicalizeUrl(url)),
      raw: { source: 'script' },
    });
  }

  return candidates;
}

function nearbyJsonString(text: string, anchor: string, keys: string[]): string | undefined {
  const index = text.indexOf(anchor);
  const windowText = index >= 0
    ? text.slice(Math.max(0, index - 3000), Math.min(text.length, index + 3000))
    : text;
  for (const key of keys) {
    const pattern = new RegExp(`["']${escapeRegExp(key)}["']\\s*:\\s*["']((?:\\\\.|[^"'\\\\]){1,500})["']`, 'i');
    const value = pattern.exec(windowText)?.[1];
    if (value) return normalizeJsonString(value);
  }
  return undefined;
}

function normalizeEscapedUrl(value: string): string {
  return value.replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
}

function normalizeJsonString(value: string): string {
  return value
    .replace(/\\u0026/g, '&')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferTitleFromUrl(value: string): string {
  try {
    const url = new URL(value);
    const last = url.pathname.split('/').filter(Boolean).pop() || url.host;
    return decodeURIComponent(last).replace(/[-_]+/g, ' ').trim();
  } catch {
    return '';
  }
}

function metaContent(html: string, name: string): string {
  const escaped = escapeRegExp(name);
  const pattern = new RegExp(`<meta\\b(?=[^>]*(?:name|property)=["']${escaped}["'])[^>]*content=["']([^"']*)["'][^>]*>`, 'i');
  return decodeEntities(pattern.exec(html)?.[1] ?? '').trim();
}

function mergeCandidates(items: MonitorCandidate[]): MonitorCandidate[] {
  const seen = new Set<string>();
  const merged: MonitorCandidate[] = [];
  for (const item of items) {
    const key = canonicalizeUrl(item.url || item.fingerprint);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function detectDynamicPageChallenge(html: string): string | null {
  const text = stripHtml(html).toLowerCase();
  if (/为了更好的访问体验|请进行验证|人机验证|验证码|安全验证/.test(text)) {
    return 'anti-bot verification page';
  }
  if (/enable javascript|please enable javascript|requires javascript/.test(text)) {
    return 'javascript-rendered page';
  }
  return null;
}

function isWeakWebText(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length < 80) return true;
  return /^(#\s*)?为了更好的访问体验，请进行验证$/i.test(normalized);
}

function normalizeApiRow(row: Record<string, unknown>, sourceUrl: string): MonitorCandidate {
  const id = stringField(row, 'id') || stringField(row, 'guid') || stringField(row, 'url') || JSON.stringify(row).slice(0, 300);
  const url = stringField(row, 'url') || stringField(row, 'html_url') || stringField(row, 'link') || sourceUrl;
  return {
    title: stringField(row, 'title') || stringField(row, 'name') || stringField(row, 'headline') || 'Untitled API item',
    url,
    source: hostOf(sourceUrl),
    published_at: stringField(row, 'published_at') || stringField(row, 'published') || stringField(row, 'created_at') || undefined,
    summary: stringField(row, 'summary') || stringField(row, 'description') || stringField(row, 'body') || undefined,
    fingerprint: fingerprint('api', id),
    raw: row,
  };
}

function filterByKeywords<T extends MonitorCandidate>(items: T[], filters: Record<string, unknown>): T[] {
  const keywords = Array.isArray(filters.keywords)
    ? filters.keywords.map(String).map((s) => s.trim().toLowerCase()).filter(Boolean)
    : [];
  if (keywords.length === 0) return items;
  return items.filter((item) => {
    const haystack = `${item.title}\n${item.summary ?? ''}\n${item.url}`.toLowerCase();
    return keywords.some((kw) => haystack.includes(kw));
  });
}

function parseGithubRepo(target: string): string | null {
  const trimmed = target.trim();
  const direct = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(trimmed);
  if (direct) return `${direct[1]}/${direct[2]}`;
  const url = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/i.exec(trimmed);
  if (url) return `${url[1]}/${url[2].replace(/\.git$/, '')}`;
  return null;
}

function stringField(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extractTitle(html: string): string {
  return decodeEntities(tagText(html, 'title'));
}

function stripHtml(html: string): string {
  return html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripCdata(text: string): string {
  return text.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function absolutize(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return '';
  }
}

function canonicalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|sourceSSR$|spm$|from$|ref$|ref_src$|share_token$)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return value.trim();
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function fingerprint(prefix: string, value: string): string {
  return `${prefix}:${value || 'unknown'}:${hash(value).slice(0, 16)}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.floor(limit ?? DEFAULT_LIMIT), 100));
}
