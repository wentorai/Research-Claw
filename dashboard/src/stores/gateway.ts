import { create } from 'zustand';
import { GatewayClient } from '../gateway/client';
import { useConfigStore } from './config';
import type { ConnectionState, HelloOk, EventFrame } from '../gateway/types';

interface GatewayState {
  client: GatewayClient | null;
  state: ConnectionState;
  serverVersion: string | null;
  assistantName: string;
  connId: string | null;
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
      clientVersion: '0.5.0',
      platform: 'browser',
      onStateChange: (state: ConnectionState) => {
        set({ state, ...(state === 'connected' ? { connectError: null } : {}) });
      },
      onHello: (hello: HelloOk) => {
        get().setServerInfo(hello);
        // Reset orphaned chat streaming state from before disconnect/refresh.
        // Any in-flight run's final event was lost during the disconnect window.
        // Matches OC: app-gateway.ts:218-221
        void import('./chat').then(({ useChatStore }) => {
          useChatStore.setState({
            streaming: false,
            streamText: null,
            runId: null,
          });
        });
        // Reset retry counter for fresh evaluation on (re)connection
        useConfigStore.setState({ _configRetryCount: 0 });
        // Auto-fetch config on every (re)connection
        useConfigStore.getState().loadGatewayConfig();
      },
      onEvent: (_event: EventFrame) => {
        // Global event handler — individual subscribers handle specifics
      },
      onGap: (expected: number, actual: number) => {
        console.warn(`[Gateway] Event sequence gap: expected ${expected}, got ${actual} — scheduling history sync`);
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
    set({ client: null, state: 'disconnected', serverVersion: null, connId: null, connectError: null });
  },

  setServerInfo: (hello: HelloOk) => {
    set({
      serverVersion: hello.server?.version ?? null,
      connId: hello.server?.connId ?? null,
    });
  },
}));
