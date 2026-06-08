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

export interface PaperReviewListResponse {
  reviews: PaperReview[];
  total: number;
}

export interface PaperReviewCandidatesResponse {
  candidates: WorkspacePaperCandidate[];
}

export interface PaperReviewGetResponse {
  review: PaperReview;
}

export interface PaperReviewWriteResponse {
  review: PaperReview;
}
