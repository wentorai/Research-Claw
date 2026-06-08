/**
 * Memory Module Entry Point
 *
 * This module provides memory management functionality for Research-Claw.
 * It includes tools, RPC methods, and a service layer.
 */

export { MemoryService } from './service.js';
export { createMemoryTools } from './tools.js';
export { registerMemoryRpcMethods } from './rpc.js';
export { SessionMonitoringService } from './session.js';
export { registerSessionRpcMethods } from './session-rpc.js';
export { ClaudeMemSyncService } from './claude-mem-sync.js';
export type {
  Memory,
  MemoryType,
  MemoryTag,
  MemoryLink,
  CreateMemoryParams,
  UpdateMemoryParams,
  MemoryFilters,
  MemorySearchResult,
  MemoryStats,
  MemoryWithTags,
  Session,
  SessionEvent,
  SessionEventType,
  MemoryExtractionConfig,
  ExtractedMemory,
  ClaudeMemObservation,
  ClaudeMemSession,
  SyncResult,
} from './types.js';
