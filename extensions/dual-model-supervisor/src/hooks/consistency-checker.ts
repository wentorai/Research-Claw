/**
 * Dual Model Supervisor — Consistency Checker (llm_input hook)
 *
 * Checks conversation consistency before sending to the main LLM.
 * Can inject corrective system messages when inconsistencies are detected.
 */

import type { ConsistencyCheckResult, SupervisorConfig, PluginLogger, SessionState } from '../core/types.js';
import { ReviewerClient } from '../client/reviewer.js';
import { AuditLogService } from '../core/audit-log.js';
import { CONSISTENCY_CHECK_SYSTEM_PROMPT, TARGET_CONCLUSION_CHECK_PROMPT } from '../core/prompts.js';
import { isCourseCorrectionActive } from '../core/config.js';
import { messageContentToPlainText, truncateMessagePlainText } from '../utils/message-content.js';
import { buildSessionContextLines } from '../utils/session-context.js';
import { findMatchingSummary } from '../utils/summary-matcher.js';
import { validateConsistencyResult } from '../core/validators.js';

export class ConsistencyChecker {
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

  updateConfig(config: SupervisorConfig): void {
    this.config = config;
  }

  async checkConsistency(
    messages: Array<{ role: string; content: unknown }>,
    sessionId: string,
    sessionState: SessionState,
  ): Promise<{ messages?: Array<{ role: string; content: unknown }> }> {
    if (!isCourseCorrectionActive(this.config)) return {};

    try {
      const conversationText = this._buildConversationContext(messages, sessionState);
      const contextParts = buildSessionContextLines(sessionState);

      const messagesText = contextParts.length > 0
        ? `## Session Context\n${contextParts.join('\n')}\n\n## Recent Messages\n${conversationText}`
        : conversationText;
      const userContent = `<user_content>\n${messagesText}\n</user_content>`;

      const raw = await this.reviewerClient.review<Record<string, unknown>>(
        CONSISTENCY_CHECK_SYSTEM_PROMPT,
        userContent,
      );
      const result = validateConsistencyResult(raw);

      if (!result || !result.hasIssue) {
        await this._checkTargetConclusions(sessionId, sessionState);
        return {};
      }

      this.auditLog.record({
        sessionId,
        type: 'consistency_check',
        action: 'warn',
        details: result.details.join('; '),
        metadata: JSON.stringify(result),
        timestamp: Date.now(),
      });

      if (result.correction) {
        const lastUserIdx = messages.findLastIndex((m) => m.role === 'user');
        if (lastUserIdx >= 0) {
          const correctiveMessage = {
            role: 'system' as const,
            content: `[Supervisor Consistency Alert] ${result.correction}`,
          };

          const newMessages = [
            ...messages.slice(0, lastUserIdx),
            correctiveMessage,
            ...messages.slice(lastUserIdx),
          ];

          return { messages: newMessages };
        }
      }

      return {};
    } catch (err) {
      this.logger.error(`Consistency check failed: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  }

  /**
   * Build a human-readable conversation context string from recent messages.
   * When structured summaries are available, replaces raw assistant content
   * with compact summary (claims/decisions/refs) for more efficient reviewer prompts.
   */
  private _buildConversationContext(
    messages: Array<{ role: string; content: unknown }>,
    sessionState: SessionState,
  ): string {
    const recentMessages = messages.slice(-10);
    const summariesAvailable = sessionState.recentSummaries.length > 0;

    if (!summariesAvailable) {
      return recentMessages
        .map((m) => `[${m.role}]: ${truncateMessagePlainText(m.content, 500)}`)
        .join('\n\n');
    }

    const parts: string[] = [];
    const summaries = sessionState.recentSummaries;

    for (const msg of recentMessages) {
      if (msg.role === 'user') {
        parts.push(`[user]: ${truncateMessagePlainText(msg.content, 800)}`);
      } else if (msg.role === 'assistant') {
        const summary = findMatchingSummary(messageContentToPlainText(msg.content), summaries);
        if (summary) {
          const summaryParts: string[] = [];
          if (summary.claims.length > 0) summaryParts.push(`Claims: ${summary.claims.join('; ')}`);
          if (summary.decisions.length > 0) summaryParts.push(`Decisions: ${summary.decisions.join('; ')}`);
          if (summary.references.length > 0) summaryParts.push(`Refs: ${summary.references.join('; ')}`);
          if (summary.conditions.length > 0) summaryParts.push(`If: ${summary.conditions.join('; ')}`);
          if (summary.reasoning.length > 0) summaryParts.push(`Reasoning: ${summary.reasoning.join('; ')}`);
          if (summary.limitations.length > 0) summaryParts.push(`Limits: ${summary.limitations.join('; ')}`);
          if (summary.negations.length > 0) summaryParts.push(`Not: ${summary.negations.join('; ')}`);
          if (summary.nextSteps.length > 0) summaryParts.push(`Next: ${summary.nextSteps.join('; ')}`);
          parts.push(`[assistant]: ${summaryParts.join(' | ')}`);
        } else {
          parts.push(`[assistant]: ${truncateMessagePlainText(msg.content, 500)}`);
        }
      } else {
        parts.push(`[${msg.role}]: ${truncateMessagePlainText(msg.content, 300)}`);
      }
    }

    return parts.join('\n\n');
  }

  private async _checkTargetConclusions(
    sessionId: string,
    sessionState: SessionState,
  ): Promise<void> {
    if (sessionState.targetConclusions.length === 0) return;
    if (sessionState.recentSummaries.length === 0) return;

    try {
      const recentWorkSummary = sessionState.recentSummaries
        .slice(-5)
        .map((s) => {
          const parts: string[] = [];
          if (s.claims.length > 0) parts.push(`Claims: ${s.claims.join('; ')}`);
          if (s.decisions.length > 0) parts.push(`Decisions: ${s.decisions.join('; ')}`);
          if (s.conditions.length > 0) parts.push(`If: ${s.conditions.join('; ')}`);
          if (s.limitations.length > 0) parts.push(`Limits: ${s.limitations.join('; ')}`);
          if (s.negations.length > 0) parts.push(`Not: ${s.negations.join('; ')}`);
          if (s.nextSteps.length > 0) parts.push(`Next: ${s.nextSteps.join('; ')}`);
          return parts.join(' | ');
        })
        .join('\n');

      const contextParts: string[] = [];
      if (sessionState.researchGoal) {
        contextParts.push(`Research goal: ${sessionState.researchGoal}`);
      }
      contextParts.push(`Target conclusions: ${sessionState.targetConclusions.join('\n- ')}`);
      contextParts.push(`Recent work:\n${recentWorkSummary}`);

      const userContent = `<user_content>\n${contextParts.join('\n\n')}\n</user_content>`;

      const result = await this.reviewerClient.review<{
        progressAssessment: string;
        addressedTargets: string[];
        unaddressedTargets: string[];
        driftDetected: boolean;
        driftDetails: string;
        suggestedNewTargets: string[];
      }>(TARGET_CONCLUSION_CHECK_PROMPT, userContent);

      if (!result) return;

      this.auditLog.record({
        sessionId,
        type: 'consistency_check',
        action: result.driftDetected ? 'warn' : 'info',
        details: result.progressAssessment,
        metadata: JSON.stringify(result),
        timestamp: Date.now(),
      });

      if (result.driftDetected && result.driftDetails) {
        sessionState.pendingCourseCorrection =
          `Possible drift from target conclusions. ${result.driftDetails}. Unaddressed targets: ${result.unaddressedTargets.join('; ')}`;
      }

      if (result.suggestedNewTargets && result.suggestedNewTargets.length > 0) {
        for (const target of result.suggestedNewTargets) {
          if (!sessionState.targetConclusions.includes(target)) {
            sessionState.targetConclusions.push(target);
          }
        }
        if (sessionState.targetConclusions.length > 15) {
          sessionState.targetConclusions = sessionState.targetConclusions.slice(-15);
        }
      }
    } catch (err) {
      this.logger.error(`Target conclusion check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
