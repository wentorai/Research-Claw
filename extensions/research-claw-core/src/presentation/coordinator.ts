import { adaptWorkspacePresentation } from './adapters.js';
import {
  adaptLiteraturePresentation,
  createUnavailableLiteraturePresentation,
  isSupportedLiteratureTool,
} from './paper-adapters.js';
import type { ExecutionTraceService } from '../execution-trace/service.js';
import type { PresentationService } from './service.js';
import type { PresentationAppendResult } from './types.js';

interface ToolEvent {
  toolName?: string;
  runId?: string;
  toolCallId?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
  isSynthetic?: boolean;
  message?: unknown;
}

interface ToolContext {
  sessionKey?: string;
  runId?: string;
  toolCallId?: string;
}

interface Binding {
  runId: string;
  observedAt: number;
}

export interface PresentationChangedEvent {
  schemaVersion: 1;
  sessionKey: string;
  runId: string;
  recordsRevision: number;
}

export interface PresentationObservationResult extends PresentationAppendResult {
  sessionKey: string;
  runId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class PresentationCoordinator {
  private readonly bindings = new Map<string, Binding[]>();
  private readonly ttlMs: number;
  private readonly onChanged?: (event: PresentationChangedEvent) => void;

  constructor(
    private readonly presentations: PresentationService,
    private readonly executionTrace: ExecutionTraceService,
    options: {
      ttlMs?: number;
      onChanged?: (event: PresentationChangedEvent) => void;
    } = {},
  ) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.onChanged = options.onChanged;
  }

  beforeTool(event: ToolEvent, context: ToolContext): void {
    const sessionKey = context.sessionKey;
    const runId = event.runId ?? context.runId;
    const toolCallId = event.toolCallId ?? context.toolCallId;
    if (!event.toolName || !sessionKey || !runId) return;
    this.executionTrace.recordBefore({ sessionKey, runId, toolCallId, toolName: event.toolName });
    if (!toolCallId) return;
    const now = Date.now();
    const key = this.bindingKey(sessionKey, toolCallId);
    const current = this.liveBindings(key, now);
    if (!current.some((binding) => binding.runId === runId)) {
      current.push({ runId, observedAt: now });
    }
    this.bindings.set(key, current);
  }

  afterTool(event: ToolEvent, context: ToolContext): PresentationObservationResult | null {
    const sessionKey = context.sessionKey;
    const runId = event.runId ?? context.runId;
    const toolCallId = event.toolCallId ?? context.toolCallId;
    if (!event.toolName || !sessionKey || !runId) return null;
    this.executionTrace.recordAfter({
      sessionKey,
      runId,
      toolCallId,
      toolName: event.toolName,
      durationMs: event.durationMs,
      error: event.error,
    });
    if (!toolCallId) return null;
    if (event.error) {
      const unavailable = createUnavailableLiteraturePresentation(event.toolName, {
        source: 'full', params: event.params, reason: 'tool_error',
      });
      return unavailable ? this.appendAndNotify({
        sessionKey, runId, toolCallId, toolName: event.toolName,
        source: 'full', completeness: 'complete', payload: unavailable,
      }) : null;
    }
    const file = adaptWorkspacePresentation(event.toolName, event.result);
    const paperBatch = file ? null : adaptLiteraturePresentation(event.toolName, event.result, {
      source: 'full',
      params: event.params,
    });
    const unavailable = !file && !paperBatch && isSupportedLiteratureTool(event.toolName, 'full')
      ? createUnavailableLiteraturePresentation(event.toolName, {
        source: 'full', params: event.params,
        reason: isRecord(event.result)
          && isRecord(event.result.details)
          && (typeof event.result.details.error === 'string'
            || event.result.details.status === 'error'
            || event.result.details.ok === false)
          ? 'business_error' : 'adapter_rejected',
      })
      : null;
    if (!file && !paperBatch && !unavailable) return null;
    return this.appendAndNotify({
      sessionKey, runId, toolCallId, toolName: event.toolName,
      source: 'full', completeness: 'complete',
      payload: file ? { kind: 'file', file } : (paperBatch ?? unavailable)!,
    });
  }

  persistedToolResult(event: ToolEvent, context: ToolContext): PresentationObservationResult | null {
    const sessionKey = context.sessionKey;
    const toolCallId = event.toolCallId ?? context.toolCallId;
    if (!sessionKey || !toolCallId || event.isSynthetic === true || !isRecord(event.message)) return null;
    if (typeof event.message.toolName !== 'string') return null;
    const runId = this.resolvePersistedRun(sessionKey, toolCallId);
    if (!runId) return null;
    if (event.message.isError === true) {
      const unavailable = createUnavailableLiteraturePresentation(event.message.toolName, {
        source: 'persisted', reason: 'tool_error',
      });
      return unavailable ? this.appendAndNotify({
        sessionKey, runId, toolCallId, toolName: event.message.toolName,
        source: 'persisted', completeness: 'partial', payload: unavailable,
      }) : null;
    }
    const file = adaptWorkspacePresentation(event.message.toolName, event.message);
    const paperBatch = file
      ? null
      : adaptLiteraturePresentation(event.message.toolName, event.message, { source: 'persisted' });
    const truncated = isRecord(event.message.details)
      && event.message.details.persistedDetailsTruncated === true;
    const unavailable = !file && !paperBatch
      ? createUnavailableLiteraturePresentation(event.message.toolName, {
        source: 'persisted',
        reason: truncated ? 'persisted_truncated_unrecoverable' : 'adapter_rejected',
        persistedDetailsTruncated: truncated,
      })
      : null;
    if (!file && !paperBatch && !unavailable) return null;
    return this.appendAndNotify({
      sessionKey, runId, toolCallId, toolName: event.message.toolName,
      source: 'persisted', completeness: 'partial',
      payload: file ? { kind: 'file', file } : (paperBatch ?? unavailable)!,
    });
  }

  private appendAndNotify(input: Parameters<PresentationService['append']>[0]): PresentationObservationResult {
    const result = this.presentations.append(input);
    if (result.appended) {
      this.onChanged?.({
        schemaVersion: 1,
        sessionKey: input.sessionKey,
        runId: input.runId,
        recordsRevision: result.recordsRevision,
      });
    }
    return { ...result, sessionKey: input.sessionKey, runId: input.runId };
  }

  private resolvePersistedRun(sessionKey: string, toolCallId: string): string | null {
    const now = Date.now();
    const key = this.bindingKey(sessionKey, toolCallId);
    const current = this.liveBindings(key, now);
    if (current.length === 1) return current[0].runId;
    if (current.length > 1) return null;
    return this.executionTrace.findUniqueRunForTool(sessionKey, toolCallId, now - this.ttlMs);
  }

  private liveBindings(key: string, now: number): Binding[] {
    const current = (this.bindings.get(key) ?? []).filter(
      (binding) => now - binding.observedAt <= this.ttlMs,
    );
    if (current.length === 0) this.bindings.delete(key);
    return current;
  }

  private bindingKey(sessionKey: string, toolCallId: string): string {
    return `${sessionKey}\0${toolCallId}`;
  }
}
