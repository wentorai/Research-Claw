#!/usr/bin/env node
/**
 * Fake stdio MCP server for PlaudManager tests (Task 6).
 *
 * Speaks newline-delimited JSON-RPC 2.0 over stdin/stdout, mirroring the
 * @plaud-ai/mcp stdio transport so PlaudManager can be exercised offline.
 *
 * Result shapes mirror @plaud-ai/mcp@0.3.5 (verified against package/dist):
 *   - login success → {content:[{text:'Successfully authenticated with Plaud!'}]}
 *                      (index.js:93, no isError)
 *   - login timeout → {isError:true, content:[{text:'Authentication timed out…'}]}
 *                      (index.js:94-104)
 *   - get_current_user ok    → {content:[{text:JSON}]}                (chunk-YI4KJEAG.js:245)
 *   - get_current_user stale → {isError:true, content:[{text:'Failed to get user info…'}]}
 *                      (chunk-YI4KJEAG.js:249)
 *
 * Env knobs (for edge-case tests):
 *   FAKE_MCP_HANG=1          → never answer `tools/call` (test timeout + SIGKILL).
 *   FAKE_MCP_STDOUT_NOISE=1  → print a non-JSON log line to stdout before each
 *                              `tools/call` reply (test noise tolerance).
 *   FAKE_MCP_LOGIN_FAIL=1    → `login` returns denied error text + isError:true.
 *   FAKE_MCP_LOGIN_TIMEOUT=1 → `login` returns the upstream auth-timeout text +
 *                              isError:true (no error *keyword*, so it proves the
 *                              client keys on isError, not on text matching).
 *   FAKE_MCP_USER_ERROR=1    → `get_current_user` returns isError:true (stale
 *                              token) so status() reports an explicit failure.
 */

'use strict';

const readline = require('node:readline');

const HANG = process.env.FAKE_MCP_HANG === '1';
const NOISE = process.env.FAKE_MCP_STDOUT_NOISE === '1';
const LOGIN_FAIL = process.env.FAKE_MCP_LOGIN_FAIL === '1';
const LOGIN_TIMEOUT = process.env.FAKE_MCP_LOGIN_TIMEOUT === '1';
const USER_ERROR = process.env.FAKE_MCP_USER_ERROR === '1';

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function toolResult(text, isError) {
  const result = { content: [{ type: 'text', text }] };
  if (isError) result.isError = true;
  return result;
}

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    // Ignore garbage the client might echo; a real server would too.
    return;
  }

  // Notifications carry no id and expect no reply.
  if (msg.id === undefined || msg.id === null) return;

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        serverInfo: { name: 'fake-mcp-server', version: '1.0.0' },
      },
    });
    return;
  }

  if (msg.method === 'tools/call') {
    if (HANG) return; // Deliberately no reply — client must time out and SIGKILL.

    if (NOISE) {
      // A real server sometimes logs to stdout; the client must skip non-JSON.
      process.stdout.write('[fake-mcp] handling tools/call (this is a log line)\n');
    }

    const name = msg.params && msg.params.name;
    let text;
    let isError = false;
    if (name === 'login') {
      if (LOGIN_FAIL) {
        // Mirrors index.js:105-109 (denied): isError with an error keyword.
        text = 'Authentication denied: login failed - device offline';
        isError = true;
      } else if (LOGIN_TIMEOUT) {
        // Mirrors index.js:94-104 verbatim opening: NO error keyword, isError:true.
        text = 'Authentication timed out after 2 minutes. Open the URL and retry.';
        isError = true;
      } else {
        // Mirrors index.js:93 success text (client keys on this, not "logged in").
        text = 'Successfully authenticated with Plaud!';
      }
    } else if (name === 'get_current_user') {
      if (USER_ERROR) {
        // Mirrors chunk-YI4KJEAG.js:249 (stale/invalid token).
        text = 'Failed to get user info: 401 Not authenticated';
        isError = true;
      } else {
        text = 'test@wentor.ai';
      }
    } else {
      text = 'unknown tool';
    }

    send({ jsonrpc: '2.0', id: msg.id, result: toolResult(text, isError) });
    return;
  }

  // Unknown method → JSON-RPC error so pending never hangs silently.
  send({
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: `method not found: ${msg.method}` },
  });
});

rl.on('close', () => process.exit(0));
