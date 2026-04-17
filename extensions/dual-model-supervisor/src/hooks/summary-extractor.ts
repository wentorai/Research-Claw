/**
 * Dual Model Supervisor — Summary Extractor (llm_output hook)
 *
 * Extracts structured summaries from the main model's output,
 * replacing the naive 500-character truncation approach.
 */

import type { MessageSummary, SupervisorConfig, PluginLogger, SessionState } from '../core/types.js';
import { ReviewerClient } from '../client/reviewer.js';
import { AuditLogService } from '../core/audit-log.js';
import { SUMMARY_EXTRACTION_SYSTEM_PROMPT } from '../core/prompts.js';
import { isSupervisorActive } from '../core/config.js';

const MAX_STORED_SUMMARIES = 10;

export class SummaryExtractor {
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

  extractSummary(
    output: string,
    sessionId: string,
    sessionState: SessionState,
  ): void {
    if (!isSupervisorActive(this.config)) return;

    this._doExtract(output, sessionId, sessionState).catch((err) => {
      this.logger.error(`Summary extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private async _doExtract(
    output: string,
    sessionId: string,
    sessionState: SessionState,
  ): Promise<void> {
    try {
      const result = await this.reviewerClient.review<MessageSummary>(
        SUMMARY_EXTRACTION_SYSTEM_PROMPT,
        output,
      );

      if (!result) {
        this._storeFallbackSummary(output, sessionState);
        return;
      }

      // Backfill new fields for reviewer models that return the old schema
      const enriched: MessageSummary = {
        claims: result.claims ?? [],
        decisions: result.decisions ?? [],
        references: result.references ?? [],
        conditions: result.conditions ?? [],
        reasoning: result.reasoning ?? [],
        limitations: result.limitations ?? [],
        negations: result.negations ?? [],
        nextSteps: result.nextSteps ?? [],
      };

      sessionState.recentSummaries.push(enriched);
      if (sessionState.recentSummaries.length > MAX_STORED_SUMMARIES) {
        sessionState.recentSummaries = sessionState.recentSummaries.slice(-MAX_STORED_SUMMARIES);
      }

      sessionState.recentOutputs.push(output.slice(0, 500));
      if (sessionState.recentOutputs.length > MAX_STORED_SUMMARIES) {
        sessionState.recentOutputs = sessionState.recentOutputs.slice(-MAX_STORED_SUMMARIES);
      }

      if (enriched.decisions.length > 0) {
        for (const decision of enriched.decisions) {
          if (!sessionState.keyConclusions.includes(decision)) {
            sessionState.keyConclusions.push(decision);
          }
        }
        if (sessionState.keyConclusions.length > 20) {
          sessionState.keyConclusions = sessionState.keyConclusions.slice(-20);
        }
      }

      this.auditLog.record({
        sessionId,
        type: 'output_review',
        action: 'info',
        details: `summary_extracted: claims=${enriched.claims.length}, decisions=${enriched.decisions.length}, refs=${enriched.references.length}, conditions=${enriched.conditions.length}, reasoning=${enriched.reasoning.length}, limitations=${enriched.limitations.length}, negations=${enriched.negations.length}, nextSteps=${enriched.nextSteps.length}`,
        timestamp: Date.now(),
      });
    } catch (err) {
      this.logger.error(`Summary extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      this._storeFallbackSummary(output, sessionState);

      this.auditLog.record({
        sessionId,
        type: 'output_review',
        action: 'warn',
        details: `summary_extraction_failed: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      });
    }
  }

  /** Store a minimal fallback summary (first 300 chars as a single claim) when reviewer is unavailable. */
  private _storeFallbackSummary(output: string, sessionState: SessionState): void {
    const fallbackSummary: MessageSummary = {
      claims: [output.slice(0, 300)],
      decisions: [],
      references: [],
      conditions: [],
      reasoning: [],
      limitations: [],
      negations: [],
      nextSteps: [],
    };
    sessionState.recentSummaries.push(fallbackSummary);
    if (sessionState.recentSummaries.length > MAX_STORED_SUMMARIES) {
      sessionState.recentSummaries = sessionState.recentSummaries.slice(-MAX_STORED_SUMMARIES);
    }

    sessionState.recentOutputs.push(output.slice(0, 500));
    if (sessionState.recentOutputs.length > MAX_STORED_SUMMARIES) {
      sessionState.recentOutputs = sessionState.recentOutputs.slice(-MAX_STORED_SUMMARIES);
    }
  }
}
