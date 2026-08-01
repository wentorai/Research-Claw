import * as path from 'node:path';

import {
  WORKSPACE_PRESENTATION_TOOLS,
  type FilePresentation,
  type WorkspacePresentationTool,
} from './types.js';

const MIME_BY_EXTENSION: Record<string, string> = {
  md: 'text/markdown', txt: 'text/plain', tex: 'text/x-latex',
  bib: 'application/x-bibtex', ris: 'application/x-research-info-systems',
  csv: 'text/csv', json: 'application/json', yaml: 'text/x-yaml', yml: 'text/x-yaml',
  py: 'text/x-python', r: 'text/x-r', jl: 'text/x-julia', m: 'text/x-matlab',
  js: 'text/javascript', ts: 'text/typescript', html: 'text/html',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  svg: 'image/svg+xml', gif: 'image/gif',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isWorkspaceTool(toolName: string): toolName is WorkspacePresentationTool {
  return (WORKSPACE_PRESENTATION_TOOLS as readonly string[]).includes(toolName);
}

/**
 * Presentation paths are the workspace-relative paths returned by RC tools.
 * Keep this stricter than path.resolve: accepting and normalizing `..` would turn
 * a hostile result into a valid-looking actionable card.
 */
export function validatePresentationPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > 1_024 || candidate.includes('\0')) return null;
  if (candidate.includes('\\') || candidate.startsWith('/') || /^[A-Za-z]:/.test(candidate)) return null;
  const segments = candidate.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return candidate;
}

function validateSize(value: unknown): number | null {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 2_147_483_648
    ? value
    : null;
}

function mimeForPath(filePath: string, claimed: unknown): string {
  const extension = path.posix.extname(filePath).slice(1).toLowerCase();
  const known = MIME_BY_EXTENSION[extension];
  if (known) return known;
  if (typeof claimed === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(claimed) && claimed.length <= 127) {
    return claimed;
  }
  return 'application/octet-stream';
}

/**
 * Strict adapter for the four checked-in real workspace result schemas.
 * `result` is OpenClaw-sanitized (or persistence-capped), never described as raw.
 */
export function adaptWorkspacePresentation(toolName: string, result: unknown): FilePresentation | null {
  if (!isWorkspaceTool(toolName) || !isRecord(result) || !isRecord(result.details)) return null;
  const details = result.details;
  if (typeof details.error === 'string' || details.ok === false || details.status === 'error') return null;

  // New tool results carry an explicit minimal projection. The legacy flat
  // fields remain accepted because Task 0 captured them from production 6.1.
  const explicit = isRecord(details.presentation) ? details.presentation : null;
  if (explicit && (explicit.schemaVersion !== 1 || explicit.kind !== 'file')) return null;
  const source = explicit ?? details;
  const pathValue = toolName === 'workspace_export' && !explicit ? source.output : source.path;
  const filePath = validatePresentationPath(pathValue);
  const sizeBytes = validateSize(source.sizeBytes ?? source.size);
  if (!filePath || sizeBytes === null) return null;

  const committed = source.committed;
  if (typeof committed !== 'boolean') return null;
  return {
    type: 'file',
    operation: toolName,
    name: path.posix.basename(filePath),
    path: filePath,
    sizeBytes,
    mimeType: mimeForPath(filePath, source.mimeType ?? source.mime_type),
    gitStatus: committed ? 'committed' : 'new',
  };
}
