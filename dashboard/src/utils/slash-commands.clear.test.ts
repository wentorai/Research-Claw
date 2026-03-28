import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GatewayClient } from '../gateway/client';
import { executeSlashCommand } from './slash-commands';

describe('executeSlashCommand /clear', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls sessions.reset with key + reason and passes back canonical key', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, key: 'agent:main:proj-abc' });
    const client = { request } as unknown as GatewayClient;

    const r = await executeSlashCommand(client, 'proj-abc', 'clear', '');

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('sessions.reset', { key: 'proj-abc', reason: 'reset' });
    expect(r.action).toBe('clear');
    expect(r.nextSessionKey).toBe('agent:main:proj-abc');
    expect(r.content).toBeTruthy();
  });

  it('returns clear-local-fallback when sessions.reset fails', async () => {
    const request = vi.fn().mockRejectedValue(new Error('unknown method'));
    const client = { request } as unknown as GatewayClient;

    const r = await executeSlashCommand(client, 'main', 'clear', '');

    expect(r.action).toBe('clear-local-fallback');
    expect(r.content).toMatch(/unknown method/);
    expect(r.nextSessionKey).toBeUndefined();
  });
});
