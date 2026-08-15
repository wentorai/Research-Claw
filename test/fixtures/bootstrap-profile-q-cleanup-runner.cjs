'use strict';

const fs = require('node:fs');

const [applierFile, pathsBase64, txId, epoch, pausePhase, ready] = process.argv.slice(2);
const paths = JSON.parse(Buffer.from(pathsBase64, 'base64url').toString('utf8'));
const applier = require(applierFile);
if (!applier.__testing || !pausePhase || !ready) process.exit(2);

let created;
applier.__testing.runCronScratchCleanupProbe(
  paths,
  txId,
  epoch,
  (phase, context) => {
    if (phase === 'created') created = context;
    if (phase !== pausePhase) return;
    const temporary = `${ready}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify({
      version: 1,
      pid: process.pid,
      txId,
      epoch,
      phase,
      created,
      context,
    })}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, ready);
    for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
  },
);
