import { create } from 'zustand';

/**
 * Tracks live tool execution events from the gateway's `agent` event stream.
 *
 * Agent events come in two flavors:
 * 1. Status events: { state: "thinking" | "tool_running" | "streaming" | "idle" | "error" }
 *    — Broadcast to all clients, used by the status dot and background activity bar.
 * 2. Detailed events: { stream: "tool" | "lifecycle", data: { phase, name, toolCallId, ... } }
 *    — Only sent to clients with caps: ["tool-events"] for tool stream,
 *      or broadcast for lifecycle/assistant/error streams.
 */

import { normalizeSessionKey } from '../utils/session-key';

export interface PendingTool {
  toolCallId: string;
  name: string;
  phase: 'start' | 'running' | 'result' | 'end';
  startedAt: number;
  /** Timestamp of the most recent event for this tool. Used by stale-stream
   *  watchdog to distinguish hung tools (no events) from legitimately
   *  long-running ones (still receiving phase/update events). */
  lastEventAt: number;
}

export interface AgentActivity {
  runId: string;
  isBackground: boolean;
  currentTool: string | null;
  status: string;
  startedAt: number;
}

export interface ActivityLogEntry {
  id: string;
  ts: number;
  sessionKey: string;
  runId: string | null;
  toolCallId: string | null;
  scope: 'foreground' | 'background';
  status: string;
  text: string;
  durationMs?: number;
  detail?: unknown;
}

interface ToolStreamState {
  /** Active tools for the current foreground run — displayed inline in ChatView. */
  pendingTools: PendingTool[];
  /** Background activity — displayed in the AgentActivityBar. */
  bgActivity: AgentActivity | null;
  /** Persistent activity log for user-visible process history. */
  activityLog: ActivityLogEntry[];
  /** Remember run -> session mapping for events missing sessionKey. */
  runSessionMap: Record<string, string>;

  handleAgentEvent: (payload: unknown, chatRunId: string | null, activeSessionKey: string) => void;
  clearAll: () => void;
  clearActivityLog: () => void;
}

const ACTIVE_STATES = new Set(['thinking', 'tool_running', 'streaming']);

/**
 * Max age (ms) for a pending tool before it's considered stale and evicted.
 * Guards against memory leaks when phase:"end" events are lost (network jitter).
 */
const STALE_TOOL_MS = 120_000;
const ACTIVITY_LOG_MAX = 200;
/** Max entries in runSessionMap before oldest entries are evicted. */
const RUN_SESSION_MAP_MAX = 100;

function pushActivityLog(
  set: (partial: Partial<ToolStreamState>) => void,
  get: () => ToolStreamState,
  entry: Omit<ActivityLogEntry, 'id' | 'ts'>,
) {
  const e: ActivityLogEntry = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    ...entry,
  };
  set({
    activityLog: [...get().activityLog, e].slice(-ACTIVITY_LOG_MAX),
  });
}

export const useToolStreamStore = create<ToolStreamState>()((set, get) => ({
  pendingTools: [],
  bgActivity: null,
  activityLog: [],
  runSessionMap: {},

  handleAgentEvent: (payload: unknown, chatRunId: string | null, activeSessionKey: string) => {
    const evt = payload as {
      runId?: string;
      sessionKey?: string;
      state?: string;
      stream?: string;
      data?: {
        phase?: string;
        name?: string;
        toolName?: string;
        toolCallId?: string;
      };
    };

    const normalizedActiveSessionKey = normalizeSessionKey(activeSessionKey);

    // Build runId -> sessionKey mapping from authoritative events.
    if (evt.runId && evt.sessionKey) {
      const normalizedEventSession = normalizeSessionKey(evt.sessionKey);
      const prev = get().runSessionMap[evt.runId];
      if (prev !== normalizedEventSession) {
        const nextMap = { ...get().runSessionMap, [evt.runId]: normalizedEventSession };
        // Evict oldest entries when map exceeds cap to prevent unbounded growth.
        const keys = Object.keys(nextMap);
        if (keys.length > RUN_SESSION_MAP_MAX) {
          for (const k of keys.slice(0, keys.length - RUN_SESSION_MAP_MAX)) {
            delete nextMap[k];
          }
        }
        set({ runSessionMap: nextMap });
      }
    }

    // Background = different runId from the user's active chat, or no active chat.
    const isBackground = !!evt.runId && (!chatRunId || evt.runId !== chatRunId);

    // Resolve event session: explicit sessionKey -> remembered run mapping ->
    // current foreground run's active session. For background events, never
    // fall back to active session to avoid cross-session pollution.
    const mappedSessionKey = evt.runId ? get().runSessionMap[evt.runId] : undefined;
    const eventSessionKey = normalizeSessionKey(
      evt.sessionKey
      ?? mappedSessionKey
      ?? (!isBackground && evt.runId && chatRunId && evt.runId === chatRunId ? activeSessionKey : undefined),
    );

    // Session isolation: if we can resolve session and it is not active, drop it.
    if (eventSessionKey && eventSessionKey !== normalizedActiveSessionKey) {
      return;
    }

    // ── Path A: Status-only events (state field, no stream) ──
    // These are broadcast to ALL clients. The status dot uses them.
    // We use them for background activity detection (P1-3).
    if (evt.state && !evt.stream) {
      if (isBackground && ACTIVE_STATES.has(evt.state)) {
        // Only log if the event carries a sessionKey (skip global broadcasts
        // that have no session — they'd pollute every session's log).
        if (eventSessionKey) {
          pushActivityLog(set, get, {
            sessionKey: eventSessionKey,
            runId: evt.runId ?? null,
            toolCallId: null,
            scope: 'background',
            status: evt.state,
            text: evt.state === 'tool_running'
              ? 'Background run is calling tools'
              : evt.state === 'streaming'
                ? 'Background run is streaming response'
                : 'Background run is thinking',
            detail: evt,
          });
        }
        set({
          bgActivity: {
            runId: evt.runId!,
            isBackground: true,
            currentTool: null,
            status: evt.state,
            startedAt: get().bgActivity?.runId === evt.runId
              ? get().bgActivity!.startedAt
              : Date.now(),
          },
        });
      } else if (evt.state === 'idle' || evt.state === 'error') {
        if (eventSessionKey) {
          pushActivityLog(set, get, {
            sessionKey: eventSessionKey,
            runId: evt.runId ?? null,
            toolCallId: null,
            scope: isBackground ? 'background' : 'foreground',
            status: evt.state,
            text: evt.state === 'idle' ? 'Run finished' : 'Run failed',
            detail: evt,
          });
        }
        // Clear bgActivity only when the idle/error is for the tracked run.
        // Skip runId-less broadcasts to avoid clearing activity for a run
        // that is still in-flight but whose status we haven't received yet.
        const bg = get().bgActivity;
        if (bg && evt.runId && bg.runId === evt.runId) {
          set({ bgActivity: null });
        }
      }
      return;
    }

    // ── Path B: Detailed events (stream + data fields) ──
    // Tool events require caps: ["tool-events"] registration.
    if (!evt.stream || !evt.data) return;

    // Handle tool stream events
    if (evt.stream === 'tool' && evt.data.phase && evt.data.toolCallId) {
      const { phase, toolCallId } = evt.data;
      const name = evt.data.name ?? evt.data.toolName;

      if (!isBackground) {
        // Foreground: update pendingTools for inline chat display.
        // On every mutation, also evict stale tools (startedAt > STALE_TOOL_MS ago)
        // to prevent memory leaks when phase:"end" events are lost.
        const now = Date.now();
        const evictStale = (tools: PendingTool[]) =>
          tools.filter((t) => now - t.lastEventAt < STALE_TOOL_MS);

        switch (phase) {
          case 'start':
            if (eventSessionKey) {
              pushActivityLog(set, get, {
                sessionKey: eventSessionKey,
                runId: evt.runId ?? null,
                toolCallId,
                scope: 'foreground',
                status: 'tool_start',
                text: `Tool started: ${name ?? 'unknown'}`,
                detail: evt.data,
              });
            }
            set((s) => ({
              pendingTools: [
                ...evictStale(s.pendingTools),
                { toolCallId, name: name ?? 'unknown', phase: 'start', startedAt: now, lastEventAt: now },
              ],
            }));
            break;
          case 'running':
            set((s) => ({
              pendingTools: evictStale(s.pendingTools).map((t) =>
                t.toolCallId === toolCallId ? { ...t, phase: 'running', lastEventAt: now } : t,
              ),
            }));
            break;
          case 'result': {
              const matched = get().pendingTools.find((x) => x.toolCallId === toolCallId);
              const durationMs = matched ? (now - matched.startedAt) : undefined;
              if (eventSessionKey) {
                pushActivityLog(set, get, {
                  sessionKey: eventSessionKey,
                  runId: evt.runId ?? null,
                  toolCallId,
                  scope: 'foreground',
                  status: 'tool_result',
                  text: `Tool returned: ${name ?? 'unknown'}`,
                  durationMs,
                  detail: evt.data,
                });
              }
            }
            set((s) => ({
              pendingTools: evictStale(s.pendingTools).map((t) =>
                t.toolCallId === toolCallId ? { ...t, phase: 'result', lastEventAt: now } : t,
              ),
            }));
            break;
          case 'end': {
              const matched = get().pendingTools.find((x) => x.toolCallId === toolCallId);
              const durationMs = matched ? (now - matched.startedAt) : undefined;
              if (eventSessionKey) {
                pushActivityLog(set, get, {
                  sessionKey: eventSessionKey,
                  runId: evt.runId ?? null,
                  toolCallId,
                  scope: 'foreground',
                  status: 'tool_end',
                  text: `Tool finished: ${name ?? 'unknown'}`,
                  durationMs,
                  detail: evt.data,
                });
              }
            }
            setTimeout(() => {
              set((s) => ({
                pendingTools: s.pendingTools.filter((t) => t.toolCallId !== toolCallId),
              }));
            }, 800);
            set((s) => ({
              pendingTools: evictStale(s.pendingTools).map((t) =>
                t.toolCallId === toolCallId ? { ...t, phase: 'end', lastEventAt: now } : t,
              ),
            }));
            break;
        }
      } else {
        // Background: update bgActivity with tool name
        if (phase === 'start' || phase === 'running') {
          if (phase === 'start') {
            if (eventSessionKey) {
              pushActivityLog(set, get, {
                sessionKey: eventSessionKey,
                runId: evt.runId ?? null,
                toolCallId,
                scope: 'background',
                status: 'tool_start',
                text: `Background tool started: ${name ?? 'unknown'}`,
                detail: evt.data,
              });
            }
          }
          set({
            bgActivity: {
              runId: evt.runId!,
              isBackground: true,
              currentTool: name ?? null,
              status: 'tool_running',
              startedAt: get().bgActivity?.runId === evt.runId
                ? get().bgActivity!.startedAt
                : Date.now(),
            },
          });
        }
      }
    }

    // Handle lifecycle events for background activity
    if (evt.stream === 'lifecycle' && isBackground) {
      const lifecyclePhase = evt.data.phase;
      if (lifecyclePhase === 'start') {
        if (eventSessionKey) {
          pushActivityLog(set, get, {
            sessionKey: eventSessionKey,
            runId: evt.runId ?? null,
            toolCallId: null,
            scope: 'background',
            status: 'start',
            text: 'Background run started',
            detail: evt.data,
          });
        }
        set({
          bgActivity: {
            runId: evt.runId!,
            isBackground: true,
            currentTool: null,
            status: 'thinking',
            startedAt: Date.now(),
          },
        });
      } else if (lifecyclePhase === 'end' || lifecyclePhase === 'error') {
        const startedAt = get().bgActivity?.runId === evt.runId
          ? get().bgActivity?.startedAt
          : undefined;
        if (eventSessionKey) {
          pushActivityLog(set, get, {
            sessionKey: eventSessionKey,
            runId: evt.runId ?? null,
            toolCallId: null,
            scope: 'background',
            status: lifecyclePhase,
            text: lifecyclePhase === 'error' ? 'Background run failed' : 'Background run finished',
            durationMs: startedAt ? (Date.now() - startedAt) : undefined,
            detail: evt.data,
          });
        }
        if (get().bgActivity?.runId === evt.runId) {
          set({ bgActivity: null });
        }
      }
    }
  },

  clearAll: () => {
    set({ pendingTools: [], bgActivity: null, runSessionMap: {} });
  },

  clearActivityLog: () => {
    set({ activityLog: [] });
  },
}));
