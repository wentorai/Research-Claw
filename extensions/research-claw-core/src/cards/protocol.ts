/**
 * Message Card Protocol
 *
 * Defines 7 structured card types embedded in agent messages as fenced code
 * blocks with special language tags. Cards carry rich, typed payloads that
 * the dashboard UI can render interactively.
 *
 * Note: code_block is NOT a custom card type. Standard fenced code blocks with
 * recognized programming language identifiers are rendered with syntax highlighting
 * by the default Markdown renderer.
 */

// ---------------------------------------------------------------------------
// Card type discriminator
// ---------------------------------------------------------------------------

export type CardType =
  | 'paper_card'
  | 'task_card'
  | 'progress_card'
  | 'approval_card'
  | 'radar_digest'
  | 'file_card'
  | 'monitor_digest';

/** Canonical set for runtime membership checks. */
export const CARD_TYPES: ReadonlySet<string> = new Set<CardType>([
  'paper_card',
  'task_card',
  'progress_card',
  'approval_card',
  'radar_digest',
  'file_card',
  'monitor_digest',
]);

// ---------------------------------------------------------------------------
// Paper Card
// ---------------------------------------------------------------------------

export interface PaperCard {
  type: 'paper_card';
  title: string;
  authors: string[];
  venue?: string;
  year?: number;
  doi?: string;
  url?: string;
  arxiv_id?: string;
  /** First ~200 characters of the abstract. Truncated with "..." if needed. */
  abstract_preview?: string;
  read_status?: 'unread' | 'reading' | 'read' | 'reviewed';
  /** Internal library ID if the paper is already in the user's library. */
  library_id?: string;
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Task Card
// ---------------------------------------------------------------------------

export interface TaskCard {
  type: 'task_card';
  /** Internal task ID. Omitted when the agent is proposing a new task. */
  id?: string;
  title: string;
  description?: string;
  task_type: 'human' | 'agent' | 'mixed';
  status: 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
  priority: 'urgent' | 'high' | 'medium' | 'low';
  deadline?: string; // ISO 8601
  /** Title of a related paper, for cross-referencing. */
  related_paper_title?: string;
  /** Workspace-relative path of a linked output file. */
  related_file_path?: string;
}

// ---------------------------------------------------------------------------
// Progress Card
// ---------------------------------------------------------------------------

export interface ProgressCard {
  type: 'progress_card';
  period: string; // "today" | "this_week" | "this_month" | "session" | custom label
  papers_read: number;
  papers_added: number;
  tasks_completed: number;
  tasks_created: number;
  /** Word count written in drafts/notes during the period. */
  writing_words?: number;
  /** Estimated reading time in minutes. */
  reading_minutes?: number;
  /** Key points: deadlines, alerts, findings, or milestones. Max 5 items. */
  highlights?: string[];
}

// ---------------------------------------------------------------------------
// Approval Card
// ---------------------------------------------------------------------------

export interface ApprovalCard {
  type: 'approval_card';
  /** Human-readable description of the proposed action. */
  action: string;
  /** Why the agent wants to perform this action. */
  context: string;
  risk_level: 'low' | 'medium' | 'high';
  /** Structured details about the action (command args, file paths, etc.). */
  details?: Record<string, unknown>;
  /** Maps to the exec.approval.requested event ID. */
  approval_id?: string;
}

// ---------------------------------------------------------------------------
// Radar Digest
// ---------------------------------------------------------------------------

export interface NotablePaper {
  title: string;
  authors: string[];
  /** Why the agent considers this paper notable for the user. */
  relevance_note: string;
}

export interface RadarDigest {
  type: 'radar_digest';
  source: string; // "arxiv" | "semantic_scholar" | "pubmed" | "custom"
  /** The search query or topic that was tracked. */
  query: string;
  /** Time window the scan covered. */
  period: string;
  total_found: number;
  notable_papers: NotablePaper[];
}

// ---------------------------------------------------------------------------
// File Card
// ---------------------------------------------------------------------------

export interface FileCard {
  type: 'file_card';
  name: string;
  path: string;
  size_bytes?: number;
  mime_type?: string;
  created_at?: string; // ISO 8601
  modified_at?: string; // ISO 8601
  git_status?: 'new' | 'modified' | 'committed';
}

// ---------------------------------------------------------------------------
// Monitor Digest
// ---------------------------------------------------------------------------

export interface MonitorFinding {
  title: string;
  url?: string;
  /** Why the agent considers this finding relevant for the user. */
  summary?: string;
}

export interface MonitorDigest {
  type: 'monitor_digest';
  /** Human-readable monitor name. */
  monitor_name: string;
  source_type: string; // "arxiv" | "semantic_scholar" | "github" | "rss" | "webpage" | "openalex" | "twitter" | "custom"
  /** The search query, URL, or repo target. */
  target: string;
  /** Cron schedule expression. */
  schedule?: string;
  total_found: number;
  /** Up to 10 notable findings. */
  findings: MonitorFinding[];
}

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------

export type MessageCard =
  | PaperCard
  | TaskCard
  | ProgressCard
  | ApprovalCard
  | RadarDigest
  | FileCard
  | MonitorDigest;
