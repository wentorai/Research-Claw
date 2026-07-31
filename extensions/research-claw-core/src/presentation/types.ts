export const PRESENTATION_SCHEMA_VERSION = 1;

export const WORKSPACE_PRESENTATION_TOOLS = [
  'workspace_save',
  'workspace_export',
  'workspace_append',
  'workspace_download',
] as const;

export type WorkspacePresentationTool = typeof WORKSPACE_PRESENTATION_TOOLS[number];
export type PresentationSource = 'full' | 'persisted';
export type PresentationCompleteness = 'partial' | 'complete';

export interface FilePresentation {
  type: 'file';
  operation: WorkspacePresentationTool;
  name: string;
  path: string;
  sizeBytes: number;
  mimeType: string;
  gitStatus: 'new' | 'committed';
}

export interface FilePresentationPayload {
  kind: 'file';
  file: FilePresentation;
}

export interface PaperBatchPresentationPayload {
  kind: 'paper_batch';
  semantic: 'retrieved';
  status: 'available' | 'unavailable';
  captureSource: PresentationSource;
  provider: string;
  query?: string;
  queryUnavailable: boolean;
  matchedTotal?: number;
  returned: number;
  inspected: number;
  eligible: number;
  stored: number;
  inputCapped: boolean;
  runCapped: boolean;
  persistedDetailsTruncated: boolean;
  unavailableReason?: 'tool_error' | 'business_error' | 'adapter_rejected' | 'persisted_truncated_unrecoverable';
  candidates: PaperCandidate[];
}

export interface PaperCandidate {
  candidateId: string;
  provider: string;
  providerId?: string;
  returnIndex: number;
  source: string;
  sourceId?: string;
  strongAliases: string[];
  actionable: boolean;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  doi?: string;
  arxivId?: string;
  url?: string;
  pdfUrl?: string;
  abstractPreview?: string;
  citationCount?: number;
  libraryId?: string;
  sources?: string[];
  sourcePositions?: Array<{ provider: string; returnIndex: number }>;
  conflictingFields?: string[];
}

export interface PaperCandidateGroup {
  semantic: 'retrieved';
  label: '检索结果·尚未筛选';
  queries: string[];
  queryUnavailable: boolean;
  hasAvailableResults: boolean;
  providers: string[];
  partialProviders: string[];
  unavailableProviders: string[];
  matchedTotal?: number;
  returned: number;
  eligible: number;
  stored: number;
  unique: number;
  shown: number;
  candidates: PaperCandidate[];
}

export type PresentationPayload = FilePresentationPayload | PaperBatchPresentationPayload;

export interface PresentationAppendInput {
  sessionKey: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  source: PresentationSource;
  completeness: PresentationCompleteness;
  payload: PresentationPayload;
  observedAt?: number;
}

export interface PresentationAppendResult {
  appended: boolean;
  recordsRevision: number;
}

export interface PresentationRunView {
  runId: string;
  recordsRevision: number;
  files: FilePresentation[];
  paperBatches: PaperBatchPresentationPayload[];
  paperCandidates?: PaperCandidateGroup;
}
