/**
 * Regression coverage for the named session-registry store errors that ride
 * beside `registryErrors=N` in the research-claw-db service's hourly
 * presentation sweep.
 *
 * `retention.ts` records one `{ agent, path, message }` entry per agent whose
 * session store is absent or unreadable, but the sweep used to log only the
 * bare count. The log is an operator's only way to tell a degraded registry
 * from an empty one, so these tests drive the real service `start()` (not a
 * helper in isolation) and pin:
 *
 *  - the grep-able count line still reads `registryErrors=<n>` / `registryFiles=<n>`;
 *  - every error is named with agent, path and message, bounded to the cap;
 *  - the cap is enforced (10 named lines + one "N withheld" line) and applies
 *    only above the boundary;
 *  - the fail-closed branch names the broken store beside the existing
 *    "Session registry unavailable" warn.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import plugin from '../../index.js';

const NAMED_PREFIX = '[Presentation] session registry store error: ';
const SUMMARY_PREFIX = '[Presentation] bounded orphan sweep: ';
const FAIL_CLOSED_LINE =
  '[Presentation] Session registry unavailable; orphan sweep skipped (fail closed)';
const WITHHELD_PATTERN =
  /^\[Presentation\] (\d+) more session registry store error\(s\) withheld \(cap (\d+) per sweep\)$/;

/** Mirrors SESSION_REGISTRY_STORE_ERROR_LOG_CAP in index.ts (not exported). */
const LOGGER_CAP = 10;

interface ServiceHandle {
  id: string;
  start: (ctx: { stateDir: string; logger: unknown }) => void | Promise<void>;
  stop?: (ctx: { stateDir: string; logger: unknown }) => void | Promise<void>;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-session-registry-store-errors-'));
const infoLines: string[] = [];
const warnLines: string[] = [];
const capturedServices: ServiceHandle[] = [];

let dbService: ServiceHandle;
let nowSpy: ReturnType<typeof vi.spyOn> | undefined;
// The service sweeps at most once an hour via module-level `_lastPresentationSweepAt`.
// Start well past any real-time sweep a co-resident module instance may have made,
// and advance past the hour throttle, so every start() here really sweeps.
let clock = Date.UTC(2030, 0, 15, 12, 0, 0);

function createStateDir(name: string): string {
  const stateDir = path.join(root, name);
  fs.mkdirSync(path.join(stateDir, 'agents'), { recursive: true });
  return stateDir;
}

/** A readable legacy `sessions.json` store: one good agent, one registry file. */
function addLegacyAgent(stateDir: string, agentId: string): void {
  const sessionsDir = path.join(stateDir, 'agents', agentId, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, 'sessions.json'),
    JSON.stringify({ [`agent:${agentId}:active`]: { sessionId: 'active-id' } }),
  );
}

/** An agent directory with neither the SQLite store nor the legacy index. */
function addBrokenAgent(stateDir: string, agentId: string): void {
  fs.mkdirSync(path.join(stateDir, 'agents', agentId), { recursive: true });
}

function expectedStorePath(stateDir: string, agentId: string): string {
  return path.join(stateDir, 'agents', agentId, 'agent', 'openclaw-agent.sqlite');
}

function brokenAgentIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    `broken-${String(index + 1).padStart(2, '0')}`);
}

async function startService(stateDir: string): Promise<void> {
  clock += 2 * 60 * 60_000;
  await dbService.start({ stateDir, logger: {} });
}

function namedLines(): string[] {
  return warnLines.filter((line) => line.startsWith(NAMED_PREFIX));
}

function withheldLines(): string[] {
  return warnLines.filter((line) => WITHHELD_PATTERN.test(line));
}

function summaryTokens(): string[] {
  const summary = infoLines.find((line) => line.startsWith(SUMMARY_PREFIX));
  expect(summary, 'the sweep summary line must still be emitted').toBeDefined();
  return summary!.slice(SUMMARY_PREFIX.length).split(' ');
}

beforeAll(async () => {
  await plugin.register?.({
    id: 'research-claw-core',
    name: 'Research-Claw Core',
    pluginConfig: {
      dbPath: path.join(root, 'library.db'),
      workspace: { root: path.join(root, 'workspace') },
    },
    logger: {
      info: (message: string) => {
        infoLines.push(message);
      },
      warn: (message: string) => {
        warnLines.push(message);
      },
      error: () => {},
      debug: () => {},
    },
    runtime: {
      config: {
        current: () => ({}),
        mutateConfigFile: async () => ({ path: '', persistedHash: null }),
      },
    },
    resolvePath: (input: string) => (path.isAbsolute(input) ? input : path.join(root, input)),
    registerTool: () => {},
    registerGatewayMethod: () => {},
    registerHttpRoute: () => {},
    registerService: (service: ServiceHandle) => {
      capturedServices.push(service);
    },
    on: () => {},
    registerHook: () => {},
  } as never);

  dbService = capturedServices.find((service) => service.id === 'research-claw-db')!;
  expect(dbService, 'the research-claw-db service must be registered').toBeDefined();
  nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
});

afterAll(async () => {
  nowSpy?.mockRestore();
  await dbService?.stop?.({ stateDir: root, logger: {} });
  fs.rmSync(root, { recursive: true, force: true });
});

describe('session registry store-error log lines', () => {
  it('keeps the registryErrors count and names each store error, capped at ten', async () => {
    const stateDir = createStateDir('success-branch');
    addLegacyAgent(stateDir, 'main');
    const broken = brokenAgentIds(12);
    for (const agent of broken) addBrokenAgent(stateDir, agent);

    infoLines.length = 0;
    warnLines.length = 0;
    await startService(stateDir);

    // The count line is unchanged: an existing reader may grep these tokens.
    const tokens = summaryTokens();
    expect(tokens).toContain('registryFiles=1');
    expect(tokens).toContain('registryErrors=12');

    // Exactly the cap is named, each with agent, path and the reader's message.
    const named = namedLines();
    expect(named).toHaveLength(LOGGER_CAP);
    for (const agent of broken.slice(0, LOGGER_CAP)) {
      expect(named).toContain(
        `${NAMED_PREFIX}agent=${agent} path=${expectedStorePath(stateDir, agent)} message=session store not found`,
      );
    }

    // The cap is honoured: the two overflow agents are named nowhere, only counted.
    for (const agent of broken.slice(LOGGER_CAP)) {
      expect(warnLines.join('\n')).not.toContain(`agent=${agent}`);
    }
    const withheld = withheldLines();
    expect(withheld).toHaveLength(1);
    const match = WITHHELD_PATTERN.exec(withheld[0]!)!;
    expect(match[1]).toBe('2');
    expect(match[2]).toBe(String(LOGGER_CAP));
  });

  it('names the broken store beside the fail-closed warn', async () => {
    const stateDir = createStateDir('fail-closed');
    addBrokenAgent(stateDir, 'only-broken');

    infoLines.length = 0;
    warnLines.length = 0;
    await startService(stateDir);

    expect(warnLines).toContain(FAIL_CLOSED_LINE);
    expect(namedLines()).toEqual([
      `${NAMED_PREFIX}agent=only-broken path=${expectedStorePath(stateDir, 'only-broken')} message=session store not found`,
    ]);
    expect(withheldLines()).toEqual([]);
    // The fail-closed branch has no sweep summary to carry a count.
    expect([...infoLines, ...warnLines].some((line) => line.includes('registryErrors='))).toBe(false);
  });

  it('does not withhold when the error count is exactly the cap', async () => {
    const stateDir = createStateDir('at-cap');
    addLegacyAgent(stateDir, 'main');
    const broken = brokenAgentIds(LOGGER_CAP);
    for (const agent of broken) addBrokenAgent(stateDir, agent);

    infoLines.length = 0;
    warnLines.length = 0;
    await startService(stateDir);

    const tokens = summaryTokens();
    expect(tokens).toContain('registryFiles=1');
    expect(tokens).toContain(`registryErrors=${LOGGER_CAP}`);
    expect(namedLines()).toHaveLength(LOGGER_CAP);
    expect(withheldLines()).toEqual([]);
  });
});
