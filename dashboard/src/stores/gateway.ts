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

  connect: (url: string, token?: string) => {
    const existing = get().client;
    if (existing) {
      existing.disconnect();
    }

    const client = new GatewayClient({
      url,
      token,
      clientName: 'research-claw-dashboard',
      clientVersion: '0.3.0',
      platform: 'browser',
      onStateChange: (state: ConnectionState) => {
        set({ state });
      },
      onHello: (hello: HelloOk) => {
        get().setServerInfo(hello);
        // Auto-fetch config on every (re)connection
        useConfigStore.getState().loadGatewayConfig();
      },
      onEvent: (_event: EventFrame) => {
        // Global event handler — individual subscribers handle specifics
      },
      onGap: (expected: number, actual: number) => {
        console.warn(`[Gateway] Event sequence gap: expected ${expected}, got ${actual}`);
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
    set({ client: null, state: 'disconnected', serverVersion: null, connId: null });
  },

  setServerInfo: (hello: HelloOk) => {
    set({
      serverVersion: hello.server?.version ?? null,
      connId: hello.server?.connId ?? null,
    });
  },
}));
