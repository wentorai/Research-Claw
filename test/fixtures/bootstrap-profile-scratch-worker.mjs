import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const stateIndex = args.indexOf('--state-dir');
const stateDir = stateIndex >= 0 ? args[stateIndex + 1] : '';
const home = process.env.HOME ?? '';
const tmpdir = process.env.TMPDIR ?? '';
if (!path.isAbsolute(stateDir) || !path.isAbsolute(home) || !path.isAbsolute(tmpdir)) process.exit(2);
const homeMetadata = fs.lstatSync(home);
const tmpMetadata = fs.lstatSync(tmpdir);
fs.appendFileSync(path.join(stateDir, '.scratch-workers-ready'), `${JSON.stringify({
  pid: process.pid,
  home,
  tmpdir,
  homeIdentity: {
    dev: String(homeMetadata.dev),
    ino: String(homeMetadata.ino),
    mode: process.platform === 'win32' ? null : homeMetadata.mode & 0o7777,
  },
  tmpIdentity: {
    dev: String(tmpMetadata.dev),
    ino: String(tmpMetadata.ino),
    mode: process.platform === 'win32' ? null : tmpMetadata.mode & 0o7777,
  },
})}\n`, { mode: 0o600 });
setInterval(() => {}, 60_000);
