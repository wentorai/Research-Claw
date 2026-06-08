/**
 * Paper Review RPC — rc.review.*
 */

import type { RegisterMethod } from '../types.js';
import {
  PaperReviewService,
  type PaperReviewPatch,
  type PaperReviewStatus,
} from './service.js';

class RpcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcValidationError';
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RpcValidationError(`${field} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new RpcValidationError('Expected string');
  return value;
}

function optionalNumber(value: unknown, field: string, min?: number, max?: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') throw new RpcValidationError(`${field} must be a number`);
  if (min !== undefined && value < min) throw new RpcValidationError(`${field} must be >= ${min}`);
  if (max !== undefined && value > max) throw new RpcValidationError(`${field} must be <= ${max}`);
  return value;
}

function optionalStatus(value: unknown): PaperReviewStatus | undefined {
  if (value === undefined || value === null) return undefined;
  if (value !== 'draft' && value !== 'in_progress' && value !== 'completed' && value !== 'failed') {
    throw new RpcValidationError('status must be draft, in_progress, completed, or failed');
  }
  return value;
}

export function registerPaperReviewRpc(registerMethod: RegisterMethod, service: PaperReviewService): void {
  registerMethod('rc.review.candidates', async (params) => {
    const root = optionalString(params.root) ?? 'sources';
    return { candidates: await service.listCandidates(root) };
  });

  registerMethod('rc.review.list', async (params) => {
    const file_path = optionalString(params.file_path);
    const status = optionalStatus(params.status);
    const limit = optionalNumber(params.limit, 'limit', 1, 200);
    const offset = optionalNumber(params.offset, 'offset', 0);
    return service.list({ file_path, status, limit, offset });
  });

  registerMethod('rc.review.get', async (params) => {
    const id = requireString(params.id, 'id');
    const review = service.get(id);
    if (!review) throw new Error('Review not found');
    return { review };
  });

  registerMethod('rc.review.create', async (params) => {
    const file_path = requireString(params.file_path, 'file_path');
    const review = service.create({
      file_path,
      title: optionalString(params.title),
      paper_id: optionalString(params.paper_id) ?? null,
      rubric: optionalString(params.rubric) ?? null,
      status: optionalStatus(params.status),
      overall_score: optionalNumber(params.overall_score, 'overall_score', 1, 10) ?? null,
      summary: optionalString(params.summary) ?? null,
      strengths: optionalString(params.strengths) ?? null,
      weaknesses: optionalString(params.weaknesses) ?? null,
      suggestions: optionalString(params.suggestions) ?? null,
      report_markdown: optionalString(params.report_markdown) ?? null,
    });
    return { review };
  });

  registerMethod('rc.review.update', async (params) => {
    const id = requireString(params.id, 'id');
    const patch: PaperReviewPatch = {};
    if (params.title !== undefined) {
      patch.title = optionalString(params.title);
    }
    if (params.paper_id !== undefined) {
      patch.paper_id = params.paper_id === null ? null : optionalString(params.paper_id) ?? null;
    }
    if (params.status !== undefined) {
      patch.status = optionalStatus(params.status);
    }
    if (params.overall_score !== undefined) {
      patch.overall_score = params.overall_score === null
        ? null
        : optionalNumber(params.overall_score, 'overall_score', 1, 10) ?? null;
    }
    if (params.summary !== undefined) {
      patch.summary = params.summary === null ? null : optionalString(params.summary) ?? null;
    }
    if (params.strengths !== undefined) {
      patch.strengths = params.strengths === null ? null : optionalString(params.strengths) ?? null;
    }
    if (params.weaknesses !== undefined) {
      patch.weaknesses = params.weaknesses === null ? null : optionalString(params.weaknesses) ?? null;
    }
    if (params.suggestions !== undefined) {
      patch.suggestions = params.suggestions === null ? null : optionalString(params.suggestions) ?? null;
    }
    if (params.report_markdown !== undefined) {
      patch.report_markdown = params.report_markdown === null ? null : optionalString(params.report_markdown) ?? null;
    }
    if (params.rubric !== undefined) {
      patch.rubric = params.rubric === null ? null : optionalString(params.rubric) ?? null;
    }
    if (params.failure_reason !== undefined) {
      patch.failure_reason = params.failure_reason === null ? null : optionalString(params.failure_reason) ?? null;
    }
    const review = service.update(id, patch);
    return { review };
  });

  registerMethod('rc.review.delete', async (params) => {
    const id = requireString(params.id, 'id');
    const deleted = service.delete(id);
    if (!deleted) throw new Error('Review not found');
    return { ok: true };
  });
}
