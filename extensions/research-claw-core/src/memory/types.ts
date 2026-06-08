/**
 * Memory Management Types
 *
 * Type definitions for the memory management system.
 */

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'agent';

export interface Memory {
  id: string;
  type: MemoryType;
  name: string;
  description: string | null;
  content: string;
  metadata: string; // JSON string
  related_paper_id: string | null;
  related_task_id: string | null;
  created_at: string;
  updated_at: string;
  accessed_at: string | null;
  access_count: number;
  is_active: number;
  is_private: number;
}

export interface MemoryTag {
  id: string;
  name: string;
  color: string | null;
  created_at: string;
}

export interface MemoryWithTags extends Memory {
  tags: MemoryTag[];
}

export interface MemoryLink {
  id: string;
  from_memory_id: string;
  to_memory_id: string;
  context: string | null;
  created_at: string;
}

export interface CreateMemoryParams {
  type: MemoryType;
  name: string;
  content: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
  related_paper_id?: string;
  related_task_id?: string;
  is_private?: boolean;
}

export interface UpdateMemoryParams {
  name?: string;
  description?: string | null;
  content?: string;
  metadata?: Record<string, unknown>;
  is_active?: boolean;
  is_private?: boolean;
}

export interface MemoryFilters {
  type?: MemoryType;
  is_active?: boolean;
  is_private?: boolean;
  tag_name?: string;
  related_paper_id?: string;
  related_task_id?: string;
  search_query?: string;
}

export interface MemorySearchResult {
  id: string;
  type: MemoryType;
  name: string;
  description: string | null;
  rank: number;
  snippet?: string;
  memory?: MemoryWithTags; // Full memory data including tags
}

export interface MemoryStats {
  total: number;
  by_type: Record<MemoryType, number>;
  active: number;
  private: number;
  most_accessed: Memory[];
  recently_accessed: Memory[];
  unused: Memory[];
}

// ── Session Monitoring Types (claude-mem style) ─────────────────────────────

export type SessionEventType = 'session_start' | 'user_prompt' | 'tool_use' | 'assistant_response' | 'session_end';

export interface SessionEvent {
  id: string;
  session_id: string;
  event_type: SessionEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface Session {
  id: string;
  started_at: string;
  ended_at: string | null;
  events_count: number;
  memories_extracted: number;
}

export interface ToolUseEvent {
  tool_name: string;
  parameters: Record<string, unknown>;
  result: unknown;
  duration_ms?: number;
}

export interface UserPromptEvent {
  content: string;
}

export interface AssistantResponseEvent {
  content: string;
  tool_calls?: Array<{ name: string; input: Record<string, unknown> }>;
}

export interface MemoryExtractionConfig {
  extract_after_turns?: number; // Number of turns after which to extract memories
  min_confidence?: number; // Minimum confidence score for memory extraction
  max_memories_per_session?: number; // Maximum memories to extract per session
  auto_extract_enabled?: boolean; // Whether automatic extraction is enabled
}

export interface ExtractedMemory {
  type: MemoryType;
  name: string;
  description: string | null;
  content: string;
  confidence: number; // 0-1 score
  source_event_id: string;
  tags?: string[];
}

// ── Claude-mem Observation Sync Types ───────────────────────────────────────

export interface ClaudeMemObservation {
  id: number;
  memory_session_id: string;
  project: string;
  merged_into_project: string | null;
  platform_source: string;
  type: 'discovery' | 'change' | 'approach' | 'reference' | 'feedback';
  title: string;
  subtitle: string | null;
  narrative: string | null;
  text: string | null;
  facts: string; // JSON array string
  concepts: string; // JSON array string
  files_read: string; // JSON array string
  files_modified: string; // JSON array string
  prompt_number: number;
  created_at: string;
  created_at_epoch: number;
}

export interface ClaudeMemSession {
  id: string;
  content_session_id: string;
  project: string;
  created_at: string;
  ended_at: string | null;
}

export interface SyncResult {
  synced: number;
  updated: number;
  skipped: number;
  errors: string[];
}
