import { create } from 'zustand';

/**
 * Tracks live tool execution events from the gateway's `agent` event stream.
 * Consumes events with `stream: "tool"` to provide real-time tool activity
 * in the chat UI (P1-2) and background activity bar (P1-3).
 *
 * Gateway agent event payload for tool stream:
 *   { runId, sessionKey, stream: "tool", ts, data: { phase, name, toolCallId, args?, result?, partialResult? } }
 */

export interface PendingTool {
  toolCallId: string;
  name: string;
  phase: 'start' | 'running' | 'result' | 'end';
  startedAt: number;
}

export interface AgentActivity {
  runId: string;
  isBackground: boolean;
  currentTool: string | null;
  startedAt: number;
}

interface ToolStreamState {
  /** Active tools for the current foreground run — displayed inline in ChatView. */
  pendingTools: PendingTool[];
  /** Background activity — displayed in the AgentActivityBar. */
  bgActivity: AgentActivity | null;

  handleAgentEvent: (payload: unknown, chatRunId: string | null) => void;
  clearAll: () => void;
}

export const useToolStreamStore = create<ToolStreamState>()((set, get) => ({
  pendingTools: [],
  bgActivity: null,

  handleAgentEvent: (payload: unknown, chatRunId: string | null) => {
    const evt = payload as {
      runId?: string;
      stream?: string;
      data?: {
        phase?: string;
        name?: string;
        toolName?: string;
        toolCallId?: string;
      };
    };

    if (!evt.stream || !evt.data) return;

    // Background = different runId from the user's active chat.
    // When chatRunId is null (no active user chat), server-initiated runs are foreground-ish
    // but we still show them as background since the user didn't initiate them.
    const isBackground = !!evt.runId && (!chatRunId || evt.runId !== chatRunId);

    // Handle tool stream events
    // Gateway sends data.name (server-chat.agent-events.test.ts:537), but also
    // accept data.toolName for forward-compat with any gateway variants.
    if (evt.stream === 'tool' && evt.data.phase && evt.data.toolCallId) {
      const { phase, toolCallId } = evt.data;
      const name = evt.data.name ?? evt.data.toolName;

      if (!isBackground) {
        // Foreground: update pendingTools for inline chat display
        switch (phase) {
          case 'start':
            set((s) => ({
              pendingTools: [
                ...s.pendingTools,
                { toolCallId, name: name ?? 'unknown', phase: 'start', startedAt: Date.now() },
              ],
            }));
            break;
          case 'running':
            set((s) => ({
              pendingTools: s.pendingTools.map((t) =>
                t.toolCallId === toolCallId ? { ...t, phase: 'running' } : t,
              ),
            }));
            break;
          case 'result':
            set((s) => ({
              pendingTools: s.pendingTools.map((t) =>
                t.toolCallId === toolCallId ? { ...t, phase: 'result' } : t,
              ),
            }));
            break;
          case 'end':
            // Remove completed tool after brief display
            setTimeout(() => {
              set((s) => ({
                pendingTools: s.pendingTools.filter((t) => t.toolCallId !== toolCallId),
              }));
            }, 800);
            set((s) => ({
              pendingTools: s.pendingTools.map((t) =>
                t.toolCallId === toolCallId ? { ...t, phase: 'end' } : t,
              ),
            }));
            break;
        }
      } else {
        // Background: update bgActivity for activity bar
        if (phase === 'start' || phase === 'running') {
          set({
            bgActivity: {
              runId: evt.runId!,
              isBackground: true,
              currentTool: name ?? null,
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
        set({
          bgActivity: {
            runId: evt.runId!,
            isBackground: true,
            currentTool: null,
            startedAt: Date.now(),
          },
        });
      } else if (lifecyclePhase === 'end' || lifecyclePhase === 'error') {
        if (get().bgActivity?.runId === evt.runId) {
          set({ bgActivity: null });
        }
      }
    }
  },

  clearAll: () => {
    set({ pendingTools: [], bgActivity: null });
  },
}));
