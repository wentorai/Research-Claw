'use strict';

const [applierFile, pathsJson, txId, workerFile] = process.argv.slice(2);
const applier = require(applierFile);
if (!applier.__testing) process.exit(2);
applier.__testing.inspectCronState(JSON.parse(pathsJson), txId, {
  workerFile,
  timeoutMs: 60_000,
}).then(
  () => { process.exitCode = 0; },
  () => { process.exitCode = 1; },
);
