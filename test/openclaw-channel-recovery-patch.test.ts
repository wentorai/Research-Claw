import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const PATCH = fs.readFileSync(path.join(ROOT, 'patches', 'openclaw@2026.6.1.patch'), 'utf8');

describe('Research-Claw channel recovery patch', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps bounded exponential channel policies while demoting retry-state logs', () => {
    expect(PATCH).toContain('TELEGRAM_COMMAND_SYNC_MAX_ATTEMPTS = 3');
    expect(PATCH).toContain('initialMs: 2e3, maxMs: 3e4, factor: 2');
    expect(PATCH).toContain('Telegram command sync deferred; retry');
    expect(PATCH).toContain('fallbackLogger.debug(`telegram ${operation} deferred:');
    expect(PATCH).toContain('log.debug?.(`[${id}] auto-restart attempt');
    expect(PATCH).toContain('health-monitor: restarting (reason: ${reason})');
    expect(PATCH).not.toContain('+\t\t\t\tthis.opts.log(`[telegram] deleteWebhook failed with a recoverable');
  });

  it('retries a recoverable command-menu network failure and succeeds without error output', async () => {
    vi.useFakeTimers();
    const { s: syncTelegramMenuCommands } = await import(
      '../node_modules/openclaw/dist/bot-deps-Nw3VjzKb.js'
    ) as unknown as {
      s: (params: Record<string, unknown>) => void;
    };
    const deleteMyCommands = vi.fn().mockResolvedValue(undefined);
    const setMyCommands = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue(undefined);
    const runtimeError = vi.fn();

    syncTelegramMenuCommands({
      bot: { api: { deleteMyCommands, setMyCommands } },
      runtime: { log: vi.fn(), error: runtimeError, exit: vi.fn() },
      commandsToRegister: [{ command: 'status', description: 'Status' }],
      accountId: `recoverable-${Date.now()}`,
      botIdentity: 'fixture-bot',
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(setMyCommands).toHaveBeenCalledTimes(4);
    expect(runtimeError).not.toHaveBeenCalled();
  });

  it('does not retry a permanent command-menu configuration error', async () => {
    vi.useFakeTimers();
    const { s: syncTelegramMenuCommands } = await import(
      '../node_modules/openclaw/dist/bot-deps-Nw3VjzKb.js'
    ) as unknown as {
      s: (params: Record<string, unknown>) => void;
    };
    const setMyCommands = vi.fn().mockRejectedValue(new Error('401 Unauthorized: invalid token'));
    const runtimeError = vi.fn();

    syncTelegramMenuCommands({
      bot: { api: { deleteMyCommands: vi.fn().mockResolvedValue(undefined), setMyCommands } },
      runtime: { log: vi.fn(), error: runtimeError, exit: vi.fn() },
      commandsToRegister: [{ command: 'status', description: 'Status' }],
      accountId: `permanent-${Date.now()}`,
      botIdentity: 'fixture-bot',
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(setMyCommands).toHaveBeenCalledTimes(1);
    expect(runtimeError).toHaveBeenCalledWith(expect.stringContaining('Telegram command sync failed'));
  });
});
