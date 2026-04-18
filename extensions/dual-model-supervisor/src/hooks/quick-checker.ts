/**
 * Dual Model Supervisor — Quick Checker (Synchronous, Local Rules)
 */

import type { SupervisorConfig, PluginLogger } from '../core/types.js';

const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\s+\//i,
  /\bformat\s+[a-z]:/i,
  /\bdd\s+if=/i,
  /:\(\)\s*\{[^}]*:\s*\|\s*:&\s*\}/,  // Fork bomb: :(){ :|:& };:
];

const PRIVACY_PATTERNS = [
  /\b(?:password|passwd|secret|token)\s*[=:]\s*['"][^'"]{8,}/i,
  /\b(?:api[_-]?key|access[_-]?key)\s*[=:]\s*['"][^'"]{8,}/i,
];

const FABRICATED_CITATION_PATTERNS = [
  /\bdoi:\s*10\.\d{4}\/[a-z0-9.-]+\/?\s*\([^)]*\d{4}[^)]*\)/i,
];

export interface QuickCheckResult {
  blocked: boolean;
  blockReason?: string;
  warnings: string[];
}

export class QuickChecker {
  private config: SupervisorConfig;
  private logger: PluginLogger;

  constructor(config: SupervisorConfig, logger: PluginLogger) {
    this.config = config;
    this.logger = logger;
  }

  updateConfig(config: SupervisorConfig): void {
    this.config = config;
  }

  check(content: string): QuickCheckResult {
    if (!this.config.enabled || this.config.reviewMode === 'off') {
      return { blocked: false, warnings: [] };
    }

    const warnings: string[] = [];
    let blocked = false;
    let blockReason: string | undefined;

    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(content)) {
        blocked = true;
        blockReason = 'Output contains potentially dangerous command patterns';
        this.logger.warn(`[QuickChecker] Blocked: dangerous pattern matched`);
        break;
      }
    }

    for (const pattern of PRIVACY_PATTERNS) {
      if (pattern.test(content)) {
        blocked = true;
        blockReason = 'Output may contain sensitive credentials or personal information';
        this.logger.warn(`[QuickChecker] Blocked: privacy leakage pattern matched`);
        break;
      }
    }

    for (const pattern of FABRICATED_CITATION_PATTERNS) {
      if (pattern.test(content)) {
        warnings.push('Output may contain fabricated citation patterns');
        break;
      }
    }

    return { blocked, blockReason, warnings };
  }

  /**
   * Synchronous quick-check on a tool call.
   * Only processes tools listed in `config.highRiskTools`:
   *  - `exec`: blocks dangerous shell commands
   *  - `write`/`edit`: blocks writes to system directories
   *  - other high-risk tools: returns a warning
   */
  checkToolCall(tool: string, params: Record<string, unknown>): QuickCheckResult {
    if (!this.config.enabled || this.config.reviewMode === 'off') {
      return { blocked: false, warnings: [] };
    }

    const isHighRisk = this.config.highRiskTools.includes(tool);
    if (!isHighRisk) {
      return { blocked: false, warnings: [] };
    }

    if (tool === 'exec') {
      const command = String(params.command ?? params.cmd ?? '');
      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(command)) {
          this.logger.warn(`[QuickChecker] Blocked exec: dangerous command pattern`);
          return {
            blocked: true,
            blockReason: 'Dangerous command detected in exec call',
            warnings: [],
          };
        }
      }
    }

    if (tool === 'write' || tool === 'edit') {
      const filePath = String(params.path ?? params.file ?? '');
      if (filePath.includes('/etc/') || filePath.includes('/System/')) {
        this.logger.warn(`[QuickChecker] Blocked write to system path: ${filePath}`);
        return {
          blocked: true,
          blockReason: `Attempt to write to system directory: ${filePath}`,
          warnings: [],
        };
      }
    }

    return { blocked: false, warnings: [`High-risk tool call: ${tool}`] };
  }
}
