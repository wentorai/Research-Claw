/**
 * rc.onboarding.status — server-side first-run signals for the dashboard
 * welcome card.
 *
 * firstRun is true ONLY when every signal says "genuine first-time user":
 * BOOTSTRAP.md present, no .done sentinel, zero papers, zero tasks.
 * Every probe fails safe: any error pushes its signal toward "not a first
 * run" (bootstrapPresent=false / doneExists=true / counts=-1), so a veteran
 * is never greeted as a newcomer.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { LiteratureService } from '../literature/service.js';
import type { TaskService } from '../tasks/service.js';
import type { RegisterMethod } from '../types.js';
import { bootstrapDoneExists } from './bootstrap-done.js';

export interface OnboardingRpcDeps {
  // Getters (not instances): RPC registration runs on EVERY register() pass,
  // and services live in module-level singletons that may not be initialized
  // yet on a given pass. Null from any getter → fail-safe response.
  getWorkspaceRoot: () => string | null;
  getLitService: () => LiteratureService | null;
  getTaskService: () => TaskService | null;
}

export interface OnboardingStatus {
  firstRun: boolean;
  signals: {
    bootstrapPresent: boolean;
    doneExists: boolean;
    /** -1 = probe failed or service unavailable (treated as nonzero) */
    paperCount: number;
    /** -1 = probe failed or service unavailable (treated as nonzero) */
    taskCount: number;
  };
}

export function registerOnboardingRpc(
  registerMethod: RegisterMethod,
  deps: OnboardingRpcDeps,
): void {
  registerMethod('rc.onboarding.status', async (): Promise<OnboardingStatus> => {
    // Safe defaults — each one alone collapses firstRun to false.
    let bootstrapPresent = false;
    let doneExists = true;
    let paperCount = -1;
    let taskCount = -1;

    let root: string | null = null;
    try {
      root = deps.getWorkspaceRoot();
    } catch {
      root = null;
    }

    if (root) {
      try {
        bootstrapPresent = fs.existsSync(path.join(root, '.ResearchClaw', 'BOOTSTRAP.md'));
      } catch {
        bootstrapPresent = false;
      }
      try {
        doneExists = bootstrapDoneExists(root);
      } catch {
        doneExists = true;
      }
    }

    try {
      const lit = deps.getLitService();
      if (lit) paperCount = lit.getStats().total;
    } catch {
      paperCount = -1;
    }

    try {
      const tasks = deps.getTaskService();
      if (tasks) taskCount = tasks.list({ include_completed: true, limit: 1 }).total;
    } catch {
      taskCount = -1;
    }

    const firstRun = bootstrapPresent && !doneExists && paperCount === 0 && taskCount === 0;
    return { firstRun, signals: { bootstrapPresent, doneExists, paperCount, taskCount } };
  });
}
