import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const stateIndex = args.indexOf('--state-dir');
if (stateIndex < 0 || !path.isAbsolute(args[stateIndex + 1] ?? '')) process.exit(2);
const stateDir = args[stateIndex + 1];
fs.writeFileSync(path.join(stateDir, '.worker-ready'), `${JSON.stringify({ pid: process.pid })}\n`, {
  mode: 0o600,
});
setInterval(() => {}, 60_000);
