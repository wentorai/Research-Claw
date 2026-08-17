#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_OUTPUTS = [
  'extensions/research-claw-core/dist/index.js',
  'extensions/dual-model-supervisor/dist/index.js',
  'extensions/wentor-connect/dist/index.js',
  'extensions/openclaw-weixin/dist/index.js',
];

function parseArgs(argv) {
  const options = {
    root: path.resolve(__dirname, '..'),
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root' && argv[index + 1]) {
      options.root = path.resolve(argv[++index]);
    } else if (argument === '--json') {
      options.json = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
  }
  return options;
}

function inspectOutput(root, relative) {
  const target = path.join(root, ...relative.split('/'));
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) {
      return { relative, reason: 'not a non-empty regular file' };
    }
    return null;
  } catch (error) {
    return {
      relative,
      reason: error && typeof error.code === 'string'
        ? error.code
        : 'unreadable',
    };
  }
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[extension-build] ARGUMENT_ERROR: ${error.message}\n`);
    return 64;
  }

  const failures = REQUIRED_OUTPUTS
    .map((relative) => inspectOutput(options.root, relative))
    .filter(Boolean);
  if (failures.length > 0) {
    process.stderr.write(
      `[extension-build] EXTENSION_BUILD_INCOMPLETE: ${failures
        .map(({ relative, reason }) => `${relative} (${reason})`)
        .join(', ')}\n`,
    );
    return 78;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      outputs: REQUIRED_OUTPUTS,
    })}\n`);
  } else {
    process.stdout.write(
      `[extension-build] ${REQUIRED_OUTPUTS.length}/${REQUIRED_OUTPUTS.length} runtime entries ready\n`,
    );
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
} else {
  module.exports = { REQUIRED_OUTPUTS, inspectOutput };
}
