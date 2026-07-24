/**
 * PlaudManager — minimal stdio MCP client for the @plaud-ai/mcp server.
 *
 * @plaud-ai/mcp is an official stdio MCP server (run via `npx`, OAuth browser
 * login, tokens persisted at ~/.plaud/tokens-mcp.json). We do NOT keep a
 * long-lived connection: each `callTool` spawns a short-lived child, runs one
 * request, and kills it. This keeps the gateway free of a background process
 * and matches the low call frequency (status/login are user-triggered).
 *
 * ─── stdio MCP wire protocol ──────────────────────────────────────────────
 * Transport = newline-delimited JSON-RPC 2.0 (one message per line, NOT the
 * LSP Content-Length framing). A single tool call is a 4-step handshake:
 *
 *   1. → `initialize` request
 *        params: { protocolVersion:'2025-06-18', capabilities:{},
 *                  clientInfo:{ name:'research-claw-periph', version:'1.0.0' } }
 *   2. ← initialize result
 *   3. → `notifications/initialized` notification (no id, no reply expected)
 *   4. → `tools/call` request { name, arguments }
 *   5. ← tools/call result — result.content is an array; we concatenate the
 *        `text` of every `{ type:'text' }` entry.
 *   6. kill the child.
 *
 * The server may print plain-text logs to stdout, so non-JSON lines are
 * ignored. Every exit path (success / timeout / spawn error) kills the child
 * and detaches listeners so no zombie or leaked handler survives the call.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Pinned upstream package (npx target). */
export const PLAUD_PKG = '@plaud-ai/mcp@0.3.5';

/** OAuth token file written by the Plaud MCP server after a browser login. */
export const PLAUD_TOKEN_PATH = join(homedir(), '.plaud', 'tokens-mcp.json');

/**
 * Status reported to the dashboard via rc.periph.plaud.status.
 *
 * NOTE: this is a superset of the minimal {tokenPresent, account?, lastError?}
 * shape — `configured` and `toolsReady` are retained so the manager stays
 * assignable to the T5 `PlaudManager`/`PlaudStatus` contract in periph/rpc.ts.
 */
export interface PlaudStatus {
  /** Whether a spawn command is configured (always true for the npx default). */
  configured?: boolean;
  /** Whether ~/.plaud/tokens-mcp.json exists (proxy for "logged in"). */
  tokenPresent: boolean;
  /** Account identifier returned by get_current_user, when reachable. */
  account?: string;
  /** True once a tool call succeeded (the MCP server answered). */
  toolsReady?: boolean;
  /** Last non-fatal error string (status never throws; it records here). */
  lastError?: string;
}

export interface PlaudManagerOpts {
  /** Spawn command. Default: 'npx'. Tests inject 'node' to run the fake server. */
  spawnCmd?: string;
  /** Spawn args. Default: ['-y', PLAUD_PKG]. */
  spawnArgs?: string[];
  /**
   * Extra env merged over process.env for the child. Test back-door: lets the
   * fake MCP server receive per-call FAKE_MCP_* knobs. Not used in production.
   */
  spawnEnv?: Record<string, string>;
  /**
   * Override for PLAUD_TOKEN_PATH. Test back-door: homedir() does not reliably
   * follow $HOME, so tests point this at an mkdtemp path to exercise both
   * tokenPresent states. Defaults to PLAUD_TOKEN_PATH.
   */
  tokenPath?: string;
}

// ── JSON-RPC message shapes (minimal) ──────────────────────────────────────

interface JsonRpcResult {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolContentItem {
  type: string;
  text?: string;
}

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'research-claw-periph', version: '1.0.0' } as const;

/** Detects error-signalling text returned by the login tool. */
function looksLikeError(text: string): boolean {
  return /\b(error|failed|failure|unauthorized|denied|invalid|not\s+logged\s+in)\b/i.test(text);
}

export class PlaudManager {
  private readonly spawnCmd: string;
  private readonly spawnArgs: string[];
  private readonly spawnEnv?: Record<string, string>;
  private readonly tokenPath: string;

  constructor(opts?: PlaudManagerOpts) {
    this.spawnCmd = opts?.spawnCmd ?? 'npx';
    this.spawnArgs = opts?.spawnArgs ?? ['-y', PLAUD_PKG];
    this.spawnEnv = opts?.spawnEnv;
    this.tokenPath = opts?.tokenPath ?? PLAUD_TOKEN_PATH;
  }

  /**
   * Report connection status. Never throws: tool errors are folded into
   * lastError so the dashboard can render a degraded state.
   */
  async status(): Promise<PlaudStatus> {
    const tokenPresent = existsSync(this.tokenPath);
    // configured(mcp.servers.plaud 是否在 openclaw.json)由 dashboard 侧从 config.get 快照判定(T15),插件进程不可知,不得伪造。
    const st: PlaudStatus = { tokenPresent };
    if (!tokenPresent) return st; // No token → do not spawn.

    try {
      const text = await this.callTool('get_current_user', {}, 15_000);
      st.account = text;
      st.toolsReady = true;
    } catch (err) {
      st.lastError = String(err);
    }
    return st;
  }

  /** Trigger an interactive OAuth login via the MCP server's `login` tool. */
  async login(): Promise<{ ok: boolean; error?: string }> {
    try {
      const text = await this.callTool('login', {}, 180_000);
      if (looksLikeError(text)) return { ok: false, error: text };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /**
   * Spawn a short-lived MCP server, run one tool call, and return the joined
   * text content. Rejects on timeout, spawn error, or premature exit. Kills
   * the child and detaches all listeners on every exit path.
   */
  callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.spawnCmd, this.spawnArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: this.spawnEnv ? { ...process.env, ...this.spawnEnv } : process.env,
        });
      } catch (err) {
        reject(new Error(`plaud-mcp spawn failed: ${String(err)}`));
        return;
      }

      let nextId = 1;
      const initId = nextId++;
      const callId = nextId++;
      let stderr = '';
      let settled = false;

      const rl: ReadlineInterface = createInterface({ input: child.stdout });

      // Single teardown for every exit path: stop the timer, kill the child,
      // and drop all listeners so nothing fires after we settle.
      const cleanup = (): void => {
        clearTimeout(timer);
        rl.removeAllListeners();
        rl.close();
        child.stdout.removeAllListeners();
        child.stderr.removeAllListeners();
        child.removeAllListeners();
        // Guard: only kill a live child. Ignore ESRCH etc.
        try {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        } catch {
          /* already gone */
        }
      };

      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const timer = setTimeout(() => {
        done(() => reject(new Error(`plaud-mcp timeout after ${timeoutMs}ms (tool=${name})`)));
      }, timeoutMs);
      // Do not let the timer keep the event loop alive on its own.
      if (typeof timer.unref === 'function') timer.unref();

      const send = (msg: Record<string, unknown>): void => {
        try {
          child.stdin.write(JSON.stringify(msg) + '\n');
        } catch (err) {
          done(() => reject(new Error(`plaud-mcp write failed: ${String(err)}`)));
        }
      };

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        done(() => reject(new Error(`plaud-mcp process error: ${String(err)}`)));
      });

      child.on('exit', (code, signal) => {
        // A clean success settles before this fires. If we are still pending,
        // the server died early — surface stderr for diagnosis.
        done(() =>
          reject(
            new Error(
              `plaud-mcp exited early (code=${code}, signal=${signal})` +
                (stderr.trim() ? `: ${stderr.trim()}` : ''),
            ),
          ),
        );
      });

      rl.on('line', (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        let msg: JsonRpcResult;
        try {
          msg = JSON.parse(trimmed) as JsonRpcResult;
        } catch {
          return; // Non-JSON log line — ignore.
        }
        if (typeof msg.id !== 'number') return; // Notifications / unexpected.

        if (msg.id === initId) {
          // initialize acknowledged → send the initialized notification, then
          // the actual tool call.
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({
            jsonrpc: '2.0',
            id: callId,
            method: 'tools/call',
            params: { name, arguments: args },
          });
          return;
        }

        if (msg.id === callId) {
          if (msg.error) {
            done(() =>
              reject(new Error(`plaud-mcp tool error (${msg.error!.code}): ${msg.error!.message}`)),
            );
            return;
          }
          const text = extractText(msg.result);
          done(() => resolve(text));
        }
      });

      // Kick off the handshake.
      send({
        jsonrpc: '2.0',
        id: initId,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        },
      });
    });
  }
}

/** Concatenate the `text` of every {type:'text'} entry in a tools/call result. */
function extractText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (item): item is ToolContentItem =>
        !!item && typeof item === 'object' && (item as ToolContentItem).type === 'text',
    )
    .map((item) => item.text ?? '')
    .join('');
}
