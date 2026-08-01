import type { ChatMessage } from '../gateway/types';
import type { FileCard, PaperCard } from '../types/cards';

const CARD_FENCE_RE = /(`{3,})(file_card|paper_card)(?:[^\n]*)\r?\n([\s\S]*?)\1/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text && text.length <= max && !/[\u0000-\u001f]/.test(text) ? text : undefined;
}

function safeWorkspacePath(value: unknown): string | null {
  const text = safeString(value, 1_024);
  if (!text || text.startsWith('/') || text.includes('\\') || /^[A-Za-z]:/.test(text)) return null;
  if (text.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  return text;
}

function inferName(filePath: string): string {
  return filePath.split('/').at(-1) ?? filePath;
}

function parseSize(value: unknown, human = false): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_648 ? value : undefined;
  }
  if (!human || typeof value !== 'string') return undefined;
  const match = value.trim().match(/^([\d.]+)\s*(b|kb|mb|gb)?$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = (match[2]?.toLowerCase() ?? 'b') as 'b' | 'kb' | 'mb' | 'gb';
  const factor = ({ b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 } as const)[unit];
  const bytes = Math.round(amount * factor);
  return Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= 2_147_483_648 ? bytes : undefined;
}

function parseLegacyFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.trim().match(/^([A-Za-z_][\w.-]*)\s*:\s*(.+)$/);
    if (!match) continue;
    fields[match[1].toLowerCase().replace(/-/g, '_')] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return fields;
}

export function parseRuntimeFileCard(text: string): FileCard | null {
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    raw = parsed;
  } catch {
    raw = parseLegacyFields(text);
  }
  if (raw.type !== undefined && raw.type !== 'file_card') return null;
  const filePath = safeWorkspacePath(raw.path ?? raw.file ?? raw.file_path ?? raw.output);
  if (!filePath) return null;
  const size = raw.size_bytes !== undefined ? parseSize(raw.size_bytes) : parseSize(raw.size, true);
  const mime = safeString(raw.mime_type ?? raw.mime, 127);
  const gitStatus = ['new', 'modified', 'committed'].includes(String(raw.git_status))
    ? raw.git_status as FileCard['git_status']
    : undefined;
  return {
    type: 'file_card',
    name: safeString(raw.name ?? raw.filename ?? raw.file_name, 255) ?? inferName(filePath),
    path: filePath,
    ...(size !== undefined ? { size_bytes: size } : {}),
    ...(mime && /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? { mime_type: mime } : {}),
    ...(gitStatus ? { git_status: gitStatus } : {}),
  };
}

export function normalizeRuntimeDoi(value: unknown): string | null {
  let doi = safeString(value, 300);
  if (!doi) return null;
  doi = doi.replace(/^doi:\s*/i, '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase();
  return /^10\.\d{4,9}\/[^\s<>]+$/.test(doi) ? doi : null;
}

export function normalizeRuntimeArxiv(value: unknown): string | null {
  let id = safeString(value, 160);
  if (!id) return null;
  id = id.replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, '')
    .replace(/\.pdf$/i, '').replace(/^arxiv:\s*/i, '').replace(/v\d+$/i, '');
  return /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})$/i.test(id) ? id : null;
}

function safeUrl(value: unknown): string | undefined {
  const text = safeString(value, 2_048);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function parseRuntimePaperCard(text: string): PaperCard | null {
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    raw = parsed;
  } catch {
    return null;
  }
  if (raw.type !== undefined && raw.type !== 'paper_card') return null;
  const title = safeString(raw.title, 500);
  if (!title) return null;
  const authors = Array.isArray(raw.authors)
    ? raw.authors.slice(0, 50).flatMap((author) => safeString(author, 200) ?? [])
    : [];
  const doi = normalizeRuntimeDoi(raw.doi) ?? undefined;
  const arxiv = normalizeRuntimeArxiv(raw.arxiv_id) ?? undefined;
  const url = safeUrl(raw.url);
  const year = typeof raw.year === 'number' && Number.isInteger(raw.year) && raw.year >= 1400 && raw.year <= 2200
    ? raw.year : undefined;
  return {
    type: 'paper_card',
    title,
    authors,
    ...(safeString(raw.venue, 300) ? { venue: safeString(raw.venue, 300) } : {}),
    ...(year ? { year } : {}),
    ...(doi ? { doi } : {}),
    ...(arxiv ? { arxiv_id: arxiv } : {}),
    ...(url ? { url } : {}),
    ...(safeString(raw.abstract_preview, 10_000) ? { abstract_preview: safeString(raw.abstract_preview, 10_000)!.slice(0, 2_000) } : {}),
    ...(safeString(raw.library_id, 255) ? { library_id: safeString(raw.library_id, 255) } : {}),
  };
}

export function collectPaperFenceAliases(message: ChatMessage): Set<string> {
  const aliases = new Set<string>();
  const scan = (text: string) => {
    for (const match of text.matchAll(CARD_FENCE_RE)) {
      if (match[2] !== 'paper_card') continue;
      const card = parseRuntimePaperCard(match[3]);
      if (card?.doi) aliases.add(`doi:${card.doi}`);
      if (card?.arxiv_id) aliases.add(`arxiv:${card.arxiv_id.toLowerCase()}`);
    }
  };
  if (typeof message.text === 'string') scan(message.text);
  if (typeof message.content === 'string') scan(message.content);
  if (Array.isArray(message.content)) {
    for (const block of message.content) if (block.type === 'text' && typeof block.text === 'string') scan(block.text);
  }
  return aliases;
}

export function suppressProjectedFileFences(message: ChatMessage, projectedPaths: Set<string>): ChatMessage {
  if (projectedPaths.size === 0) return message;
  const suppress = (text: string) => text.replace(CARD_FENCE_RE, (
    fence, _ticks: string, kind: string, body: string,
  ) => {
    if (kind !== 'file_card') return fence;
    const card = parseRuntimeFileCard(body);
    return card && projectedPaths.has(card.path) ? '' : fence;
  }).replace(/\n{3,}/g, '\n\n');
  return {
    ...message,
    ...(typeof message.text === 'string' ? { text: suppress(message.text) } : {}),
    ...(typeof message.content === 'string' ? { content: suppress(message.content) } : {}),
    ...(Array.isArray(message.content) ? {
      content: message.content.map((block) => block.type === 'text' && typeof block.text === 'string'
        ? { ...block, text: suppress(block.text) }
        : block),
    } : {}),
  };
}
