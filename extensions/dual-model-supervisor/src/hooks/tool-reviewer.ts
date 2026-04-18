/**
 * Dual Model Supervisor — Tool Call Reviewer (before_tool_call hook)
 */

import type { ToolReviewResult, SupervisorConfig, PluginLogger } from '../core/types.js';
import { ReviewerClient } from '../client/reviewer.js';
import { QuickChecker } from './quick-checker.js';
import { AuditLogService } from '../core/audit-log.js';
import { TOOL_REVIEW_SYSTEM_PROMPT } from '../core/prompts.js';
import { validateToolReviewResult } from '../core/validators.js';

export class ToolReviewer {
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

  /** Hot-reload updated config; also propagates to the nested QuickChecker. */
  updateConfig(config: SupervisorConfig): void {
    this.config = config;
    this.quickChecker.updateConfig(config);
  }

  /**
   * Review a tool call before execution.
   * First runs quick-check rules (dangerous commands, system path writes),
   * then sends high-risk tool calls to the reviewer model for deep assessment.
   * Returns block decision, optional block reason, and optional corrected parameters.
   */
  async review(
    tool: string,
    params: Record<string, unknown>,
    sessionId: string,
  ): Promise<{ block: boolean; blockReason?: string; params?: Record<string, unknown> }> {
    if (!this.config.enabled || this.config.reviewMode === 'off') {
      return { block: false };
    }

    const quickResult = this.quickChecker.checkToolCall(tool, params);

    if (quickResult.blocked) {
      this.logger.warn(`[ToolReviewer] Tool ${tool} blocked by quick check: ${quickResult.blockReason}`);
      this.auditLog.record({
        sessionId,
        type: 'tool_review',
        action: 'block',
        details: `Tool ${tool} blocked: ${quickResult.blockReason}`,
        timestamp: Date.now(),
      });
      return { block: true, blockReason: quickResult.blockReason };
    }

    const isHighRisk = this.config.highRiskTools.includes(tool);

    if (!isHighRisk) {
      return { block: false };
    }

    const userContent = `<user_content>\n## Tool Call\nTool: ${tool}\nParameters: ${JSON.stringify(params, null, 2)}\n</user_content>`;
    const raw = await this.reviewerClient.review<Record<string, unknown>>(
      TOOL_REVIEW_SYSTEM_PROMPT,
      userContent,
    );
    const result = validateToolReviewResult(raw, Object.keys(params));

    if (!result) {
      this.logger.warn(`Tool reviewer unavailable for ${tool}, passing through`);
      return { block: false };
    }

    if (result.blocked) {
      this.logger.warn(`[ToolReviewer] Tool ${tool} blocked by deep review: ${result.blockReason}`);
      this.auditLog.record({
        sessionId,
        type: 'tool_review',
        action: 'block',
        details: `Tool ${tool} blocked: ${result.blockReason ?? 'Deep review block'}`,
        metadata: JSON.stringify(result),
        timestamp: Date.now(),
      });
      return { block: true, blockReason: result.blockReason };
    }

    if (result.correctedParams) {
      this.auditLog.record({
        sessionId,
        type: 'tool_review',
        action: 'correct',
        details: `Tool ${tool} parameters corrected`,
        metadata: JSON.stringify(result),
        timestamp: Date.now(),
      });
      return { block: false, params: result.correctedParams };
    }

    if (result.warnings.length > 0) {
      this.auditLog.record({
        sessionId,
        type: 'tool_review',
        action: 'warn',
        details: `Tool ${tool} warnings: ${result.warnings.join('; ')}`,
        timestamp: Date.now(),
      });
    }

    return { block: false };
  }
}
