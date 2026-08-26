import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createGitTracker } from '../workspace/git-tracker.js';

const originalPath = process.env.PATH;
const originalAudit = process.env.WENTOR_GIT_AUDIT;
const originalRealGit = process.env.WENTOR_REAL_GIT;

function restoreEnvironment(): void {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalAudit === undefined) delete process.env.WENTOR_GIT_AUDIT;
  else process.env.WENTOR_GIT_AUDIT = originalAudit;
  if (originalRealGit === undefined) delete process.env.WENTOR_REAL_GIT;
  else process.env.WENTOR_REAL_GIT = originalRealGit;
}

describe.skipIf(process.platform === 'win32')(
  'workspace Git subprocess boundary',
  () => {
    afterEach(() => restoreEnvironment());

    it('closes stdin and disables inherited interactive Git behavior', async () => {
      const taskRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'rc-workspace-git-noninteractive-'),
      );
      const binDir = path.join(taskRoot, 'fake bin');
      const workspaceRoot = path.join(taskRoot, 'Research Claw 工作区');
      const auditPath = path.join(taskRoot, 'git-audit.tsv');
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(workspaceRoot, { recursive: true });

      const realGit = execFileSync('sh', ['-c', 'command -v git'], {
        encoding: 'utf8',
      }).trim();
      const wrapper = path.join(binDir, 'git');
      fs.writeFileSync(
        wrapper,
        `#!/bin/sh
IFS= read -r _unexpected_stdin
read_status=$?
if [ "$read_status" -ne 1 ]; then
  printf 'stdin-not-closed:%s\\n' "$read_status" >&2
  exit 91
fi
[ "\${GIT_TERMINAL_PROMPT:-}" = "0" ] || exit 92
[ "\${GCM_INTERACTIVE:-}" = "Never" ] || exit 93
[ "\${GIT_CONFIG_GLOBAL:-}" = "/dev/null" ] || exit 94
printf '%s\\n' "$*" >> "$WENTOR_GIT_AUDIT"
case " $* " in
  *" commit "*)
    case " $* " in *" -c commit.gpgSign=false "*) ;; *) exit 95 ;; esac
    case " $* " in *" -c core.hooksPath="*) ;; *) exit 96 ;; esac
    ;;
esac
exec "$WENTOR_REAL_GIT" "$@"
`,
        { mode: 0o700 },
      );

      process.env.PATH = `${binDir}:${originalPath ?? ''}`;
      process.env.WENTOR_GIT_AUDIT = auditPath;
      process.env.WENTOR_REAL_GIT = realGit;

      const tracker = createGitTracker({
        workspaceRoot,
        authorName: 'Research-Claw',
        authorEmail: 'workspace@research-claw.local',
        commitDebounceMs: 0,
        maxFileSize: 1024 * 1024,
        enabled: true,
      });

      try {
        await tracker.init();
        const audit = fs.readFileSync(auditPath, 'utf8');
        expect(audit).toContain('commit.gpgSign=false');
        expect(audit).toContain('core.hooksPath=');
        expect(
          execFileSync(realGit, ['status', '--porcelain'], {
            cwd: workspaceRoot,
            encoding: 'utf8',
          }),
        ).toBe('');
      } finally {
        tracker.destroy();
        fs.rmSync(taskRoot, { recursive: true, force: true });
      }
    }, 15_000);
  },
);
