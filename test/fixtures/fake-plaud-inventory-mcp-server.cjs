#!/usr/bin/env node

/**
 * Minimal stdio MCP server for the T07/T04 OpenClaw inventory boundary probe.
 * It exposes Plaud-shaped tools without network access, credentials, or writes.
 */

'use strict';

const readline = require('node:readline');

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

const tools = [
  {
    name: 'list_files',
    description: 'List fixture recordings.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_transcript',
    description: 'Read a fixture transcript.',
    inputSchema: {
      type: 'object',
      properties: { file_id: { type: 'string' } },
      required: ['file_id'],
      additionalProperties: false,
    },
  },
];

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined || request.id === null) return;
  if (request.method === 'initialize') {
    send(request.id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 't07-plaud-inventory-fixture', version: '1.0.0' },
    });
    return;
  }
  if (request.method === 'tools/list') {
    send(request.id, { tools });
    return;
  }
  if (request.method === 'tools/call') {
    send(request.id, { content: [{ type: 'text', text: 'fixture-only' }] });
    return;
  }
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: request.id,
    error: { code: -32601, message: `method not found: ${request.method}` },
  })}\n`);
});
