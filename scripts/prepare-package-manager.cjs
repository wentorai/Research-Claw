#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const packageJson = JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
);
const requiredMatch = /^pnpm@([0-9]+\.[0-9]+\.[0-9]+)$/.exec(
  String(packageJson.packageManager ?? ''),
);

if (!requiredMatch) {
  console.error(
    '[research-claw] packageManager must declare an exact pnpm version.',
  );
  process.exitCode = 1;
  return;
}

const requiredVersion = requiredMatch[1];
const userAgent = String(process.env.npm_config_user_agent ?? '');
const runningMatch = /(?:^|\s)pnpm\/([0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)/.exec(
  userAgent,
);
const runningVersion = runningMatch?.[1] ?? null;

if (runningVersion && runningVersion !== requiredVersion) {
  console.error(
    `[research-claw] Finishing this update with the required pnpm ${requiredVersion} (current installer: ${runningVersion})...`,
  );
  const migration = spawnSync(
    process.execPath,
    [
      path.join(__dirname, 'run-pnpm.cjs'),
      'install',
      '--no-frozen-lockfile',
      '--ignore-scripts',
    ],
    {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
    },
  );
  if (migration.error) {
    console.error(
      `[research-claw] Unable to start the package-manager migration: ${migration.error.message}`,
    );
    process.exitCode = 1;
    return;
  }
  if (migration.status !== 0) {
    console.error(
      `[research-claw] Package-manager migration failed with exit code ${migration.status ?? 'unknown'}.`,
    );
    process.exitCode = migration.status ?? 1;
    return;
  }
}

// Developer convenience only. Installation and updates do not depend on this.
spawnSync('git', ['config', 'core.hooksPath', 'git-hooks'], {
  cwd: projectRoot,
  stdio: 'ignore',
});
