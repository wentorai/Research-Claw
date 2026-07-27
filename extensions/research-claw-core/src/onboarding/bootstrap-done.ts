/**
 * BOOTSTRAP.md.done sentinel detection.
 *
 * Onboarding completion renames .ResearchClaw/BOOTSTRAP.md to
 * BOOTSTRAP.md.done. The sentinel may live in two places:
 *   - <workspaceRoot>/.ResearchClaw/BOOTSTRAP.md.done (canonical)
 *   - <workspaceRoot>/BOOTSTRAP.md.done (the agent may write it at the root
 *     before migratePromptFiles moves it into .ResearchClaw/)
 *
 * Shared by rc.onboarding.status (first-run detection) and the
 * agent:bootstrap redirect hook (loading layer historically never checked
 * .done → onboarding re-ran on BOOTSTRAP.md residue).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * True if the onboarding completion sentinel exists in either location.
 * Fail-safe: any probe error reports true ("done") so consumers never
 * re-run onboarding for — or greet — a veteran by mistake.
 */
export function bootstrapDoneExists(workspaceRoot: string): boolean {
  try {
    return (
      fs.existsSync(path.join(workspaceRoot, '.ResearchClaw', 'BOOTSTRAP.md.done')) ||
      fs.existsSync(path.join(workspaceRoot, 'BOOTSTRAP.md.done'))
    );
  } catch {
    return true;
  }
}
