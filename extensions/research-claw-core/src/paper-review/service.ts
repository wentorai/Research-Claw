/**
 * Paper Review Service — workspace paper peer-review records.
 */

import type BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { TreeNode, WorkspaceService } from '../workspace/service.js';

export type PaperReviewStatus = 'draft' | 'in_progress' | 'completed' | 'failed';

export interface PaperReview {
  id: string;
  file_path: string;
  paper_id: string | null;
  title: string;
  status: PaperReviewStatus;
  overall_score: number | null;
  summary: string | null;
  strengths: string | null;
  weaknesses: string | null;
  suggestions: string | null;
  report_markdown: string | null;
  rubric: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaperReviewInput {
  file_path: string;
  title?: string;
  paper_id?: string | null;
  rubric?: string | null;
  status?: PaperReviewStatus;
  overall_score?: number | null;
  summary?: string | null;
  strengths?: string | null;
  weaknesses?: string | null;
  suggestions?: string | null;
  report_markdown?: string | null;
  failure_reason?: string | null;
}

export interface PaperReviewPatch {
  title?: string;
  paper_id?: string | null;
  status?: PaperReviewStatus;
  overall_score?: number | null;
  summary?: string | null;
  strengths?: string | null;
  weaknesses?: string | null;
  suggestions?: string | null;
  report_markdown?: string | null;
  rubric?: string | null;
  failure_reason?: string | null;
}

export interface WorkspacePaperCandidate {
  path: string;
  name: string;
  mime_type?: string;
  modified_at?: string;
  size?: number;
  review_count: number;
  latest_review_at: string | null;
  latest_review_id: string | null;
}

const REVIEWABLE_EXT = new Set(['.pdf', '.md', '.markdown', '.tex', '.txt', '.docx']);

function nowIso(): string {
  return new Date().toISOString();
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

function isReviewableFile(filePath: string): boolean {
  const ext = path.posix.extname(filePath).toLowerCase();
  return REVIEWABLE_EXT.has(ext);
}

function flattenFiles(node: TreeNode, out: TreeNode[] = []): TreeNode[] {
  if (node.type === 'file') {
    out.push(node);
    return out;
  }
  for (const child of node.children ?? []) {
    flattenFiles(child, out);
  }
  return out;
}

function rowToReview(row: Record<string, unknown>): PaperReview {
  return {
    id: String(row.id),
    file_path: String(row.file_path),
    paper_id: row.paper_id == null ? null : String(row.paper_id),
    title: String(row.title),
    status: row.status as PaperReviewStatus,
    overall_score: row.overall_score == null ? null : Number(row.overall_score),
    summary: row.summary == null ? null : String(row.summary),
    strengths: row.strengths == null ? null : String(row.strengths),
    weaknesses: row.weaknesses == null ? null : String(row.weaknesses),
    suggestions: row.suggestions == null ? null : String(row.suggestions),
    report_markdown: row.report_markdown == null ? null : String(row.report_markdown),
    rubric: row.rubric == null ? null : String(row.rubric),
    failure_reason: row.failure_reason == null ? null : String(row.failure_reason),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function resolveReviewTitle(existing: PaperReview, patchTitle?: string | null): string {
  if (patchTitle !== undefined) {
    const trimmed = (patchTitle ?? '').trim();
    if (trimmed) return trimmed.slice(0, 500);
  }
  const existingTitle = existing.title?.trim();
  if (existingTitle) return existingTitle.slice(0, 500);
  const baseName = path.posix.basename(existing.file_path, path.posix.extname(existing.file_path));
  return (baseName || 'Untitled review').slice(0, 500);
}

export class PaperReviewService {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly workspace: WorkspaceService,
  ) {}

  async listCandidates(root = 'sources'): Promise<WorkspacePaperCandidate[]> {
    let roots: TreeNode[];
    try {
      const result = await this.workspace.tree(root, 12, false);
      roots = result.tree;
    } catch {
      return [];
    }

    const files: TreeNode[] = [];
    for (const node of roots) {
      flattenFiles(node, files);
    }
    const reviewable = files.filter((f) => isReviewableFile(f.path));
    const statsRows = this.db.prepare(`
      SELECT file_path,
             COUNT(*) AS review_count,
             MAX(updated_at) AS latest_review_at
      FROM rc_paper_reviews
      GROUP BY file_path
    `).all() as Array<Record<string, unknown>>;

    const latestRows = this.db.prepare(`
      SELECT r.file_path, r.id AS latest_review_id
      FROM rc_paper_reviews r
      INNER JOIN (
        SELECT file_path, MAX(updated_at) AS max_updated
        FROM rc_paper_reviews
        GROUP BY file_path
      ) x ON r.file_path = x.file_path AND r.updated_at = x.max_updated
    `).all() as Array<Record<string, unknown>>;

    const statsMap = new Map<string, { review_count: number; latest_review_at: string | null; latest_review_id: string | null }>();
    for (const row of statsRows) {
      statsMap.set(String(row.file_path), {
        review_count: Number(row.review_count),
        latest_review_at: row.latest_review_at == null ? null : String(row.latest_review_at),
        latest_review_id: null,
      });
    }
    for (const row of latestRows) {
      const key = String(row.file_path);
      const existing = statsMap.get(key);
      if (existing) {
        existing.latest_review_id = String(row.latest_review_id);
      }
    }

    return reviewable
      .map((f) => {
        const stats = statsMap.get(normalizePath(f.path));
        return {
          path: normalizePath(f.path),
          name: f.name,
          mime_type: f.mime_type,
          modified_at: f.modified_at,
          size: f.size,
          review_count: stats?.review_count ?? 0,
          latest_review_at: stats?.latest_review_at ?? null,
          latest_review_id: stats?.latest_review_id ?? null,
        };
      })
      .sort((a, b) => {
        const ta = a.latest_review_at ?? a.modified_at ?? '';
        const tb = b.latest_review_at ?? b.modified_at ?? '';
        return tb.localeCompare(ta);
      });
  }

  list(params?: { file_path?: string; status?: PaperReviewStatus; limit?: number; offset?: number }): {
    reviews: PaperReview[];
    total: number;
  } {
    const clauses: string[] = [];
    const args: unknown[] = [];

    if (params?.file_path) {
      clauses.push('file_path = ?');
      args.push(normalizePath(params.file_path));
    }
    if (params?.status) {
      clauses.push('status = ?');
      args.push(params.status);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(params?.limit ?? 50, 1), 200);
    const offset = Math.max(params?.offset ?? 0, 0);

    const totalRow = this.db.prepare(`SELECT COUNT(*) AS cnt FROM rc_paper_reviews ${where}`).get(...args) as { cnt: number };
    const rows = this.db.prepare(`
      SELECT * FROM rc_paper_reviews
      ${where}
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...args, limit, offset) as Array<Record<string, unknown>>;

    return {
      reviews: rows.map(rowToReview),
      total: totalRow.cnt,
    };
  }

  get(id: string): PaperReview | null {
    const row = this.db.prepare('SELECT * FROM rc_paper_reviews WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToReview(row) : null;
  }

  create(input: PaperReviewInput): PaperReview {
    const filePath = normalizePath(input.file_path);
    if (!filePath) throw new Error('file_path is required');
    if (!isReviewableFile(filePath)) throw new Error('Unsupported file type for review');

    const baseName = path.posix.basename(filePath, path.posix.extname(filePath));
    const title = (input.title?.trim() || baseName).slice(0, 500);
    const id = randomUUID();
    const ts = nowIso();

    let paperId = input.paper_id ?? null;
    if (!paperId) {
      const linked = this.db.prepare(
        'SELECT id FROM rc_papers WHERE pdf_path = ? LIMIT 1',
      ).get(filePath) as { id: string } | undefined;
      paperId = linked?.id ?? null;
    }

    this.db.prepare(`
      INSERT INTO rc_paper_reviews (
        id, file_path, paper_id, title, status, overall_score,
        summary, strengths, weaknesses, suggestions, report_markdown, rubric,
        failure_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      filePath,
      paperId,
      title,
      input.status ?? 'draft',
      input.overall_score ?? null,
      input.summary ?? null,
      input.strengths ?? null,
      input.weaknesses ?? null,
      input.suggestions ?? null,
      input.report_markdown ?? null,
      input.rubric ?? null,
      input.failure_reason ?? null,
      ts,
      ts,
    );

    return this.get(id)!;
  }

  update(id: string, patch: PaperReviewPatch): PaperReview {
    const existing = this.get(id);
    if (!existing) throw new Error('Review not found');

    const next: PaperReview = { ...existing, updated_at: nowIso() };
    if (patch.paper_id !== undefined) next.paper_id = patch.paper_id;
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.overall_score !== undefined) next.overall_score = patch.overall_score;
    if (patch.summary !== undefined) next.summary = patch.summary;
    if (patch.strengths !== undefined) next.strengths = patch.strengths;
    if (patch.weaknesses !== undefined) next.weaknesses = patch.weaknesses;
    if (patch.suggestions !== undefined) next.suggestions = patch.suggestions;
    if (patch.report_markdown !== undefined) next.report_markdown = patch.report_markdown;
    if (patch.rubric !== undefined) next.rubric = patch.rubric;
    if (patch.failure_reason !== undefined) next.failure_reason = patch.failure_reason;
    next.title = resolveReviewTitle(existing, patch.title);

    if (next.overall_score != null && (next.overall_score < 1 || next.overall_score > 10)) {
      throw new Error('overall_score must be between 1 and 10');
    }

    this.db.prepare(`
      UPDATE rc_paper_reviews SET
        title = ?, paper_id = ?, status = ?, overall_score = ?,
        summary = ?, strengths = ?, weaknesses = ?, suggestions = ?,
        report_markdown = ?, rubric = ?, failure_reason = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.title,
      next.paper_id,
      next.status,
      next.overall_score,
      next.summary,
      next.strengths,
      next.weaknesses,
      next.suggestions,
      next.report_markdown,
      next.rubric,
      next.failure_reason,
      next.updated_at,
      id,
    );

    return this.get(id)!;
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM rc_paper_reviews WHERE id = ?').run(id);
    return result.changes > 0;
  }
}
