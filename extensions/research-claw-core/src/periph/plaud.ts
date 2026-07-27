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
 *
 * ─── Process-group kill (T19 P-1 root cause) ──────────────────────────────
 * `npx` is a wrapper: it spawns @plaud-ai/mcp as a *grandchild*, and that
 * grandchild opens the 8199 OAuth callback server. `child.kill()` reaches only
 * the npx wrapper, so on timeout the grandchild is orphaned and keeps port 8199
 * bound → the next login fails with "port 8199 is in use". We spawn with
 * `detached: true` (new process group) and kill the whole group via the negative
 * pid (`process.kill(-pid, ...)`), falling back to `child.kill()` if the group
 * kill throws (e.g. the group is already gone).
 *
 * ─── login = terminal MCP result, not "token file exists" (Phase2 audit#3) ──
 * Upstream `login` (@plaud-ai/mcp@0.3.5, package/dist/index.js:38-121) BLOCKS
 * until the OAuth callback resolves (LOGIN_TIMEOUT_MS = 120_000 at index.js:37),
 * then returns a *terminal* result:
 *   - success       → {content:[{text:"Successfully authenticated with Plaud!"}]}  (index.js:93, no isError)
 *   - already valid → {content:[{text:"Already logged in."}]}                        (index.js:46)
 *   - timeout       → {isError:true, text:"Authentication timed out after 2 minutes…"} (index.js:94-104)
 *   - denied/exchange-failed/listen-failed → {isError:true, …}                       (index.js:105-119)
 * So login does NOT return early — the previous "return early, then poll the
 * token file for ~150s" assumption was wrong and caused a worst-case ~270s stall
 * (120s login block + 150s poll). It also let a *stale* token report success:
 * upstream `get_current_user` returns {isError:true} on an invalid token
 * (chunk-YI4KJEAG.js:249), but callTool used to drop `isError` and hand back the
 * "Failed to get user info: …" text as if it were the account.
 *
 * Fix: callTool now returns {text, isError}. login() resolves ok ONLY when the
 * terminal result has isError=false AND a positive success signal (or the token
 * lands) — never on "file exists" alone. login() has one hard overall deadline
 * (LOGIN_OVERALL_TIMEOUT_MS) and stays cancellable. status() treats an isError
 * get_current_user as an explicit failure so the UI can force a fresh login.
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
  /**
   * True once get_current_user succeeded (isError=false). A stale/invalid token
   * makes upstream return isError=true (chunk-YI4KJEAG.js:249), so this stays
   * false — the dashboard uses it to decide the token is dead and offer re-login,
   * instead of the old behaviour where any tool answer counted as "ready".
   */
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
  /**
   * Override for the login overall timeout (ms). Test back-door: keeps the
   * cancel/timeout paths fast instead of waiting the 130s production ceiling.
   * Defaults to LOGIN_OVERALL_TIMEOUT_MS.
   */
  loginTimeoutMs?: number;
  /**
   * Override for the post-success token-settle window (ms). Test back-door:
   * lets a test prove login succeeds on the MCP result even when the token file
   * is slow, without waiting the 8s production settle. Defaults to
   * TOKEN_SETTLE_TIMEOUT_MS.
   */
  tokenSettleTimeoutMs?: number;
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

/**
 * Result of one MCP tools/call. `isError` mirrors the upstream tool-level error
 * flag (a sibling of `content` in the tools/call result — NOT a JSON-RPC error).
 * @plaud-ai/mcp sets it to true on auth-timeout / denied / stale-token / list
 * failures (index.js:94-119, chunk-YI4KJEAG.js:138/166/194/222/249). Treating
 * it as success was the "status reports error but re-login succeeds instantly"
 * root cause.
 */
export interface McpToolResult {
  text: string;
  isError: boolean;
}

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'research-claw-periph', version: '1.0.0' } as const;

/**
 * Positive success signals emitted by upstream `login` (index.js:46,93). We
 * require one of these (with isError=false) rather than "no error keyword",
 * because the timeout text "Authentication timed out after 2 minutes" contains
 * no word the old looksLikeError() regex matched, so it slipped through as ok.
 */
function loginSucceeded(result: McpToolResult): boolean {
  if (result.isError) return false;
  return /successfully authenticated|already logged in/i.test(result.text);
}

/**
 * Kill a spawned child AND its whole process group.
 *
 * `npx` runs the real MCP server as a grandchild; a plain child.kill() leaks it
 * (and the 8199 callback server). We spawn detached so the child leads its own
 * group, then kill the group via the negative pid. Falls back to child.kill()
 * if the group kill throws (group already reaped, or pid missing).
 */
function killGroup(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return; // already gone
  const pid = child.pid;
  try {
    if (typeof pid === 'number') {
      process.kill(-pid, 'SIGKILL');
      return;
    }
  } catch {
    /* group gone / not a group leader → fall through to direct kill */
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

/**
 * Hard overall ceiling (ms) for one login() call. Upstream `login` blocks up to
 * LOGIN_TIMEOUT_MS = 120_000 (index.js:37) waiting on the OAuth callback; we add
 * a small margin for spawn + JSON-RPC handshake and cap the whole thing here so
 * login can never串联 into the old ~270s stall. Passed to callTool as its timeout
 * so a hung child is SIGKILL'd at this bound too.
 */
const LOGIN_OVERALL_TIMEOUT_MS = 130_000;

/**
 * Grace window (ms) after a *successful* login terminal result to let the token
 * file finish landing on disk. Upstream writes tokens-mcp.json inside the login
 * handler before returning, so this is a tiny settle margin, not the old 150s
 * poll. Kept short and cancellable.
 */
const TOKEN_SETTLE_TIMEOUT_MS = 8_000;
/** Poll interval (ms) for the post-success token-settle watcher. */
const TOKEN_SETTLE_INTERVAL_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class PlaudManager {
  private readonly spawnCmd: string;
  private readonly spawnArgs: string[];
  private readonly spawnEnv?: Record<string, string>;
  private readonly tokenPath: string;
  private readonly loginTimeoutMs: number;
  private readonly tokenSettleTimeoutMs: number;

  /**
   * The in-flight login session, if any. Holds a handle to the login child so
   * cancelLogin() can kill its process group, plus a `cancelled` flag the poll
   * loop checks so it stops waiting the moment the user cancels. Null when no
   * login is running.
   */
  private _activeLogin: { child: ChildProcessWithoutNullStreams | null; cancelled: boolean } | null =
    null;

  constructor(opts?: PlaudManagerOpts) {
    this.spawnCmd = opts?.spawnCmd ?? 'npx';
    this.spawnArgs = opts?.spawnArgs ?? ['-y', PLAUD_PKG];
    this.spawnEnv = opts?.spawnEnv;
    this.tokenPath = opts?.tokenPath ?? PLAUD_TOKEN_PATH;
    this.loginTimeoutMs = opts?.loginTimeoutMs ?? LOGIN_OVERALL_TIMEOUT_MS;
    this.tokenSettleTimeoutMs = opts?.tokenSettleTimeoutMs ?? TOKEN_SETTLE_TIMEOUT_MS;
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
      const result = await this.callTool('get_current_user', {}, 15_000);
      if (result.isError) {
        // Token file exists but the server rejected it (stale/invalid/revoked).
        // Report an explicit failure so the UI forces a real re-login instead of
        // the old status→error→re-login-succeeds-instantly loop. tokenPresent is
        // left true (the file IS there) but toolsReady stays falsy.
        st.lastError = result.text || 'plaud token invalid';
      } else {
        st.account = result.text;
        st.toolsReady = true;
      }
    } catch (err) {
      st.lastError = String(err);
    }
    return st;
  }

  /**
   * Trigger an interactive OAuth login and wait for its *terminal* result.
   *
   * Semantics (Phase2 audit#3): upstream `login` blocks until the OAuth callback
   * resolves and returns a terminal result — success / already-logged-in /
   * timeout / denied / … (index.js:38-121). It does NOT return early. So we:
   *   1. run the `login` tool (opens the browser), tracking its child so
   *      cancelLogin() can kill the process group, with one hard ceiling of
   *      LOGIN_OVERALL_TIMEOUT_MS (never the old 120s+150s串联);
   *   2. resolve {ok:true} ONLY when the terminal result is a positive success
   *      signal with isError=false (loginSucceeded). A settle-wait then confirms
   *      the token landed (upstream writes it before returning, so this is fast);
   *   3. resolve {ok:false, error:<mcp text>} for any error/timeout/denied
   *      terminal result — the text is the upstream message, which never carries
   *      a secret;
   *   4. resolve {ok:false, error:'login-cancelled'} if cancelLogin() interrupted
   *      the in-flight child.
   *
   * We do NOT short-circuit on "token file exists": a stale token there would be
   * a false success. Upstream `login` itself re-validates and clears an invalid
   * token before re-running OAuth (index.js:43-58), and returns "Already logged
   * in." for a valid one — so delegating is both correct and cheap.
   *
   * A second login() while one is in flight is refused with 'login-in-progress'.
   */
  async login(): Promise<{ ok: boolean; error?: string }> {
    if (this._activeLogin) return { ok: false, error: 'login-in-progress' };

    const session: { child: ChildProcessWithoutNullStreams | null; cancelled: boolean } = {
      child: null,
      cancelled: false,
    };
    this._activeLogin = session;

    try {
      let result: McpToolResult;
      try {
        result = await this.callTool('login', {}, this.loginTimeoutMs, (child) => {
          session.child = child;
        });
      } catch (err) {
        // callTool rejected (spawn failure, early exit, or the overall-timeout
        // SIGKILL). A cancel is reported distinctly so the UI can re-arm login.
        if (session.cancelled) return { ok: false, error: 'login-cancelled' };
        return { ok: false, error: String(err) };
      }

      if (session.cancelled) return { ok: false, error: 'login-cancelled' };

      if (!loginSucceeded(result)) {
        // isError terminal result (timeout/denied/exchange-failed/…) or any
        // non-success text — surface the upstream message verbatim.
        return { ok: false, error: result.text || 'login-failed' };
      }

      // A positive MCP result is necessary but not sufficient. The dashboard
      // persists mcp.servers.plaud only after ok=true, so success without the
      // token file would leave a permanently half-configured card.
      const deadline = Date.now() + this.tokenSettleTimeoutMs;
      while (!existsSync(this.tokenPath) && Date.now() < deadline) {
        if (session.cancelled) return { ok: false, error: 'login-cancelled' };
        await sleep(TOKEN_SETTLE_INTERVAL_MS);
      }
      if (!existsSync(this.tokenPath)) {
        return { ok: false, error: 'token-not-persisted' };
      }
      return { ok: true };
    } finally {
      // Only clear if this session is still the active one (cancelLogin may have
      // already swapped it out).
      if (this._activeLogin === session) this._activeLogin = null;
    }
  }

  /**
   * Cancel an in-flight login: kill the login child's process group (frees the
   * 8199 callback port) and clear the active-login state so the poll loop stops.
   * Safe to call when no login is running (returns {ok:true} either way).
   */
  async cancelLogin(): Promise<{ ok: boolean }> {
    const session = this._activeLogin;
    if (!session) return { ok: true };
    session.cancelled = true;
    if (session.child) killGroup(session.child);
    this._activeLogin = null;
    return { ok: true };
  }

  /**
   * Spawn a short-lived MCP server, run one tool call, and return the joined
   * text content. Rejects on timeout, spawn error, or premature exit. Kills
   * the child (and its process group) and detaches all listeners on every exit
   * path. `onSpawn`, when provided, receives the child immediately after spawn
   * so callers (login) can track it for cancellation.
   */
  callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    onSpawn?: (child: ChildProcessWithoutNullStreams) => void,
  ): Promise<McpToolResult> {
    return new Promise<McpToolResult>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.spawnCmd, this.spawnArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
          // detached → the child leads its own process group so killGroup() can
          // reap npx's grandchildren (the 8199 callback server). See file header.
          detached: true,
          env: this.spawnEnv ? { ...process.env, ...this.spawnEnv } : process.env,
        });
      } catch (err) {
        reject(new Error(`plaud-mcp spawn failed: ${String(err)}`));
        return;
      }
      onSpawn?.(child);

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
        // Kill the whole process group so npx's grandchild (and the 8199
        // callback server) cannot outlive the call. Guarded/no-op if gone.
        killGroup(child);
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
          done(() => resolve(extractResult(msg.result)));
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

/**
 * Extract {text, isError} from a tools/call result. `isError` is the sibling
 * boolean the MCP spec places next to `content` (a tool-level error flag, not a
 * JSON-RPC error). Text is the concatenation of every {type:'text'} entry.
 */
function extractResult(result: unknown): McpToolResult {
  if (!result || typeof result !== 'object') return { text: '', isError: false };
  const obj = result as { content?: unknown; isError?: unknown };
  const isError = obj.isError === true;
  const content = obj.content;
  if (!Array.isArray(content)) return { text: '', isError };
  const text = content
    .filter(
      (item): item is ToolContentItem =>
        !!item && typeof item === 'object' && (item as ToolContentItem).type === 'text',
    )
    .map((item) => item.text ?? '')
    .join('');
  return { text, isError };
}
