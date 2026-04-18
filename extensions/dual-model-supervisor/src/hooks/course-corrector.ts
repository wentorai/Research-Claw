/**
 * Dual Model Supervisor — Course Corrector (agent_end + before_prompt_build hooks)
 *
 * Analyzes session after agent turn completes, and injects corrections
 * into the next turn's prompt context.
 * When forceRegenerate is enabled, blocks deviated output and triggers
 * regeneration with strong correction instructions.
 */

import type { SupervisorConfig, PluginLogger, SessionState, RegenerateHistoryEntry } from '../core/types.js';
import { ReviewerClient } from '../client/reviewer.js';
import { AuditLogService } from '../core/audit-log.js';
import { SESSION_ANALYSIS_SYSTEM_PROMPT, FORCE_REGENERATE_CORRECTION_PROMPT } from '../core/prompts.js';
import { isCourseCorrectionActive, isSupervisorActive, isForceRegenerateActive } from '../core/config.js';
import { buildSessionContextLines } from '../utils/session-context.js';
import { validateDeviationAnalysis } from '../core/validators.js';

interface SessionAnalysisResult {
  deviation: number;
  memoryLoss: boolean;
  qualityScore: number;
  courseCorrection: string;
  summary: string;
}

interface ForceRegenerateCorrectionResult {
  correctionInstruction: string;
  deviationSummary: string;
  requiredTopics: string[];
  forbiddenTopics: string[];
}

export class CourseCorrector {
  private config: SupervisorConfig;
  private logger: PluginLogger;
  private reviewerClient: ReviewerClient;
  private auditLog: AuditLogService;

  constructor(
    config: SupervisorConfig,
    logger: PluginLogger,
    reviewerClient: ReviewerClient,
    auditLog: AuditLogService,
  ) {
    this.config = config;
    this.logger = logger;
    this.reviewerClient = reviewerClient;
    this.auditLog = auditLog;
  }

  /** Hot-reload updated config from the dashboard without re-instantiating. */
  updateConfig(config: SupervisorConfig): void {
    this.config = config;
  }

  analyzeSession(sessionId: string, sessionState: SessionState): void {
    if (!isCourseCorrectionActive(this.config)) return;

    this._doAnalyze(sessionId, sessionState).catch((err) => {
      this.logger.error(`Course correction analysis failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private async _doAnalyze(sessionId: string, sessionState: SessionState): Promise<void> {
    try {
      const contextParts = buildSessionContextLines(sessionState);

      if (sessionState.lastLlmOutput?.trim()) {
        contextParts.push(`Latest assistant output:\n${sessionState.lastLlmOutput.slice(0, 12_000)}`);
      }

      if (sessionState.recentSummaries.length > 0) {
        const summaryText = sessionState.recentSummaries
          .slice(-5)
          .map((s) => {
            const parts: string[] = [];
            if (s.claims.length > 0) parts.push(`Claims: ${s.claims.join('; ')}`);
            if (s.decisions.length > 0) parts.push(`Decisions: ${s.decisions.join('; ')}`);
            return parts.join(' | ');
          })
          .join('\n---\n');
        contextParts.push(`Recent work summaries:\n${summaryText}`);
      } else if (sessionState.recentOutputs.length > 0) {
        contextParts.push(`Recent outputs (last 3): ${sessionState.recentOutputs.slice(-3).join('\n---\n')}`);
      }

      const sessionText = contextParts.length > 0
        ? contextParts.join('\n\n')
        : 'No session context available for analysis.';
      const userContent = `<user_content>\n${sessionText}\n</user_content>`;

      const raw = await this.reviewerClient.review<Record<string, unknown>>(
        SESSION_ANALYSIS_SYSTEM_PROMPT,
        userContent,
      );
      const result = validateDeviationAnalysis(raw);

      if (!result) return;

      this.auditLog.record({
        sessionId,
        type: 'session_analysis',
        action: result.deviation > this.config.courseCorrection.deviationThreshold ? 'warn' : 'info',
        details: result.summary ?? `Deviation: ${result.deviation.toFixed(2)}, Quality: ${result.qualityScore.toFixed(2)}`,
        metadata: JSON.stringify(result),
        timestamp: Date.now(),
      });

      if (result.deviation > this.config.courseCorrection.deviationThreshold && result.courseCorrection) {
        sessionState.pendingCourseCorrection = result.courseCorrection;

        if (isForceRegenerateActive(this.config)) {
          const maxAttempts = this.config.courseCorrection.maxRegenerateAttempts;
          if (sessionState.regenerateAttempts < maxAttempts) {
            const correctionResult = await this._generateForceRegenerateCorrection(sessionState, result);
            if (correctionResult) {
              const originalPreview = sessionState.lastLlmOutput
                ? sessionState.lastLlmOutput.slice(0, 200)
                : '(no output captured)';

              sessionState.pendingForceRegenerate = {
                deviationScore: result.deviation,
                correctionInstruction: correctionResult.correctionInstruction,
                originalOutputPreview: originalPreview,
              };

              this.auditLog.record({
                sessionId,
                type: 'force_regenerate',
                action: 'block',
                details: `Deviation ${result.deviation.toFixed(2)} triggered force regeneration (attempt ${sessionState.regenerateAttempts + 1}/${maxAttempts}): ${correctionResult.deviationSummary}`,
                metadata: JSON.stringify(correctionResult),
                timestamp: Date.now(),
              });
            }
          } else {
            this.auditLog.record({
              sessionId,
              type: 'force_regenerate',
              action: 'warn',
              details: `Max regeneration attempts (${maxAttempts}) reached. Deviation persists at ${result.deviation.toFixed(2)}.`,
              timestamp: Date.now(),
            });
          }
        }
      }

      if (result.memoryLoss) {
        this.auditLog.record({
          sessionId,
          type: 'course_correction',
          action: 'warn',
          details: 'Session analysis detected potential memory loss',
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      this.logger.error(`Course correction analysis failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async _generateForceRegenerateCorrection(
    sessionState: SessionState,
    analysisResult: SessionAnalysisResult,
  ): Promise<ForceRegenerateCorrectionResult | null> {
    const contextParts: string[] = [];

    if (sessionState.researchGoal) {
      contextParts.push(`Research goal: ${sessionState.researchGoal}`);
    }
    if (sessionState.targetConclusions.length > 0) {
      contextParts.push(`Target conclusions: ${sessionState.targetConclusions.join('; ')}`);
    }
    if (sessionState.lastLlmOutput) {
      contextParts.push(`Deviated output:\n${sessionState.lastLlmOutput.slice(0, 1000)}`);
    }
    contextParts.push(`Deviation score: ${analysisResult.deviation.toFixed(2)}`);
    contextParts.push(`Initial correction note: ${analysisResult.courseCorrection}`);

    if (sessionState.regenerateHistory.length > 0) {
      const previousAttempts = sessionState.regenerateHistory
        .map((h) => `Attempt ${h.attempt}: deviation=${h.deviationScore.toFixed(2)}, result=${h.result}`)
        .join('; ');
      contextParts.push(`Previous regeneration attempts: ${previousAttempts}`);
    }

    const userContent = `<user_content>\n${contextParts.join('\n\n')}\n</user_content>`;

    try {
      const result = await this.reviewerClient.review<ForceRegenerateCorrectionResult>(
        FORCE_REGENERATE_CORRECTION_PROMPT,
        userContent,
      );
      return result;
    } catch (err) {
      this.logger.error(`Force regenerate correction generation failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  buildContextInjection(sessionState: SessionState): { prependContext?: string } {
    if (!isSupervisorActive(this.config)) return {};

    const lines: string[] = [];

    if (sessionState.lostMemorySummary) {
      lines.push('[Supervisor] ⚠️ Context compaction may have lost the following key information. Refer to it:');
      lines.push(sessionState.lostMemorySummary);
      lines.push('');
      sessionState.lostMemorySummary = undefined;
    }

    if (sessionState.pendingCourseCorrection && isCourseCorrectionActive(this.config)) {
      lines.push('[Supervisor] 🧭 Drift detected in the previous turn. Please note:');
      lines.push(sessionState.pendingCourseCorrection);
      lines.push('');
      sessionState.pendingCourseCorrection = undefined;
    }

    if (sessionState.pendingForceRegenerate && isForceRegenerateActive(this.config)) {
      const pfr = sessionState.pendingForceRegenerate;
      const maxAttempts = this.config.courseCorrection.maxRegenerateAttempts;
      const remaining = maxAttempts - sessionState.regenerateAttempts;

      lines.push('[Supervisor] 🚫 Your previous output was BLOCKED because it deviated from the research goal.');
      lines.push(`[Supervisor] Deviation score: ${pfr.deviationScore.toFixed(2)} (threshold: ${this.config.courseCorrection.deviationThreshold})`);
      lines.push(`[Supervisor] Regeneration attempt ${sessionState.regenerateAttempts + 1} of ${maxAttempts}. ${remaining > 0 ? `${remaining} attempt(s) remaining.` : 'This is the final attempt.'}`);
      lines.push('');
      lines.push('[Supervisor] You MUST regenerate your output following this correction:');
      lines.push(pfr.correctionInstruction);
      lines.push('');
      lines.push('[Supervisor] Your previous deviated output (for reference — do NOT repeat it):');
      lines.push(pfr.originalOutputPreview);
      lines.push('');
      lines.push('[Supervisor] IMPORTANT: Do NOT simply rephrase the previous output. Address the specific issues identified and ensure your response aligns with the research goal.');

      const historyEntry: RegenerateHistoryEntry = {
        attempt: sessionState.regenerateAttempts + 1,
        timestamp: Date.now(),
        deviationScore: pfr.deviationScore,
        originalOutputPreview: pfr.originalOutputPreview,
        correctionInstruction: pfr.correctionInstruction,
        result: 'regenerating',
      };
      sessionState.regenerateHistory.push(historyEntry);
      sessionState.regenerateAttempts++;
      sessionState.pendingForceRegenerate = undefined;
    }

    if (lines.length === 0) return {};

    return { prependContext: lines.join('\n') };
  }

  /**
   * Build a human-readable summary of all regeneration attempts in this session.
   * Called at session_end for audit logging.
   */
  buildRegenerationSummary(sessionState: SessionState): string {
    if (sessionState.regenerateHistory.length === 0) return '';

    const lines: string[] = [];
    lines.push('📋 [Supervisor] Regeneration Summary');
    lines.push(`Total regeneration attempts: ${sessionState.regenerateAttempts}`);
    lines.push('');

    for (const entry of sessionState.regenerateHistory) {
      const status = entry.result === 'max_reached' ? '❌ Max reached' :
                     entry.result === 'corrected' ? '✅ Corrected' :
                     '🔄 Regenerating';
      lines.push(`  Attempt ${entry.attempt}: deviation=${entry.deviationScore.toFixed(2)} — ${status}`);
      if (entry.originalOutputPreview) {
        lines.push(`    Output preview: ${entry.originalOutputPreview.slice(0, 100)}...`);
      }
    }

    const lastEntry = sessionState.regenerateHistory[sessionState.regenerateHistory.length - 1];
    if (lastEntry) {
      if (lastEntry.result === 'max_reached') {
        lines.push('');
        lines.push('⚠️ Maximum regeneration attempts reached. The output may still deviate from the research goal.');
      } else if (lastEntry.result === 'corrected') {
        lines.push('');
        lines.push('✅ Output was successfully corrected after regeneration.');
      }
    }

    return lines.join('\n');
  }
}
