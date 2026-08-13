import { create } from 'zustand';
import { GatewayClient, type CloseInfo, type GapInfo } from '../gateway/client';
import { RC_VERSION } from '../version';
import type { ConnectionState, HelloOk, EventFrame, SessionDefaults } from '../gateway/types';
import { classifyChatTerminalLifecycle } from '../utils/session-run-state';
import { recordRunTrace } from '../utils/run-trace';
import {
  classifyCoreMethodFailure,
  isCoreRecoveryProbe,
  type CoreRuntimeFailure,
} from '../utils/core-capability';
import { currentProductPolicy, useProductPolicyStore } from './product-policy';
import { invalidateConfigRequests } from './config-request-authority';

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
  coreFailure: CoreRuntimeFailure | null;
  /**
   * Monotonic count of event-stream discontinuities: a detected sequence gap,
   * a (re)connection, or any departure from 'connected'.
   *
   * Consumers that infer "nothing else happened" from an uninterrupted run of
   * events must compare this against the epoch they last observed. A change
   * means frames may have been lost, so any such inference is void. It only
   * ever increases — resetting it would let a stale inference look current
   * again.
   */
  eventEpoch: number;

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
  coreFailure: null,
  eventEpoch: 0,

  connect: (url: string, token?: string) => {
    const existing = get().client;
    if (existing) {
      existing.disconnect();
    }

    /**
     * Must stay synchronous. GatewayClient.handleEvent reports a sequence gap
     * and then fans the very same frame out to subscribers within one turn, so
     * the bump has to land before that frame is handled. Deferring it behind a
     * dynamic import — the idiom used elsewhere in this file to break store
     * cycles — resolves a microtask too late, and the frame that revealed the
     * gap is exactly the one most likely to need the new epoch.
     */
    const bumpEventEpoch = () => set((s) => ({ eventEpoch: s.eventEpoch + 1 }));

    const client = new GatewayClient({
      url,
      token,
      clientName: 'research-claw-dashboard',
      clientVersion: RC_VERSION,
      platform: 'browser',
      instanceId: _instanceId,
      onStateChange: (state: ConnectionState) => {
        // Deliberately earlier than onHello. handleEvent has no connection-state
        // gate and the subscriber set is never cleared on close, so a frame that
        // arrives on the new socket before hello-ok resolves is still delivered
        // to handlers registered on the previous connection. Leaving 'connected'
        // is the last moment guaranteed to precede every frame of the next one.
        if (state !== 'connected') {
          bumpEventEpoch();
          // The policy belongs to this transport's config.get snapshot. Close
          // the shell synchronously at the connection-epoch boundary, before a
          // new socket can expose the previous profile or an old request can
          // resolve out of order.
          useProductPolicyStore.getState().resetPending();
          invalidateConfigRequests();
        }
        recordRunTrace({
          source: 'gateway',
          action: 'transport-state',
          eventEpoch: get().eventEpoch,
          decision: state,
        });
        set({ state, ...(state === 'connected' ? { connectError: null } : {}) });
      },
      onRequestResult: (method, error) => {
        if (error) {
          const policy = currentProductPolicy();
          const failure = classifyCoreMethodFailure(method, error, Date.now(), (candidate) => (
            candidate.startsWith('rc.periph.')
            && policy?.capabilities.peripherals === 'disabled'
          ));
          if (failure) set({ coreFailure: failure });
        } else if (isCoreRecoveryProbe(method)) {
          set({ coreFailure: null });
        }
      },
      onHello: (hello: HelloOk) => {
        // Belt and braces over the departure bump above: the server restarts its
        // per-connection sequence numbering and the client zeroes lastSeq, so no
        // event on this connection can be sequenced against the previous one.
        bumpEventEpoch();
        recordRunTrace({
          source: 'gateway',
          action: 'hello',
          eventEpoch: get().eventEpoch + 1,
          decision: hello.server?.connId ? 'runtime-identified' : 'runtime-id-missing',
        });
        get().setServerInfo(hello);
        // Capability sentinel: transport success alone does not prove that the
        // Research-Claw Core plugin registered its RPC surface.
        void client.request('rc.onboarding.status', {}).catch(() => {});
        // Transport recovery is not a run terminal. Keep any local projection
        // intact until sessions.list/chat.history supplies authoritative state.
        // Dynamic import intentionally keeps gateway.ts out of a gateway ↔ config
        // module cycle; policy/request invalidation above remains synchronous.
        void import('./config').then(({ useConfigStore }) => {
          useConfigStore.setState({ _configRetryCount: 0 });
          void useConfigStore.getState().loadGatewayConfig();
          void import('../utils/sync-system-prompt-append').then(({ syncSystemPromptAppendToGateway }) => {
            void syncSystemPromptAppendToGateway(useConfigStore.getState().systemPromptAppend);
          });
        });
        // GitHub version check -> notification bell when a newer release exists
        // + sync server-side update-in-progress state (survives page refresh)
        void import('./ui').then(({ useUiStore }) => {
          void useUiStore.getState().maybeNotifyAppUpdate();
          void client.request<{ running: boolean }>('rc.app.update_status', {})
            .then((s) => {
              useUiStore.getState().setAppUpdateRunning(s.running);
              // Poll until update finishes — otherwise button stays locked after refresh
              if (s.running) {
                const poll = setInterval(() => {
                  client.request<{ running: boolean }>('rc.app.update_status', {})
                    .then((ps) => {
                      if (!ps.running) {
                        clearInterval(poll);
                        useUiStore.getState().setAppUpdateRunning(false);
                      }
                    })
                    .catch(() => clearInterval(poll));
                }, 5000);
              }
            })
            .catch(() => { /* non-fatal */ });
        });
        // OC 2026.6.1+: live session list updates via sessions.subscribe
        client.request('sessions.subscribe', {}).catch(() => {});
        // Reset cron reconciliation flag so enabled presets re-register
        // with the gateway after a restart. Uses dynamic import to avoid
        // circular dependency (same pattern as chat store above).
        void import('./cron').then(({ resetCronReconciled, useCronStore }) => {
          resetCronReconciled();
          useCronStore.getState().loadPresets();
        });
        void import('./monitor').then(({ resetMonitorReconciled, useMonitorStore }) => {
          resetMonitorReconciled();
          useMonitorStore.getState().loadMonitors();
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
        void import('./session-runs').then(({ useSessionRunsStore }) => {
          void useSessionRunsStore.getState().flushPendingAborts();
        });
      },
      onEvent: (event: EventFrame) => {
        if (event.event === 'chat') {
          const payload = event.payload as {
            state?: string;
            sessionKey?: string;
            runId?: string;
            errorKind?: string;
            stopReason?: string;
            message?: { isError?: boolean };
          } | undefined;
          if (
            payload?.sessionKey
            && (payload.state === 'final' || payload.state === 'aborted' || payload.state === 'error')
          ) {
            const eventEpoch = get().eventEpoch;
            recordRunTrace({
              source: 'gateway',
              action: 'chat-terminal',
              sessionKey: payload.sessionKey,
              runId: payload.runId,
              eventEpoch,
              seq: event.seq,
              status: payload.state,
              reason: payload.stopReason ?? payload.errorKind,
              fieldsPresent: Object.keys(payload),
            });
            void import('./session-runs').then(({ selectSessionRunView, useSessionRunsStore }) => {
              const store = useSessionRunsStore.getState();
              const command = selectSessionRunView(store, payload.sessionKey!).command;
              const status = classifyChatTerminalLifecycle(payload, command);
              if (!status) return;
              store.applyChatTerminal({
                sessionKey: payload.sessionKey!,
                runId: payload.runId,
                status,
                eventEpoch,
                seq: event.seq,
                observedAt: Date.now(),
              });
            });
          }
        }
        // Handle session change events (aligned with OC UI sessions.subscribe)
        if (event.event === 'sessions.changed') {
          const eventEpoch = get().eventEpoch;
          const payload = event.payload && typeof event.payload === 'object'
            ? event.payload as Record<string, unknown>
            : {};
          const nested = payload.session && typeof payload.session === 'object'
            ? payload.session as Record<string, unknown>
            : {};
          const source = Object.keys(nested).length > 0 ? nested : payload;
          recordRunTrace({
            source: 'gateway',
            action: 'sessions.changed',
            sessionKey: typeof source.sessionKey === 'string'
              ? source.sessionKey
              : typeof source.key === 'string'
                ? source.key
                : undefined,
            sessionId: typeof source.sessionId === 'string' ? source.sessionId : undefined,
            runId: typeof payload.runId === 'string' ? payload.runId : undefined,
            eventEpoch,
            seq: event.seq,
            status: typeof source.status === 'string' ? source.status : undefined,
            hasActiveRun: typeof source.hasActiveRun === 'boolean' ? source.hasActiveRun : undefined,
            startedAt: typeof source.startedAt === 'number' ? source.startedAt : undefined,
            endedAt: typeof source.endedAt === 'number' ? source.endedAt : undefined,
            fieldsPresent: Object.keys(source),
          });
          void import('./session-runs').then(({ useSessionRunsStore }) => {
            useSessionRunsStore.getState().ingestSessionEvent(event.payload, {
              eventEpoch,
              seq: event.seq,
            });
          });
          void import('./sessions').then(({ useSessionsStore }) => {
            void useSessionsStore.getState().loadSessions();
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
        recordRunTrace({
          source: 'gateway',
          action: 'seq-gap',
          eventEpoch: get().eventEpoch,
          reason: `expected:${expected};received:${received}`,
        });
        // First, and synchronously: the frame that revealed this gap has not
        // reached the event subscribers yet, and it may itself be the cron
        // completion whose place in a failure episode we can no longer establish.
        bumpEventEpoch();
        // Dynamic import breaks gateway ↔ chat circular dependency.
        // Safe: onGap fires only after connect, when both stores are initialized.
        void import('./chat').then(({ useChatStore }) => {
          useChatStore.getState().onGapDetected();
        });
        void Promise.all([import('./session-runs'), import('./sessions')]).then(([
          { useSessionRunsStore },
          { useSessionsStore },
        ]) => {
          void useSessionRunsStore.getState().requestReconcile(
            useSessionsStore.getState().activeSessionKey,
            'seq-gap',
          );
        });
      },
      onConnectError: (code: string, message: string) => {
        set({ connectError: { code, message } });
        // OC gateway connect handshake only returns INVALID_REQUEST and NOT_PAIRED
        // as top-level error codes for auth failures. All INVALID_REQUEST errors
        // during connect are auth/config problems — show needs_token which has
        // guided recovery (try default, Docker restart, etc.), not gateway_unreachable
        // which only offers a blind retry button.
        if (code === 'NOT_PAIRED' || code === 'UNAUTHORIZED' || code === 'INVALID_REQUEST') {
          void import('./config').then(({ useConfigStore }) => {
            useConfigStore.getState().setBootState('needs_token');
          });
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
