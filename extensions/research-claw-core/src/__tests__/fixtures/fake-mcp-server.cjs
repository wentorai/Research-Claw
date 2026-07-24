#!/usr/bin/env node
/**
 * Fake stdio MCP server for PlaudManager tests (Task 6).
 *
 * Speaks newline-delimited JSON-RPC 2.0 over stdin/stdout, mirroring the
 * @plaud-ai/mcp stdio transport so PlaudManager can be exercised offline.
 *
 * Behaviour:
 *   - `initialize` request → replies with a minimal result.
 *   - `notifications/initialized` notification → ignored (no id, no reply).
 *   - `tools/call` request:
 *       name=login            → {content:[{type:'text',text:'Logged in as test@wentor.ai'}]}
 *       name=get_current_user → {content:[{type:'text',text:'test@wentor.ai'}]}
 *       (anything else)       → {content:[{type:'text',text:'unknown tool'}]}
 *
 * Env knobs (for edge-case tests):
 *   FAKE_MCP_HANG=1         → never answer `tools/call` (test timeout + SIGKILL).
 *   FAKE_MCP_STDOUT_NOISE=1 → print a non-JSON log line to stdout before each
 *                             `tools/call` reply (test noise tolerance).
 *   FAKE_MCP_LOGIN_FAIL=1   → the `login` tool returns error text so the client
 *                             maps it to {ok:false} (test login failure mapping).
 */

'use strict';

const readline = require('node:readline');

const HANG = process.env.FAKE_MCP_HANG === '1';
const NOISE = process.env.FAKE_MCP_STDOUT_NOISE === '1';
const LOGIN_FAIL = process.env.FAKE_MCP_LOGIN_FAIL === '1';

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function toolResult(text) {
  return { content: [{ type: 'text', text }] };
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
    if (name === 'login') {
      text = LOGIN_FAIL ? 'Error: login failed - device offline' : 'Logged in as test@wentor.ai';
    } else if (name === 'get_current_user') {
      text = 'test@wentor.ai';
    } else {
      text = 'unknown tool';
    }

    send({ jsonrpc: '2.0', id: msg.id, result: toolResult(text) });
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
