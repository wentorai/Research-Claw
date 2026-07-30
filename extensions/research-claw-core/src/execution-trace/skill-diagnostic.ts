import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
} from 'openclaw/plugin-sdk/diagnostic-runtime';
import { onInternalDiagnosticEvent } from 'openclaw/plugin-sdk/diagnostic-runtime';
import type { ExecutionTraceService } from './service.js';

/**
 * Persist the host-authoritative Skill activation signal.
 *
 * OpenClaw produces this event only after matching a read/command against the
 * current run's resolvedSkills snapshot. That makes it stronger evidence than
 * a filename heuristic or a Research-Plugins-only catalog lookup.
 */
export function recordSkillUsedDiagnostic(
  service: ExecutionTraceService,
  event: DiagnosticEventPayload,
  metadata: DiagnosticEventMetadata,
): boolean {
  if (!metadata.trusted || event.type !== 'skill.used') return false;
  if (!event.runId || !event.sessionKey) return false;
  service.recordSkill({
    sessionKey: event.sessionKey,
    runId: event.runId,
    skillKey: `${event.skillSource}:${event.skillName}`,
    skillName: event.skillName,
    skillSource: event.skillSource,
    activation: event.activation,
    toolCallId: event.toolCallId,
    timestamp: event.ts,
  });
  return true;
}

export function subscribeExecutionSkillDiagnostics(
  service: ExecutionTraceService,
  onError?: (error: unknown) => void,
): () => void {
  return onInternalDiagnosticEvent((event, metadata) => {
    try {
      recordSkillUsedDiagnostic(service, event, metadata);
    } catch (error) {
      onError?.(error);
    }
  });
}
