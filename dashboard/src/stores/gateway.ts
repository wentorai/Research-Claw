import { create } from 'zustand';
import { GatewayClient, type CloseInfo, type GapInfo } from '../gateway/client';
import { useConfigStore } from './config';
import type { ConnectionState, HelloOk, EventFrame, SessionDefaults } from '../gateway/types';

/** Stable per-tab instance ID for gateway deduplication (aligned with OC clientInstanceId). */
const _instanceId = crypto.randomUUID();

interface GatewayState {
  client: GatewayClient | null;
  state: ConnectionState;
  serverVersion: string | null;
  assistantName: string;
  connId: string | null;
  /** Session defaults from hello snapshot (agentId, mainKey, etc.) */
  sessionDefaults: SessionDefaults | null;
  /** Last connection error details for UI display */
  connectError: { code: string; message: string } | null;

  connect: (url: string, token?: string) => void;
  disconnect: () => void;
  setServerInfo: (hello: HelloOk) => void;
}

export const useGatewayStore = create<GatewayState>()((set, get) => ({
  client: null,
  state: 'disconnected',
  serverVersion: null,
  assistantName: 'Research-Claw',
  connId: null,
  sessionDefaults: null,
  connectError: null,

  connect: (url: string, token?: string) => {
    const existing = get().client;
    if (existing) {
      existing.disconnect();
    }

    const client = new GatewayClient({
      url,
      token,
      clientName: 'research-claw-dashboard',
      clientVersion: '0.5.11',
      platform: 'browser',
      instanceId: _instanceId,
      onStateChange: (state: ConnectionState) => {
        set({ state, ...(state === 'connected' ? { connectError: null } : {}) });
      },
      onHello: (hello: HelloOk) => {
        get().setServerInfo(hello);
        // Fix 2 — Reconnection-safe streaming state reset.
        // Old behavior: unconditionally clear streaming/runId on every reconnect.
        // Problem: if the user sent a message that the gateway queued (collect mode),
        // the WS reconnection destroys the pending run state. Combined with
        // loadHistory() not finding the queued message in the transcript, the
        // optimistic user message vanishes.
        //
        // New behavior: if we have a pending runId (user sent a message and is
        // waiting for a response), keep the runId and streaming state alive.
        // The stale-stream timer (60s) will recover if the run is truly dead.
        // Only clear streamText (partial stream data was lost during reconnect).
        void import('./chat').then(({ useChatStore }) => {
          const { runId } = useChatStore.getState();
          if (runId) {
            // Pending user-initiated run — preserve state, clear partial stream.
            // Fix 3: set _reconnectedAt so the stale-stream watchdog uses a shorter
            // timeout (15s vs 60s) for faster recovery if the run completed during
            // the disconnect window and no more deltas will arrive.
            useChatStore.setState({ streamText: null, _reconnectedAt: Date.now() });
          } else {
            // No pending run — reset orphaned state (original behavior)
            useChatStore.setState({ streaming: false, streamText: null, runId: null, _reconnectedAt: null });
          }
        });
        // Reset retry counter for fresh evaluation on (re)connection
        useConfigStore.setState({ _configRetryCount: 0 });
        // Auto-fetch config on every (re)connection
        useConfigStore.getState().loadGatewayConfig();
        // Subscribe to session changes (aligned with OC UI: sessions.subscribe).
        // NOTE: sessions.subscribe is not in OC v2026.3.13 npm dist yet (unreleased).
        // The call will silently fail. When OC publishes a version with this method,
        // session list will auto-sync across clients. Until then, we rely on
        // post-chat-final session reload.
        client.request('sessions.subscribe', {}).catch(() => {
          // Expected: method not yet available in current OC version
        });
        // Reset cron reconciliation flag so enabled presets re-register
        // with the gateway after a restart. Uses dynamic import to avoid
        // circular dependency (same pattern as chat store above).
        void import('./cron').then(({ resetCronReconciled, useCronStore }) => {
          resetCronReconciled();
          useCronStore.getState().loadPresets();
        });
        // Reset tool stream on reconnect (aligned with OC: resetToolStream on hello).
        // Prevents stale tool events from a previous connection lingering in the UI.
        void import('./tool-stream').then(({ useToolStreamStore }) => {
          useToolStreamStore.getState().clearAll();
        });
        // Load sessions immediately on (re)connect so the session list is fresh.
        // OC does this in its post-hello hydration sequence.
        void import('./sessions').then(({ useSessionsStore }) => {
          useSessionsStore.getState().loadSessions();
        });
      },
      onEvent: (event: EventFrame) => {
        // Handle session change events (aligned with OC UI sessions.subscribe)
        if (event.event === 'sessions.changed') {
          void import('./sessions').then(({ useSessionsStore }) => {
            useSessionsStore.getState().loadSessions();
          });
        }
        // Handle shutdown event (gateway restart notification)
        if (event.event === 'shutdown') {
          const payload = event.payload as { reason?: string } | undefined;
          console.info(`[Gateway] Shutdown event: ${payload?.reason ?? 'unknown reason'}`);
        }
      },
      onGap: ({ expected, received }: GapInfo) => {
        console.warn(`[Gateway] Event sequence gap: expected ${expected}, got ${received} — scheduling history sync`);
        // Dynamic import breaks gateway ↔ chat circular dependency.
        // Safe: onGap fires only after connect, when both stores are initialized.
        void import('./chat').then(({ useChatStore }) => {
          useChatStore.getState().onGapDetected();
        });
      },
      onConnectError: (code: string, message: string) => {
        set({ connectError: { code, message } });
        if (code === 'NOT_PAIRED' || code === 'UNAUTHORIZED' ||
            (code === 'INVALID_REQUEST' && message.includes('token'))) {
          useConfigStore.getState().setBootState('needs_token');
        }
      },
    });

    set({ client, state: 'connecting' });
    client.connect();
  },

  disconnect: () => {
    const { client } = get();
    if (client) {
      client.disconnect();
    }
    set({ client: null, state: 'disconnected', serverVersion: null, connId: null, sessionDefaults: null, connectError: null });
  },

  setServerInfo: (hello: HelloOk) => {
    set({
      serverVersion: hello.server?.version ?? null,
      connId: hello.server?.connId ?? null,
      sessionDefaults: hello.snapshot?.sessionDefaults ?? null,
    });
  },
}));
