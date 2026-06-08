/**
 * Session Monitoring RPC Methods
 *
 * RPC methods for session monitoring functionality.
 */

import type { RegisterMethod } from '../types.js';
import { SessionMonitoringService } from './session.js';
import type { MemoryExtractionConfig } from './types.js';

export function registerSessionRpcMethods(
  registerMethod: RegisterMethod,
  sessionService: SessionMonitoringService,
): void {
  // Start a new session
  registerMethod('rc.session.start', async (params) => {
    const metadata = params.metadata && typeof params.metadata === 'object' && !Array.isArray(params.metadata)
      ? params.metadata as Record<string, unknown>
      : {};
    const session = sessionService.startSession(metadata);
    return session;
  });

  // End the current session
  registerMethod('rc.session.end', async () => {
    const session = sessionService.endSession();
    return session;
  });

  // Get current session
  registerMethod('rc.session.getCurrent', async () => {
    const session = sessionService.getCurrentSession();
    return session;
  });

  // Get session by ID
  registerMethod('rc.session.get', async (params) => {
    const id = typeof params.id === 'string' ? params.id : '';
    const session = sessionService.getSession(id);
    return session;
  });

  // List sessions
  registerMethod('rc.session.list', async (params) => {
    const limit = typeof params.limit === 'number' ? params.limit : 50;
    const offset = typeof params.offset === 'number' ? params.offset : 0;
    const sessions = sessionService.listSessions(limit, offset);
    return { items: sessions, total: sessions.length };
  });

  // Get session events
  registerMethod('rc.session.getEvents', async (params) => {
    const id = typeof params.id === 'string' ? params.id : '';
    const eventType = typeof params.event_type === 'string' ? params.event_type : undefined;
    const events = sessionService.getSessionEvents(id, eventType as any);
    return events;
  });

  // Record user prompt (for testing/manual recording)
  registerMethod('rc.session.recordUserPrompt', async (params) => {
    const content = typeof params.content === 'string' ? params.content : '';
    const event = sessionService.recordUserPrompt(content);
    return event;
  });

  // Record tool use (for testing/manual recording)
  registerMethod('rc.session.recordToolUse', async (params) => {
    const toolName = typeof params.tool_name === 'string' ? params.tool_name : '';
    const parameters = params.parameters && typeof params.parameters === 'object' && !Array.isArray(params.parameters)
      ? params.parameters as Record<string, unknown>
      : {};
    const durationMs = typeof params.duration_ms === 'number' ? params.duration_ms : undefined;
    const event = sessionService.recordToolUse(
      toolName,
      parameters,
      params.result,
      durationMs,
    );
    return event;
  });

  // Record assistant response (for testing/manual recording)
  registerMethod('rc.session.recordAssistantResponse', async (params) => {
    const content = typeof params.content === 'string' ? params.content : '';
    const toolCalls = Array.isArray(params.tool_calls)
      ? params.tool_calls as Array<{ name: string; input: Record<string, unknown> }>
      : undefined;
    const event = sessionService.recordAssistantResponse(content, toolCalls);
    return event;
  });

  // Get extraction config
  registerMethod('rc.session.getConfig', async () => {
    const config = sessionService.getConfig();
    return config;
  });

  // Update extraction config
  registerMethod('rc.session.updateConfig', async (params) => {
    sessionService.updateConfig(params as Partial<MemoryExtractionConfig>);
    return { ok: true };
  });
}
