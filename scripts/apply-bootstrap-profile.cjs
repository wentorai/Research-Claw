#!/usr/bin/env node
'use strict';

// Local-only RC Bootstrap Profile entrypoint. The command accepts decoded
// Capsule bytes through stdin or an explicit private file; installer wiring is
// intentionally owned by T06.
const { main } = require('./bootstrap-profile/cli.cjs');

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error) => {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
      ? error.code : 'BOOTSTRAP_PROFILE_OPERATION_FAILED';
    process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
    process.exitCode = 1;
  },
);
