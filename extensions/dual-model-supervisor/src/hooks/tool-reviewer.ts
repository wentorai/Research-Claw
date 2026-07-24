/**
 * Dual Model Supervisor — Tool Call Reviewer (before_tool_call hook)
 */

import type { ToolReviewResult, SupervisorConfig, PluginLogger } from '../core/types.js';
import type { PluginHookBeforeToolCallResult, PluginApprovalResolution } from '../oc/hook-types.js';
import { ReviewerClient } from '../client/reviewer.js';
import { QuickChecker } from './quick-checker.js';
import { AuditLogService } from '../core/audit-log.js';
import { TOOL_REVIEW_SYSTEM_PROMPT } from '../core/prompts.js';
import { validateToolReviewResult } from '../core/validators.js';

/** OC's requireApproval descriptor (the shape before_tool_call returns). */
type RequireApproval = NonNullable<PluginHookBeforeToolCallResult['requireApproval']>;

/** The tool gate's decision: block, allow, correct params, or request approval. */
export interface ToolGateDecision {
  block: boolean;
  blockReason?: string;
  params?: Record<string, unknown>;
  requireApproval?: RequireApproval;
}

export class ToolReviewer {
  private config: SupervisorConfig;
  private logger: PluginLogger;
  private reviewerClient: ReviewerClient;
  private quickChecker: QuickChecker;
  private auditLog: AuditLogService;
  /** Monotonic per-process approval id source (stable, non-colliding, not time-based). */
  private approvalSeq = 0;
  /** Approval ids that have already reached a terminal state (idempotent resolution). */
  private readonly resolvedApprovals = new Set<string>();

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
  ): Promise<ToolGateDecision> {
    if (!this.config.enabled || this.config.reviewMode === 'off') {
      return { block: false };
    }

    const quickResult = this.quickChecker.checkToolCall(tool, params);

    if (quickResult.blocked) {
      // Confirmed danger (deterministic quick check). Under 'approve' this becomes
      // a human-in-the-loop approval; under 'block' it hard-blocks. Either way it
      // is NEVER silently allowed.
      return this.blockOrApprove(tool, quickResult.blockReason ?? 'Quick check flagged this tool call', sessionId);
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

    // Distinguish "reviewer unavailable" (null raw: timeout/network/no adapter)
    // from "reviewer responded but the body is malformed" (schema_invalid). Both
    // fail OPEN for a high-risk-but-not-determined-danger tool (determined danger
    // is already blocked by the quick check above), but each is recorded as an
    // OBSERVABLE degrade — never as a pass. A malformed body must NOT be coerced
    // into a silent "not blocked".
    if (raw === null) {
      this.auditLog.record({
        sessionId,
        type: 'tool_review',
        action: 'warn',
        details: `Tool ${tool} deep review degraded: reviewer unavailable (timeout/network) — failed open`,
        timestamp: Date.now(),
      });
      return { block: false };
    }

    const result = validateToolReviewResult(raw, Object.keys(params));

    if (!result) {
      this.auditLog.record({
        sessionId,
        type: 'tool_review',
        action: 'warn',
        // Do NOT log the raw reviewer body (may echo tool params) — privacy.
        details: `Tool ${tool} deep review degraded: reviewer response schema_invalid — failed open`,
        timestamp: Date.now(),
      });
      return { block: false };
    }

    if (result.blocked) {
      return this.blockOrApprove(tool, result.blockReason ?? 'Deep review flagged this tool call', sessionId);
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

  /**
   * Decide what to do with a confirmed-dangerous tool call per dangerousToolPolicy.
   *  - 'block'  : hard block + a `block` audit (default; unchanged behavior).
   *  - 'approve': hand OC a `requireApproval` and record ONLY a `requested` audit
   *               (action 'info' — never a block/denied before the user decides).
   */
  private blockOrApprove(tool: string, reason: string, sessionId: string): ToolGateDecision {
    if (this.config.dangerousToolPolicy !== 'approve') {
      this.logger.warn(`[ToolReviewer] Tool ${tool} blocked: ${reason}`);
      this.auditLog.record({
        sessionId,
        type: 'tool_review',
        action: 'block',
        details: `Tool ${tool} blocked: ${reason}`,
        timestamp: Date.now(),
      });
      return { block: true, blockReason: reason };
    }

    const approvalId = `approval-${++this.approvalSeq}`;
    // Pre-resolution: pending/requested only. MUST NOT be a block/denied here.
    this.auditLog.record({
      sessionId,
      type: 'approval',
      action: 'info',
      details: `requested: ${tool} — ${reason}`,
      metadata: JSON.stringify({ approvalId, tool, state: 'requested' }),
      timestamp: Date.now(),
    });

    const requireApproval: RequireApproval = {
      title: `Approve dangerous tool: ${tool}`,
      description: reason,
      severity: 'critical',
      allowedDecisions: ['allow-once', 'allow-always', 'deny'],
      timeoutBehavior: 'deny',
      onResolution: (decision) => this.resolveApproval(approvalId, tool, sessionId, decision),
    };
    return { block: false, requireApproval };
  }

  /**
   * Terminal transition for an approval. Idempotent: the FIRST resolution wins and
   * writes exactly one terminal audit; later/duplicate/conflicting resolutions are
   * ignored (state machine: requested → one terminal only). Errors are contained
   * (never thrown back to the tool host) but observable via the logger.
   */
  private resolveApproval(approvalId: string, tool: string, sessionId: string, decision: PluginApprovalResolution): void {
    try {
      if (this.resolvedApprovals.has(approvalId)) {
        this.logger.warn(`[ToolReviewer] duplicate approval resolution ignored (${approvalId}: ${decision})`);
        return;
      }
      this.resolvedApprovals.add(approvalId);

      const terminal: Record<PluginApprovalResolution, { action: 'info' | 'block' | 'warn'; label: string }> = {
        'allow-once': { action: 'info', label: 'allowed:allow-once' },
        'allow-always': { action: 'info', label: 'allowed:allow-always' },
        deny: { action: 'block', label: 'denied' },
        timeout: { action: 'warn', label: 'timeout' },
        cancelled: { action: 'warn', label: 'cancelled' },
      };
      const t = terminal[decision] ?? { action: 'warn' as const, label: `unknown:${decision}` };
      this.auditLog.record({
        sessionId,
        type: 'approval',
        action: t.action,
        details: `${t.label}: ${tool}`,
        metadata: JSON.stringify({ approvalId, tool, decision, state: 'resolved' }),
        timestamp: Date.now(),
      });
    } catch (err) {
      this.logger.error(`[ToolReviewer] approval resolution error (${approvalId}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
