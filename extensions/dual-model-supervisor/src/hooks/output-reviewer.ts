/**
 * Dual Model Supervisor — Output Reviewer (message_sending hook)
 *
 * Reviews the main model's output before it reaches the user.
 * Quick check runs synchronously; when `appendReviewToChannelOutput` is true, deep review
 * is awaited and a non-empty review footer is always attached (including pass / unavailable fallbacks).
 */

import type { ReviewResult, SupervisorConfig, PluginLogger, SessionState } from '../core/types.js';
import { ReviewerClient } from '../client/reviewer.js';
import { QuickChecker } from './quick-checker.js';
import { AuditLogService } from '../core/audit-log.js';
import { isForceRegenerateActive } from '../core/config.js';
import { OUTPUT_REVIEW_SYSTEM_PROMPT } from '../core/prompts.js';
import { SUPERVISOR_REVIEW_SUMMARY_MARKER } from './hook-context.js';

/** Format a deep review result into a compact multi-line footer for appending to output. */
function formatDeepReviewForAppend(r: ReviewResult): string {
  const lines: string[] = [];
  if (r.blocked) lines.push('  ⛔ Deep review flagged this output (blocked)');
  for (const w of r.warnings) lines.push(`  ⚠ ${w}`);
  for (const m of r.memoryAlerts) lines.push(`  🧠 ${m}`);
  if (r.correctionNote) lines.push(`  📝 ${r.correctionNote}`);
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
   * Review output before sending to user. Returns modified message or null to pass through.
   * @param options.attachSummary When `true`, append review footer to message (used only for channel delivery).
   */
  async reviewMessageSending(
    message: string,
    sessionId: string,
    sessionState?: SessionState,
    options?: { attachSummary?: boolean },
  ): Promise<string | null> {
    if (!this.config.enabled || this.config.reviewMode === 'off') {
      this.logger.warn('[OutputReviewer] Review skipped: disabled or reviewMode=off');
      return null;
    }

    if (sessionState && isForceRegenerateActive(this.config) && sessionState.pendingForceRegenerate) {
      if (sessionState.regenerateAttempts < this.config.courseCorrection.maxRegenerateAttempts) {
        const maxAttempts = this.config.courseCorrection.maxRegenerateAttempts;
        const attempt = sessionState.regenerateAttempts + 1;
        this.auditLog.record({
          sessionId,
          type: 'force_regenerate',
          action: 'block',
          details: `Output blocked for force regeneration attempt ${attempt}/${maxAttempts}. Deviation score: ${sessionState.pendingForceRegenerate.deviationScore.toFixed(2)}`,
          timestamp: Date.now(),
        });
        const blockMessage = `🔄 [Supervisor] Output blocked — deviation detected (score: ${sessionState.pendingForceRegenerate.deviationScore.toFixed(2)}). Regenerating corrected content (attempt ${attempt}/${maxAttempts})...`;
        return blockMessage;
      } else {
        this.logger.warn(`[OutputReviewer] Force regeneration max attempts reached (${this.config.courseCorrection.maxRegenerateAttempts}), allowing output to pass`);
      }
    }

    if (message.includes(SUPERVISOR_REVIEW_SUMMARY_MARKER)) {
      return null;
    }

    const quickResult = this.quickChecker.check(message);

    if (quickResult.blocked) {
      this.logger.warn(`[OutputReviewer] Quick check blocked: ${quickResult.blockReason}`);
      this.auditLog.record({
        sessionId,
        type: 'output_review',
        action: 'block',
        details: quickResult.blockReason ?? 'Blocked by quick checker',
        timestamp: Date.now(),
      });
      const blockMessage = `⚠️ [Supervisor] Output blocked by review. Reason: ${quickResult.blockReason}`;
      return blockMessage;
    }

    const attachSummary = options?.attachSummary ?? false;

    let deep: ReviewResult | null = null;

    if (sessionState) {
      deep = await this.deepReview(message, sessionId, sessionState);

      // Always store the review report in session state for Dashboard panel display
      if (deep) {
        const reportBody = deep.reportText?.trim()
          ? deep.reportText.trim()
          : formatDeepReviewForAppend(deep);
        sessionState.lastReviewReport = reportBody;
      }
    } else {
      this.logger.warn('[OutputReviewer] Deep review skipped: no session state');
    }

    if (quickResult.warnings.length > 0) {
      for (const w of quickResult.warnings) {
        this.logger.warn(`[OutputReviewer] Quick check warning: ${w}`);
        this.auditLog.record({
          sessionId,
          type: 'output_review',
          action: 'warn',
          details: w,
          timestamp: Date.now(),
        });
      }
    }

    // Only append footer when explicitly requested (channel delivery scenario)
    if (!attachSummary) {
      return null;
    }

    const sections: string[] = [];
    if (quickResult.warnings.length > 0) {
      sections.push(...quickResult.warnings.map((w) => `  ⚠ [Quick] ${w}`));
    }

    // Prefer supervisor model's natural-language report; fall back to structured footer
    if (deep) {
      const reportBody = deep.reportText?.trim()
        ? deep.reportText.trim()
        : formatDeepReviewForAppend(deep);
      sections.push(reportBody);
    } else if (sessionState) {
      sections.push(
        '  ℹ [Supervisor] Deep review did not return a result (reviewer unavailable, timeout, or parse error). Quick check passed.',
      );
      this.logger.warn('[OutputReviewer] Deep review unavailable, adding fallback message');
    } else {
      sections.push('  ℹ [Supervisor] Deep review was skipped (no session state). Quick check passed.');
    }

    const finalMessage = `${message}\n\n---\n${SUPERVISOR_REVIEW_SUMMARY_MARKER}\n${sections.join('\n')}`;
    return finalMessage;
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

    const userContent = contextParts.length > 0
      ? `## Context\n${contextParts.join('\n\n')}\n\n## Output to Review\n${message}`
      : message;

    const result = await this.reviewerClient.review<ReviewResult>(
      OUTPUT_REVIEW_SYSTEM_PROMPT,
      userContent,
    );

    if (!result) {
      this.logger.warn(`[OutputReviewer] Deep review unavailable for session ${sessionId} (reviewer call failed)`);
      this.auditLog.record({
        sessionId,
        type: 'output_review',
        action: 'info',
        details: 'Deep review failed (reviewer unavailable)',
        timestamp: Date.now(),
      });
      return null;
    }

    const action = result.blocked ? 'block' : result.corrected ? 'correct' : result.warnings.length > 0 ? 'warn' : 'pass';

    const details = action === 'pass'
      ? `Review passed (quality: ${result.qualityScore.toFixed(2)}, deviation: ${result.deviationScore.toFixed(2)})`
      : result.correctionNote ?? result.warnings.join('; ') ?? 'Review passed';

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
