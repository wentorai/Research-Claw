import { describe, expect, it, vi } from 'vitest';

import {
  isUnknownGatewayMethodError,
  isWorkspaceFileNotFoundError,
  readWorkspaceFileIfReady,
} from './workspace-file-poll';

describe('workspace-file-poll', () => {
  it('detects file-not-found errors', () => {
    expect(isWorkspaceFileNotFoundError(new Error('File not found: outputs/x.md'))).toBe(true);
  });

  it('detects unknown method errors', () => {
    expect(isUnknownGatewayMethodError(new Error('unknown method: rc.ws.exists'), 'rc.ws.exists')).toBe(true);
  });

  it('falls back to read when rc.ws.exists is unavailable', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'rc.ws.exists') throw new Error('unknown method: rc.ws.exists');
      if (method === 'rc.ws.read') return { content: 'hello world' };
      throw new Error(`unexpected ${method}`);
    });

    await expect(readWorkspaceFileIfReady(request, 'outputs/a.md', 5)).resolves.toBe('hello world');
  });

  it('returns null when read reports missing file', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'rc.ws.exists') return { exists: false };
      throw new Error('should not read');
    });

    await expect(readWorkspaceFileIfReady(request, 'outputs/missing.md', 1)).resolves.toBeNull();
  });
});
