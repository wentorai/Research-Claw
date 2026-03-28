import type { ConnectionState, HelloOk, EventFrame, GatewayErrorInfo } from '../types';
import type { GatewayClientOptions, CloseInfo, GapInfo } from '../client';

export type { CloseInfo, GapInfo };

/**
 * Mock GatewayClient for unit testing without a real WebSocket.
 *
 * Usage in tests:
 *   vi.mock('../gateway/client', () => import('../gateway/__mocks__/client'));
 */

export class GatewayRequestError extends Error {
  code: string;
  details?: unknown;

  constructor(info: GatewayErrorInfo) {
    super(info.message);
    this.name = 'GatewayRequestError';
    this.code = info.code;
    this.details = info.details;
  }
}

export class GatewayClient {
  private state: ConnectionState = 'disconnected';
  private eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  private opts: GatewayClientOptions;
  private requestHandlers = new Map<string, (params?: unknown) => unknown>();

  constructor(opts: GatewayClientOptions) {
    this.opts = opts;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get isConnected(): boolean {
    return this.state === 'connected';
  }

  /**
   * Register a mock response for a given RPC method.
   */
  mockResponse(method: string, handler: (params?: unknown) => unknown): void {
    this.requestHandlers.set(method, handler);
  }

  /**
   * Simulate an event from the server.
   */
  simulateEvent(event: string, payload?: unknown): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const h of handlers) {
        h(payload);
      }
    }
    const frame: EventFrame = { type: 'event', event, payload };
    this.opts.onEvent?.(frame);
  }

  connect(): void {
    this.state = 'connecting';
    this.opts.onStateChange?.('connecting');

    // Simulate async handshake
    queueMicrotask(() => {
      this.state = 'authenticating';
      this.opts.onStateChange?.('authenticating');

      queueMicrotask(() => {
        this.state = 'connected';
        this.opts.onStateChange?.('connected');

        const hello: HelloOk = {
          type: 'hello-ok',
          protocol: 3,
          server: { version: '0.0.0-mock', connId: 'mock-conn-id' },
          features: { methods: ['health', 'chat.send', 'chat.abort', 'chat.history', 'sessions.reset'], events: [] },
        };
        this.opts.onHello?.(hello);
      });
    });
  }

  disconnect(): void {
    this.state = 'disconnected';
    this.opts.onStateChange?.('disconnected');
    this.opts.onClose?.({ code: 1000, reason: 'client disconnect' });
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.state !== 'connected') {
      throw new Error('Not connected to gateway');
    }

    const handler = this.requestHandlers.get(method);
    if (handler) {
      return handler(params) as T;
    }

    // Default mock responses
    if (method === 'health') {
      return { ok: true } as T;
    }
    if (method === 'chat.history') {
      return { messages: [] } as T;
    }
    if (method === 'sessions.reset') {
      const p = (params as { key?: string } | undefined) ?? {};
      return { ok: true, key: p.key ?? 'main' } as T;
    }

    throw new GatewayRequestError({ code: 'METHOD_NOT_FOUND', message: `No mock for ${method}` });
  }

  subscribe(event: string, handler: (payload: unknown) => void): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);

    return () => {
      this.eventHandlers.get(event)?.delete(handler);
    };
  }
}
