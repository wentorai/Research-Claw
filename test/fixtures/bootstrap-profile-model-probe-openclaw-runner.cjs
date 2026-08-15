'use strict';

const fs = require('node:fs');
const path = require('node:path');

const agentDir = process.env.OPENCLAW_AGENT_DIR;
const stateDir = process.env.OPENCLAW_STATE_DIR;
const configPath = process.env.OPENCLAW_CONFIG_PATH;
if (!agentDir || !stateDir || !configPath) process.exit(91);
if (process.argv.includes('--probe-profile')) process.exit(94);
const auth = JSON.parse(fs.readFileSync(path.join(agentDir, 'auth-profiles.json'), 'utf8'));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const profileIds = Object.keys(auth.profiles ?? {});
if (profileIds.length !== 1) process.exit(92);
fs.writeFileSync(path.join(agentDir, 'auth-state.json'), `${JSON.stringify({
  version: 1,
  usageStats: { [profileIds[0]]: { cooldownUntil: Date.now() + 60_000, cooldownReason: 'timeout' } },
})}\n`);
fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
fs.writeFileSync(path.join(stateDir, 'logs', 'probe-runtime.log'), 'fixture runtime residue\n');
if (config.fixtureProbeFailure === true) process.exit(93);
process.stdout.write(`${JSON.stringify({
  auth: { probes: { results: [{ provider: auth.profiles[profileIds[0]].provider, profileId: profileIds[0], status: 'ok' }] } },
})}\n`);
