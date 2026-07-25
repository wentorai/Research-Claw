/**
 * Dual Model Supervisor — Output Reviewer (llm_output hook)
 *
 * Reviews the main model's output ASYNCHRONOUSLY and records the result to the audit
 * log + the Dashboard panel report. It NEVER modifies or blocks the outbound message:
 * OC fires llm_output fire-and-forget and the message is delivered before the review
 * resolves, so a suggested correction is recorded as a SUGGESTION (never applied), and
 * findings are advisory. The review result reaches the user via the audit / panel / RPC
 * path (the truth source), not by appending to output.
 */

import type { ReviewResult, SupervisorConfig, PluginLogger, SessionState } from '../core/types.js';
import { ReviewerClient } from '../client/reviewer.js';
import { QuickChecker } from './quick-checker.js';
import { AuditLogService } from '../core/audit-log.js';
import { OUTPUT_REVIEW_SYSTEM_PROMPT } from '../core/prompts.js';
import { validateReviewResult } from '../core/validators.js';

/** Format a deep review result into a compact multi-line report for the Dashboard panel. */
function formatReviewReport(r: ReviewResult): string {
  const lines: string[] = [];
  if (r.blocked) lines.push('  ⛔ Deep review flagged this output');
  for (const w of r.warnings) lines.push(`  ⚠ ${w}`);
  for (const m of r.memoryAlerts) lines.push(`  🧠 ${m}`);
  // A correctedVersion is only a SUGGESTION — it is never applied to the delivered output.
  if (r.corrected && r.correctionNote) lines.push(`  📝 Suggested correction: ${r.correctionNote}`);
  lines.push(`  (quality ${r.qualityScore.toFixed(2)}, deviation ${r.deviationScore.toFixed(2)})`);
  return lines.join('\n');
}

export class OutputReviewer {
  private config: SupervisorConfig;
  private logger: PluginLogger;
  private reviewerClient: ReviewerClient;
  private quickChecker: QuickChecker;
  private auditLog: AuditLogService;

  constructor(
    config: SupervisorConfig,
    logger: PluginLogger,
    reviewerClient: ReviewerClient,
    quickChecker: QuickChecker,
    auditLog: AuditLogService,
  ) {
    this.config = config;
    this.logger = logger;
    this.reviewerClient = reviewerClient;
    this.quickChecker = quickChecker;
    this.auditLog = auditLog;
  }

  updateConfig(config: SupervisorConfig): void {
    this.config = config;
    this.quickChecker.updateConfig(config);
  }

  /**
   * Review the main model's output ASYNCHRONOUSLY. Records findings to the audit log +
   * the Dashboard panel report (sessionState.lastReviewReport). NEVER returns or applies
   * modified text — the message has already been delivered (OC fires llm_output
   * fire-and-forget). All findings are advisory; a `correctedVersion` is a SUGGESTION,
   * never applied. Never throws; never blocks.
   */
  async reviewOutput(message: string, sessionId: string, sessionState?: SessionState): Promise<void> {
    if (!this.config.enabled || this.config.reviewMode === 'off') {
      return;
    }

    const quickResult = this.quickChecker.check(message);
    if (quickResult.blocked) {
      // Advisory only — output review NEVER blocks/modifies the delivered message.
      this.auditLog.record({
        sessionId,
        type: 'output_review',
        action: 'warn',
        details: `Quick check flagged output (advisory, not blocked): ${quickResult.blockReason ?? 'flagged'}`,
        timestamp: Date.now(),
      });
    }
    for (const w of quickResult.warnings) {
      this.auditLog.record({ sessionId, type: 'output_review', action: 'warn', details: w, timestamp: Date.now() });
    }

    if (!sessionState) {
      return;
    }

    const deep = await this.deepReview(message, sessionId, sessionState);
    if (deep) {
      // Store the review report for the Dashboard panel (truth source is audit/DB).
      sessionState.lastReviewReport = deep.reportText?.trim() ? deep.reportText.trim() : formatReviewReport(deep);
    }
  }

  /**
   * Deep review: send the output to the reviewer model with session context for
   * multi-dimensional assessment (safety, quality, deviation, memory consistency).
   * Returns structured ReviewResult or null if reviewer is unavailable.
   */
  async deepReview(message: string, sessionId: string, sessionState: SessionState): Promise<ReviewResult | null> {
    if (!this.config.enabled || this.config.reviewMode === 'off') {
      this.logger.warn('[OutputReviewer] Deep review skipped: disabled or reviewMode=off');
      return null;
    }

    const contextParts: string[] = [];
    if (sessionState.researchGoal) {
      contextParts.push(`Current research goal: ${sessionState.researchGoal}`);
    }
    if (sessionState.keyConclusions.length > 0) {
      contextParts.push(`Key conclusions so far: ${sessionState.keyConclusions.join('; ')}`);
    }
    if (sessionState.recentOutputs.length > 0) {
      const lastN = sessionState.recentOutputs.slice(-3);
      contextParts.push(`Recent outputs: ${lastN.join('\n---\n')}`);
    }

    const innerContent = contextParts.length > 0
      ? `## Context\n${contextParts.join('\n\n')}\n\n## Output to Review\n${message}`
      : message;
    const userContent = `<user_content>\n${innerContent}\n</user_content>`;

    const raw = await this.reviewerClient.review<Record<string, unknown>>(
      OUTPUT_REVIEW_SYSTEM_PROMPT,
      userContent,
    );

    // Distinguish reviewer-unavailable (null raw) from schema-invalid (responded
    // but malformed). Both are observable degrades — never a silent pass.
    if (raw === null) {
      this.auditLog.record({
        sessionId,
        type: 'output_review',
        action: 'warn',
        details: 'Deep review degraded: reviewer unavailable (timeout/network)',
        timestamp: Date.now(),
      });
      return null;
    }

    const result = validateReviewResult(raw);

    if (!result) {
      this.auditLog.record({
        sessionId,
        type: 'output_review',
        action: 'warn',
        details: 'Deep review degraded: reviewer response schema_invalid',
        timestamp: Date.now(),
      });
      return null;
    }

    // Output review is ADVISORY: it never blocks or applies a correction, so a flag or a
    // suggested correction is recorded as 'warn' (not 'block'/'correct', which would imply
    // enforcement). Only a clean review is 'pass'.
    const advisory = result.blocked || result.corrected || result.warnings.length > 0;
    const action = advisory ? 'warn' : 'pass';

    const details = !advisory
      ? `Review passed (quality: ${result.qualityScore.toFixed(2)}, deviation: ${result.deviationScore.toFixed(2)})`
      : result.corrected
        ? `Suggested correction (advisory, not applied): ${result.correctionNote ?? 'see correctedVersion'}`
        : result.blocked
          ? `Flagged (advisory, output not blocked): ${result.correctionNote ?? result.warnings.join('; ') ?? 'flagged'}`
          : result.warnings.join('; ');

    this.auditLog.record({
      sessionId,
      type: 'output_review',
      action,
      details,
      metadata: JSON.stringify(result),
      timestamp: Date.now(),
    });

    return result;
  }
}
