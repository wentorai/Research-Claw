/**
 * Dual Model Supervisor — Goal Parser (message_received hook)
 */

import type { TaskParsingResult, SupervisorConfig, PluginLogger, SessionState } from '../core/types.js';
import { ReviewerClient } from '../client/reviewer.js';
import { AuditLogService } from '../core/audit-log.js';
import { TASK_PARSING_SYSTEM_PROMPT } from '../core/prompts.js';
import { isSupervisorActive } from '../core/config.js';

export class GoalParser {
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

  parseGoal(
    userMessage: string,
    sessionId: string,
    sessionState: SessionState,
  ): void {
    if (!isSupervisorActive(this.config)) return;

    this._doParse(userMessage, sessionId, sessionState).catch((err) => {
      this.logger.error(`Goal parsing failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Internal: call reviewer model to extract structured research intent, with fallback. */
  private async _doParse(
    userMessage: string,
    sessionId: string,
    sessionState: SessionState,
  ): Promise<void> {
    try {
      const result = await this.reviewerClient.review<TaskParsingResult>(
        TASK_PARSING_SYSTEM_PROMPT,
        userMessage,
      );

      if (!result || !result.researchGoal) {
        this.logger.warn('[GoalParser] Reviewer returned no result, using fallback truncation');
        if (userMessage.length > 10) {
          sessionState.researchGoal = userMessage.slice(0, 200);
          sessionState.goalConfirmed = false;
        }
        return;
      }

      sessionState.researchGoal = result.researchGoal;
      sessionState.goalConfirmed = true;

      if (result.targetConclusions && result.targetConclusions.length > 0) {
        sessionState.targetConclusions = result.targetConclusions;
      }

      if (result.methodology) {
        sessionState.methodology = result.methodology;
      }

      this.auditLog.record({
        sessionId,
        type: 'course_correction',
        action: 'info',
        details: `Research goal parsed: ${result.researchGoal.slice(0, 100)}`,
        metadata: JSON.stringify(result),
        timestamp: Date.now(),
      });
    } catch (err) {
      this.logger.error(`Goal parsing failed: ${err instanceof Error ? err.message : String(err)}`);
      if (userMessage.length > 10) {
        sessionState.researchGoal = userMessage.slice(0, 200);
        sessionState.goalConfirmed = false;
      }
    }
  }
}
