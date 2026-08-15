#!/usr/bin/env node
'use strict';

const MAX_STATUS_BYTES = 64 * 1024;

async function main() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_STATUS_BYTES) return 64;
    chunks.push(bytes);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks, total).toString('utf8')); } catch { return 64; }
  const pending = value?.pendingTransaction;
  if (pending === null) return 0;
  if (!pending || typeof pending !== 'object') return 64;
  const admitted = process.env.RC_BOOTSTRAP_TX_ID ?? '';
  const valid = /^tx-[0-9a-f-]{36}$/.test(admitted)
    && admitted === pending.txId
    && ['applied', 'verified'].includes(pending.state);
  return valid ? 0 : 42;
}

main().then(
  (code) => { process.exitCode = code; },
  () => { process.exitCode = 64; },
);
